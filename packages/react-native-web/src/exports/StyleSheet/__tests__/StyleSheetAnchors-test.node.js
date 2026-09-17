/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `<StyleSheetAnchors>` on the server.
 *
 * The whole reason it exists is *when* it reads the sheet: during its own
 * render, rather than from a snapshot the caller took before the render
 * started. That is what makes it usable inside a Suspense boundary in
 * `<head>`, and it is also why the invariant has to be checked here — a
 * component that reads at an arbitrary point in the render is exactly the
 * thing that could leave a rule in neither the shell nor a delta, or in
 * both.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import StyleSheet from '..';
import StyleSheetAnchors from '../StyleSheetAnchors';
import { orderedGroups } from '../compiler';
import { runInRequestScope } from '../../../modules/asyncContext';

// The process-wide sheet dedups by selector, so every test needs distinct
// values or its "new" rule silently never reaches the delta.
let px = 700;
const uniq = () => px++;

const groupsIn = (html) =>
  Array.from(html.matchAll(/data-rnw-group="([^"]+)"/g)).map((m) => m[1]);

test('is published as StyleSheet.Anchors', () => {
  // This file enters `..` before the component module, the other half of the
  // circular-import check in StyleSheetAnchors-test.js.
  expect(StyleSheet.Anchors).toBe(StyleSheetAnchors);
});

describe('StyleSheetAnchors', () => {
  test('emits one anchor per group, ascending, empty groups included', () => {
    const html = runInRequestScope(() =>
      renderToStaticMarkup(<StyleSheetAnchors />)
    );
    // Every group the compiler can emit. The empty ones are the whole point:
    // they are what a later chunk writes into, and a chunk that finds no
    // anchor has to queue instead of applying.
    expect(groupsIn(html)).toEqual(orderedGroups.map(String));
  });

  test('reads the sheet at render time, not before it', () => {
    const value = uniq();
    function CompileThenAnchors() {
      // Stands in for anything that compiles CSS earlier in the same render
      // — a component above the anchors in `<head>`, or the boundary the
      // anchors themselves are inside. A caller who snapshotted before the
      // render could not have this rule.
      StyleSheet.create({ late: { marginTop: value } });
      return <StyleSheetAnchors />;
    }
    const html = runInRequestScope(() =>
      renderToStaticMarkup(<CompileThenAnchors />)
    );
    expect(html).toContain(`margin-top:${value}px`);
  });

  test('the rule it emitted does not also arrive as a delta', () => {
    // The "never both" half of the invariant: reading the sheet and moving
    // the request's delta watermark are one synchronous step, so nothing the
    // anchors carry can be re-sent.
    const value = uniq();
    const { html, delta } = runInRequestScope(() => {
      StyleSheet.create({ a: { marginTop: value } });
      const html = renderToStaticMarkup(<StyleSheetAnchors />);
      return { delta: StyleSheet.takeDeltaHTML(), html };
    });
    expect(html).toContain(`margin-top:${value}px`);
    expect(delta).toBe('');
  });

  test('a rule compiled after it renders does arrive as a delta', () => {
    // The "never neither" half.
    const value = uniq();
    const { html, delta } = runInRequestScope(() => {
      const html = renderToStaticMarkup(<StyleSheetAnchors />);
      StyleSheet.create({ b: { marginTop: value } });
      return { delta: StyleSheet.takeDeltaHTML(), html };
    });
    expect(html).not.toContain(`margin-top:${value}px`);
    expect(delta).toContain(`margin-top:${value}px`);
  });

  test('a second render in the same request re-emits identical bytes', () => {
    // Fizz discards and retries a boundary's segment when a sibling suspends
    // after this component already ran, so it can render more than once for
    // one response. The snapshot is cached per request so the retry emits
    // exactly what the first attempt did — otherwise the second attempt
    // would move the watermark past rules the first attempt's bytes carried,
    // and those rules would be in neither channel.
    const { first, second, delta } = runInRequestScope(() => {
      const first = renderToStaticMarkup(<StyleSheetAnchors />);
      StyleSheet.create({ c: { marginTop: uniq() } });
      const second = renderToStaticMarkup(<StyleSheetAnchors />);
      return { delta: StyleSheet.takeDeltaHTML(), first, second };
    });
    expect(second).toBe(first);
    // ...and the rule compiled in between is still owed to the client.
    expect(delta).not.toBe('');
  });

  test('outside a request scope it re-reads, because there is no delta channel', () => {
    const value = uniq();
    const first = renderToStaticMarkup(<StyleSheetAnchors />);
    StyleSheet.create({ d: { marginTop: value } });
    const second = renderToStaticMarkup(<StyleSheetAnchors />);
    expect(first).not.toContain(`margin-top:${value}px`);
    expect(second).toContain(`margin-top:${value}px`);
  });

  test('props are applied to every anchor', () => {
    const html = runInRequestScope(() =>
      renderToStaticMarkup(<StyleSheetAnchors nonce="n0nc3" />)
    );
    expect(html.match(/nonce="n0nc3"/g).length).toBe(orderedGroups.length);
  });

  test('an id prop is rejected rather than duplicated N times', () => {
    expect(() =>
      renderToStaticMarkup(<StyleSheetAnchors id="sheet" />)
    ).toThrow(/duplicate ids/);
  });

  test('two instances in one document warn, like every other double shell', () => {
    // The duplicate that happens by ACCIDENT. This is the only spelling of
    // the shell that composes, so a layout and a page can each render one,
    // or a shared `<Head>` can be mounted twice — and the request-scoped
    // snapshot cache used to short-circuit the guard before it ran, so this
    // was the one duplication path with no warning at all.
    //
    // A Fizz retry and a second instance both arrive at a cache hit;
    // `useId` is what separates them, because React derives it from the
    // component's position in the tree.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const html = runInRequestScope(() =>
        renderToStaticMarkup(
          <div>
            <StyleSheetAnchors />
            <StyleSheetAnchors />
          </div>
        )
      );
      // The damage is real and is reported: two of every anchor.
      expect(groupsIn(html)).toEqual([
        ...orderedGroups.map(String),
        ...orderedGroups.map(String)
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain(
        'serialised the stylesheet shell more than'
      );
    } finally {
      spy.mockRestore();
    }
  });

  test('a re-render of the same instance is not a second shell', () => {
    // The other half: the cache exists for Fizz retries, which re-render
    // the same component at the same position, and those must stay silent
    // AND byte-identical. `useId` agrees across a retry precisely because
    // React has to keep hydration ids stable across one.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { first, second } = runInRequestScope(() => ({
        first: renderToStaticMarkup(<StyleSheetAnchors />),
        second: renderToStaticMarkup(<StyleSheetAnchors />)
      }));
      expect(second).toBe(first);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('mixing it with another shell spelling still warns', () => {
    // Both go through `takeShellGroups()`, so the duplicate-shell guard is
    // unchanged: two shells in one document means two of every anchor, and a
    // delta whose rules go into the FIRST one then sits above the second
    // copy of every higher group.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      runInRequestScope(() => {
        renderToStaticMarkup(<StyleSheetAnchors />);
        StyleSheet.takeShellHTML();
      });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('serialised the stylesheet shell more than')
      );
    } finally {
      spy.mockRestore();
    }
  });

  test('resetRequestDelta counts as a shell too', () => {
    // The raw-text consumer: serialises the sheet into their own `<style>`
    // and moves the watermark by hand. They have emitted a shell just as
    // much as `takeShellHTML()` has, and the streaming transform's
    // "is there an anchor to write into yet?" check has to agree.
    runInRequestScope(() => {
      expect(StyleSheet.hasEmittedShell()).toBe(false);
      StyleSheet.resetRequestDelta();
      expect(StyleSheet.hasEmittedShell()).toBe(true);
    });
  });

  test('hasEmittedShell flips when it renders', () => {
    // What the streaming transform keys its "is there an anchor to write
    // into yet?" decision off. Both majors flush `<head>` with a pending
    // boundary placeholder rather than withholding it, so "React has written
    // bytes" is not the same question.
    runInRequestScope(() => {
      expect(StyleSheet.hasEmittedShell()).toBe(false);
      renderToStaticMarkup(<StyleSheetAnchors />);
      expect(StyleSheet.hasEmittedShell()).toBe(true);
    });
    // Per request, not per process.
    runInRequestScope(() => {
      expect(StyleSheet.hasEmittedShell()).toBe(false);
    });
  });
});
