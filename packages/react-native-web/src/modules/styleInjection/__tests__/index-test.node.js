/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * End-to-end tests for `createStyleInjectionTransform` against the real
 * `react-dom/server` Node streaming renderer, with real Suspense boundaries
 * that resolve on a timer.
 *
 * TRAP: the node jest config sets `fakeTimers.enableGlobally`, which fakes
 * `setImmediate` — the primitive Fizz schedules every flush pass with. Under
 * fake timers `renderToPipeableStream` simply never progresses and every
 * test here hangs. Real timers are mandatory.
 *
 * TRAP: the compiled stylesheet is process-wide and dedups by selector, so a
 * declaration any earlier test already inserted produces no delta at all.
 * Every test takes its values from `uniq()`.
 */

import * as React from 'react';
import { Suspense } from 'react';
import { Writable } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';
import { JSDOM } from 'jsdom';

import StyleSheet from '../../../exports/StyleSheet';
import Text from '../../../exports/Text';
import View from '../../../exports/View';
import createStyleInjectionTransform from '..';
import { runInRequestScope } from '../../asyncContext';

jest.useRealTimers();
beforeEach(() => {
  jest.useRealTimers();
});

let seed = 9000;
const uniq = () => seed++;

const PRELUDE = (shellCSS) =>
  `<!doctype html><html><head><meta charset="utf-8">${shellCSS}</head><body><div id="root">`;
const EPILOGUE = '</div></body></html>';

const defaultOptions = () => ({ epilogue: EPILOGUE, prelude: PRELUDE });

/**
 * A component that suspends on first render and resolves `delay` ms later.
 * `renderResolved` runs only after the boundary resolves, so anything it
 * compiles lands in a post-shell chunk — which is the whole point.
 */
function createSuspendingComponent(renderResolved, delay = 10) {
  let done = false;
  let pending = null;
  return function Suspending() {
    if (done) return renderResolved();
    if (pending == null) {
      pending = new Promise((resolve) => {
        setTimeout(() => {
          done = true;
          resolve();
        }, delay);
      });
    }
    throw pending;
  };
}

/** A `View` whose class is compiled at render time from `style`. */
function LateView({ children, style, testID }) {
  const compiled = StyleSheet.create({ late: style });
  return (
    <View dataSet={{ testid: testID }} style={compiled.late}>
      {children}
    </View>
  );
}

/**
 * Render `element` through the transform and resolve with the complete
 * response text. `writes` counts how many times React called `write()` on
 * the transform, which is how the chunk-boundary tests tell "one injection
 * per flush pass" apart from "one injection per write".
 */
function renderThroughTransform(element, options = defaultOptions()) {
  const stats = { writes: 0 };
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(chunk);
        callback();
      }
    });
    sink.on('finish', () => {
      resolve({ html: Buffer.concat(chunks).toString('utf8'), stats });
    });
    sink.on('error', reject);

    const injector = createStyleInjectionTransform(options);
    const write = injector.write.bind(injector);
    // $FlowFixMe - test instrumentation
    injector.write = (...args) => {
      stats.writes += 1;
      return write(...args);
    };

    const { pipe } = renderToPipeableStream(element, {
      onError: reject,
      onShellError: reject,
      onShellReady() {
        injector.pipe(sink);
        pipe(injector);
      }
    });
  });
}

const renderInScope = (element, options) =>
  runInRequestScope(() => renderThroughTransform(element, options));

const parse = (html) => new JSDOM(html, { runScripts: 'dangerously' });

const styleEls = (dom, selector) =>
  Array.prototype.slice.call(dom.window.document.querySelectorAll(selector));

/**
 * Every CSS rule the streamed chunks of `html` carried, and the number of
 * chunks that carried them.
 *
 * A chunk is now a single inline `<script>` whose rules travel as a JSON
 * payload — no `<style>` element to count or read, deliberately, because a
 * node the server adds and React did not render is what skews
 * `hydrateRoot(document, …)`. The payload sits in a known position in the
 * emitted script, so the tests read it out rather than reaching into the
 * CSSOM (where a rule's text has been through the browser's normaliser and
 * no longer matches what the compiler wrote).
 */
const PAYLOAD_PATTERN = /,p=(\[[\s\S]*?\]),i,j,b,/g;

const deltaChunks = (html) => {
  const chunks = [];
  PAYLOAD_PATTERN.lastIndex = 0;
  let match;
  while ((match = PAYLOAD_PATTERN.exec(html)) != null) {
    chunks.push(JSON.parse(match[1]));
  }
  return chunks;
};

const deltaCSS = (html) =>
  deltaChunks(html)
    .map((buckets) => buckets.map((bucket) => bucket.r.join('\n')).join('\n'))
    .join('\n');

describe('createStyleInjectionTransform', () => {
  test('the shell carries every group ascending, once, ahead of any body markup', async () => {
    const value = uniq();
    const style = StyleSheet.create({ a: { marginTop: value } });
    const { html } = await renderInScope(<View style={style.a} />);

    expect(html.startsWith('<!doctype html><html><head>')).toBe(true);
    expect(html.endsWith(EPILOGUE)).toBe(true);

    const dom = parse(html);
    const groups = styleEls(
      dom,
      'head style[data-rnw-group]:not([data-rnw-delta])'
    ).map((el) => Number(el.getAttribute('data-rnw-group')));
    expect(groups.length).toBeGreaterThan(0);
    expect(groups).toEqual(groups.slice().sort((a, b) => a - b));
    expect(new Set(groups).size).toBe(groups.length);

    // The shell is a prefix of the response: no <style data-rnw-group> may
    // appear after the first byte React wrote.
    const headEnd = html.indexOf('</head>');
    expect(html.indexOf('<div id="root">')).toBeGreaterThan(headEnd);
    expect(html.slice(0, headEnd)).toContain(`margin-top:${value}px`);
  });

  test("a late boundary's CSS arrives as a delta and leaves no node", async () => {
    const shellValue = uniq();
    const lateValue = uniq();
    const shellStyle = StyleSheet.create({ s: { marginTop: shellValue } });
    const Late = createSuspendingComponent(() => (
      <LateView style={{ marginTop: lateValue }} testID="late">
        <Text>loaded</Text>
      </LateView>
    ));

    const { html } = await renderInScope(
      <View style={shellStyle.s}>
        <Suspense fallback={<View />}>
          <Late />
        </Suspense>
      </View>
    );

    // The late rule cannot have been in the shell: it did not exist yet.
    const headEnd = html.indexOf('</head>');
    expect(html.slice(0, headEnd)).not.toContain(`margin-top:${lateValue}px`);

    expect(deltaChunks(html).length).toBeGreaterThan(0);
    expect(deltaCSS(html)).toContain(`margin-top:${lateValue}px`);

    // The chunk's script ran at parse time and put its rules into the
    // group-3 anchor's own sheet, then deleted itself. What is left is a
    // document with exactly the elements React rendered: no style element
    // in <body>, no orphaned script, nothing carrying data-rnw-delta.
    const dom = parse(html);
    const doc = dom.window.document;
    expect(doc.querySelectorAll('[data-rnw-delta]').length).toBe(0);
    expect(doc.body.querySelectorAll('style').length).toBe(0);
    const anchor = doc.querySelector('head style[data-rnw-group="3"]');
    expect(
      Array.prototype.slice
        .call(anchor.sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n')
    ).toContain(`margin-top: ${lateValue}px`);

    // The boundary's own markup survived intact.
    expect(dom.window.document.querySelector('[data-testid="late"]')).not.toBe(
      null
    );
  });

  test('one injection per flush pass, not one per write', async () => {
    // Far more than Fizz's 2048-byte view, so the boundary's flush pass is
    // spread across many write() calls, and the counts below can tell "once
    // per pass" apart from "once per write".
    //
    // That is all this test can tell apart. The sink here completes every
    // write immediately, so the transform's readable buffer never fills,
    // `_transform` is never parked, and the readable side is always the tail
    // of the stream — the one condition under which injecting with `push()`
    // is indistinguishable from injecting in order. WHERE the bytes land
    // when that is not true is pinned by `backpressure-ordering-test.node.js`,
    // and it is a separate defect from the one counted here.
    const rows = 400;
    const lateValue = uniq();
    const Late = createSuspendingComponent(() => (
      <LateView style={{ marginTop: lateValue }} testID="late">
        {Array.from({ length: rows }, (_, i) => (
          <Text dataSet={{ row: String(i) }} key={i}>
            {`row-${i}-payload-payload-payload`}
          </Text>
        ))}
      </LateView>
    ));

    const { html, stats } = await renderInScope(
      <Suspense fallback={<View />}>
        <Late />
      </Suspense>
    );

    const dom = parse(html);
    expect(dom.window.document.querySelectorAll('[data-row]').length).toBe(
      rows
    );
    for (let i = 0; i < rows; i++) {
      expect(
        dom.window.document.querySelector(`[data-row="${i}"]`).textContent
      ).toBe(`row-${i}-payload-payload-payload`);
    }

    // The decisive numbers: React wrote many chunks, and we injected once.
    expect(stats.writes).toBeGreaterThan(4);
    expect(deltaChunks(html).length).toBeLessThanOrEqual(2);
    expect(deltaChunks(html).length).toBeLessThan(stats.writes);
  });

  test('multi-byte UTF-8 spanning a chunk boundary is not corrupted', async () => {
    // 4000+ bytes of 3- and 4-byte sequences, guaranteed to straddle Fizz's
    // 2048-byte views. Anything that decodes a chunk to a string and
    // re-encodes it produces U+FFFD here.
    const unit = '日本語🌟テスト';
    const repeats = 300;
    const text = unit.repeat(repeats);
    const Late = createSuspendingComponent(() => (
      <LateView style={{ marginTop: uniq() }} testID="utf8">
        <Text>{text}</Text>
      </LateView>
    ));

    const { html } = await renderInScope(
      <Suspense fallback={<View />}>
        <Late />
      </Suspense>
    );

    expect(html).not.toContain('�');
    const dom = parse(html);
    expect(
      dom.window.document.querySelector('[data-testid="utf8"]').textContent
    ).toBe(text);
  });

  test('_flush emits the last delta before the epilogue', async () => {
    // Driven by hand rather than by React: this is specifically the rule
    // compiled after React's final flush signal, which only `_flush` can
    // still catch. Losing it would silently unstyle the newest boundary.
    const value = uniq();
    const html = await runInRequestScope(() => {
      const injector = createStyleInjectionTransform(defaultOptions());
      const chunks = [];
      injector.on('data', (chunk) => chunks.push(chunk));
      const done = new Promise((resolve) => injector.on('end', resolve));
      injector.write(Buffer.from('<span>body</span>', 'utf8'));
      StyleSheet.create({ f: { marginTop: value } });
      injector.end();
      return done.then(() => Buffer.concat(chunks).toString('utf8'));
    });

    const deltaAt = html.indexOf(`margin-top:${value}px`);
    expect(deltaAt).toBeGreaterThan(html.indexOf('<span>body</span>'));
    expect(deltaAt).toBeLessThan(html.indexOf(EPILOGUE));
    expect(html.endsWith(EPILOGUE)).toBe(true);
  });

  test('nonce reaches the shell and the chunk script', async () => {
    const lateValue = uniq();
    const Late = createSuspendingComponent(() => (
      <LateView style={{ marginTop: lateValue }} testID="nonced" />
    ));

    const { html } = await renderInScope(
      <Suspense fallback={<View />}>
        <Late />
      </Suspense>,
      { epilogue: EPILOGUE, nonce: 'n0nc3', prelude: PRELUDE }
    );

    expect(html.slice(0, html.indexOf('</head>'))).toContain('nonce="n0nc3"');
    expect(html).toContain('<script nonce="n0nc3">');
    // The chunk emits no element at all — not a `<style>`, and no longer a
    // synthesised anchor either — so the `<script>` above is the only thing
    // a CSP has to admit. A chunk whose anchor is missing queues its rules
    // for RNW's runtime instead of creating a node, so there is nothing
    // left for a nonce to be applied to.
    expect(html).not.toContain('setAttribute("nonce"');
    expect(html).not.toContain("createElement('style')");
  });

  test('concurrent requests each receive their own late rules', async () => {
    // The failure this guards is not "request B sees request A's rules" —
    // the delta is derived from a sheet revision log and may legitimately
    // carry a neighbour's rules, which is harmless because the client
    // dedups. The failure is the opposite and it is fatal: with a shared
    // watermark whichever request drains first consumes the rules, and the
    // other renders its boundary unstyled.
    const a = uniq();
    const b = uniq();

    const LateA = createSuspendingComponent(
      () => <LateView style={{ marginTop: a }} testID="a" />,
      10
    );
    const LateB = createSuspendingComponent(
      () => <LateView style={{ marginTop: b }} testID="b" />,
      20
    );

    const [resA, resB] = await Promise.all([
      renderInScope(
        <Suspense fallback={<View />}>
          <LateA />
        </Suspense>
      ),
      renderInScope(
        <Suspense fallback={<View />}>
          <LateB />
        </Suspense>
      )
    ]);

    expect(deltaCSS(resA.html)).toContain(`margin-top:${a}px`);
    expect(deltaCSS(resB.html)).toContain(`margin-top:${b}px`);

    // And the design itself, which the two assertions above do not pin: the
    // delta is derived from the sheet's revision log, not from "which rules
    // did *I* insert". B took its shell before A resolved, so everything
    // recorded since — A's rule included — is past B's watermark and travels
    // in B's delta. That over-send is deliberate and the client dedups it.
    // An implementation that tracked authorship instead would pass every
    // other assertion here and still be the bug this design exists to avoid:
    // a lazily imported module runs `StyleSheet.create` once per process, so
    // for every request after the first, the rules its boundary needs were
    // inserted by somebody else's render.
    expect(deltaCSS(resB.html)).toContain(`margin-top:${a}px`);

    // Each response is a complete, independent document.
    [resA.html, resB.html].forEach((html) => {
      expect(html.split('<!doctype html>').length - 1).toBe(1);
      expect(html.endsWith(EPILOGUE)).toBe(true);
    });
  });

  test('a request that starts after another finished gets those rules in its shell, not as a delta', async () => {
    const first = uniq();
    const FirstLate = createSuspendingComponent(() => (
      <LateView style={{ marginTop: first }} testID="first" />
    ));
    await renderInScope(
      <Suspense fallback={<View />}>
        <FirstLate />
      </Suspense>
    );

    const { html } = await renderInScope(<View />);
    const headEnd = html.indexOf('</head>');
    // Already in the process sheet, so the fresh request's watermark starts
    // behind it and it belongs to the shell.
    expect(html.slice(0, headEnd)).toContain(`margin-top:${first}px`);
    expect(html.slice(headEnd)).not.toContain(`margin-top:${first}px`);
    expect(deltaChunks(html)).toEqual([]);
  });

  test('outside a request scope it degrades to shell plus pass-through', async () => {
    const console$error = console.error;
    console.error = jest.fn();
    try {
      const lateValue = uniq();
      const Late = createSuspendingComponent(() => (
        <LateView style={{ marginTop: lateValue }} testID="unscoped" />
      ));

      // No runInRequestScope: takeDeltaHTML() returns '' rather than
      // throwing, so the response is still a valid document.
      const { html } = await renderThroughTransform(
        <Suspense fallback={<View />}>
          <Late />
        </Suspense>
      );

      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html.endsWith(EPILOGUE)).toBe(true);
      expect(deltaChunks(html)).toEqual([]);
      expect(
        parse(html).window.document.querySelector('[data-testid="unscoped"]')
      ).not.toBe(null);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('runInRequestScope')
      );
    } finally {
      console.error = console$error;
    }
  });

  test('without a prelude the transform emits no shell and only deltas', async () => {
    const lateValue = uniq();
    const Late = createSuspendingComponent(() => (
      <LateView style={{ marginTop: lateValue }} testID="bare" />
    ));

    const { html } = await renderInScope(
      <Suspense fallback={<View />}>
        <Late />
      </Suspense>,
      {}
    );

    expect(html).not.toContain('<!doctype html>');
    expect(html).not.toMatch(/<style data-rnw-group="[^"]*">/);
    expect(deltaChunks(html).length).toBeGreaterThan(0);
  });

  test("React's end-of-pass flush is forwarded to the downstream sink", async () => {
    // React calls destination.flush() to let compression middleware push
    // bytes to the wire. Because the transform now owns that call, a gzip
    // stream after it would otherwise buffer the whole response and
    // streaming SSR would stop streaming.
    const flushes = [];
    const sink = new Writable({
      write(chunk, encoding, callback) {
        callback();
      }
    });
    // $FlowFixMe - stand in for compression middleware
    sink.flush = () => flushes.push(1);

    await runInRequestScope(
      () =>
        new Promise((resolve, reject) => {
          const injector = createStyleInjectionTransform(defaultOptions());
          sink.on('finish', resolve);
          injector.pipe(sink);
          const Late = createSuspendingComponent(() => (
            <LateView style={{ marginTop: uniq() }} testID="flushy" />
          ));
          const { pipe } = renderToPipeableStream(
            <Suspense fallback={<View />}>
              <Late />
            </Suspense>,
            {
              onError: reject,
              onShellError: reject,
              onShellReady() {
                pipe(injector);
              }
            }
          );
        })
    );

    expect(flushes.length).toBeGreaterThan(0);
  });
});
