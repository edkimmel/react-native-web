/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `<StyleSheetAnchors>` on the client.
 *
 * It does NOT re-read the sheet here. Hydration compares an element's
 * `dangerouslySetInnerHTML` against the DOM, so the client has to reproduce
 * the server's text exactly, and the only thing guaranteed to equal the
 * server's text is the server's text — read back off the anchors themselves.
 *
 * The traps, both of which have been observed in a real browser:
 *
 *   1. RNW's sheet boots when the client bundle evaluates. On a streaming
 *      `<head>` that is BEFORE the server's anchors arrive, so RNW creates
 *      anchors of its own. Mirroring those back to React renders `<style>`
 *      elements the server never sent: duplicate keys, a hydration mismatch,
 *      and the whole document re-rendered on the client.
 *   2. A chunk that ran before any anchor existed left its rules queued. The
 *      component's commit is the moment they can be applied, and nothing
 *      else knows it has happened.
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import StyleSheetAnchors from '../StyleSheetAnchors';
// Imported AFTER the component on purpose — see the `StyleSheet.Anchors` test
// below.
import StyleSheet from '..';

const planAnchor = (group, text, runtime) => {
  const el = document.createElement('style');
  el.setAttribute('data-rnw-group', String(group));
  if (runtime) el.setAttribute('data-rnw-runtime', '');
  el.appendChild(document.createTextNode(text));
  document.head.appendChild(el);
  return el;
};

const rendered = (container) =>
  Array.from(container.querySelectorAll('style')).map((el) => [
    el.getAttribute('data-rnw-group'),
    el.innerHTML
  ]);

// Planting a `data-rnw-runtime` anchor and mounting the component is exactly
// the `<head>` shape `warnIfRuntimeAnchorsSkewHydration` exists to report, so
// two of the tests below make it fire for real. That warning is asserted in
// `StyleSheetAnchors-warning-test.js`, which resets the module registry per
// test so its once-latch cannot be decided by suite order; here it is only
// tolerated. Everything *else* written to `console.error` — a React key
// warning, a hydration mismatch — fails the test that logged it, so no new
// unasserted output can accumulate in this file either.
let consoleError;

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  const unexpected = consoleError.mock.calls.filter(
    (args) => !String(args[0]).includes('element(s) in <head> before')
  );
  consoleError.mockRestore();
  document.querySelectorAll('style').forEach((el) => el.remove());
  delete window.__RNW_DELTA__;
  delete window.__RNW_INGEST_DELTA__;
  expect(unexpected).toEqual([]);
});

test('is published as StyleSheet.Anchors', () => {
  // The two modules import each other, so the assignment in `../index.js`
  // could have read an unfinished module and left `StyleSheet.Anchors`
  // undefined. This file enters the component module FIRST (it is imported
  // above `..`), which is the direction that would break; the server test
  // covers the other order.
  expect(StyleSheet.Anchors).toBe(StyleSheetAnchors);
});

describe('StyleSheetAnchors on the client', () => {
  test('mirrors the anchors already in the document, ascending', () => {
    planAnchor(3, '.late{margin-top:4px}');
    planAnchor(0, '.first{margin:0}');
    const { container } = render(<StyleSheetAnchors />);
    expect(rendered(container)).toEqual([
      ['0', '.first{margin:0}'],
      ['3', '.late{margin-top:4px}']
    ]);
  });

  test('ignores anchors RNW created at runtime', () => {
    // Trap 1. The runtime anchor carries the same rules, but it is not what
    // the server sent, so it is not what React has to hydrate against.
    planAnchor(2, '.runtime{padding:1px}', true);
    planAnchor(2, '.server{padding:1px}');
    const { container } = render(<StyleSheetAnchors />);
    expect(rendered(container)).toEqual([['2', '.server{padding:1px}']]);
  });

  test('renders nothing when the document carries no shell', () => {
    // A client-only render. RNW's runtime creates the anchors it needs on
    // demand; there is no hydration, so nothing can skew.
    planAnchor(1, '.only-runtime{margin:0}', true);
    const { container } = render(<StyleSheetAnchors />);
    expect(rendered(container)).toEqual([]);
  });

  test('the snapshot is frozen, so a re-render never moves a head child', () => {
    // Start from the read that is NOT memoised. `readClientGroups` latches
    // only a non-empty result — an empty one is the client-only case, and
    // caching it would make that answer permanent for a page whose anchors
    // had merely not been reached yet — so on a client-only page every call
    // goes back to the DOM. `useState` is therefore the only thing standing
    // between this component and a `<head>` mutation on a routine update,
    // and this is the one arrangement in which that is true: with the latch
    // engaged the test below would pass with `useState` deleted.
    planAnchor(1, '.only-runtime{margin:0}', true);
    const { container, rerender } = render(<StyleSheetAnchors />);
    expect(rendered(container)).toEqual([]);

    // The server's anchors turn up after the first render — a late chunk, a
    // second document write, RNW's own runtime promoting a group. Re-reading
    // here would make React insert a `<head>` child mid-update.
    planAnchor(0, '.a{margin:0}');
    planAnchor(3, '.b{margin-top:1px}');
    rerender(<StyleSheetAnchors />);
    expect(rendered(container)).toEqual([]);

    // Vacuity guard: the anchors really are in the document and really do
    // match the selector, so an unfrozen read would have found both.
    expect(
      document.querySelectorAll(
        'style[data-rnw-group]:not([data-rnw-delta]):not([data-rnw-runtime])'
      ).length
    ).toBe(2);
  });

  test('a re-render does not move a head child once the read has latched', () => {
    // The same property on the latched path. This one cannot fail to a
    // missing `useState` — the module-level `clientGroups` cache already
    // memoises a non-empty read — but it is the arrangement a real
    // server-rendered page is in, so it is worth stating that both layers
    // agree rather than leaving the common case untested.
    planAnchor(0, '.a{margin:0}');
    const { container, rerender } = render(<StyleSheetAnchors />);
    planAnchor(3, '.b{margin-top:1px}');
    rerender(<StyleSheetAnchors />);
    expect(rendered(container)).toEqual([['0', '.a{margin:0}']]);
  });

  test('a second instance does not read the first instance back', () => {
    // The component's own output matches the selector it reads: a
    // `<style data-rnw-group>` that is neither a delta nor a runtime anchor
    // is indistinguishable from one the server sent, and the DOM does not
    // record which React tree put it there. So an instance whose `useState`
    // initializer runs while a previous instance's anchors are still
    // mounted — a concurrent transition, an offscreen pre-render, an
    // error-boundary reset, all of which render the replacement before
    // committing the removal — used to read 2N and render 2N, duplicate
    // keys and all.
    planAnchor(0, '.a{margin:0}');
    planAnchor(3, '.b{margin-top:1px}');

    const first = render(<StyleSheetAnchors />);
    const mirrored = [
      ['0', '.a{margin:0}'],
      ['3', '.b{margin-top:1px}']
    ];
    expect(rendered(first.container)).toEqual(mirrored);
    // Vacuity guard: the first instance's anchors really are in the document
    // and really do match the selector, so a re-read would find four.
    expect(
      document.querySelectorAll(
        'style[data-rnw-group]:not([data-rnw-delta]):not([data-rnw-runtime])'
      ).length
    ).toBe(4);

    const second = render(<StyleSheetAnchors />);
    expect(rendered(second.container)).toEqual(mirrored);
  });

  test('asks the delta queue to drain when it commits', () => {
    // Trap 2. A chunk whose anchor did not exist queued its rules rather
    // than creating a `<style>` React never rendered; this commit is the
    // signal that the anchor is there now.
    planAnchor(0, '');
    const calls = [];
    window.__RNW_INGEST_DELTA__ = () => calls.push('drain');
    act(() => {
      render(<StyleSheetAnchors />);
    });
    expect(calls).toEqual(['drain']);
  });
});
