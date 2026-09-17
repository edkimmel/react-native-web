/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Pins WHAT OPENS THE DELTA GATE when the app renders `<head>` through React
 * — the `prelude == null` arrangement, where the stylesheet anchors are
 * React's own markup and arrive whenever React gets to them.
 *
 * THE BUG THIS EXISTS FOR (adversarial review S1). The gate used to be
 * `StyleSheet.hasEmittedShell()` plus "at least one chunk has been
 * forwarded". `hasEmittedShell()` flips when `<StyleSheet.Anchors>`
 * *renders*, not when its bytes are written, and under Fizz those are
 * separate phases:
 *
 *     flushCompletedQueues(request, destination) {
 *       try {
 *         …
 *         for (…completedBoundaries…) {
 *           if (!flushCompletedBoundary(…)) { request.destination = null; return; }
 *         }                                  //  ^ backpressure: stop writing
 *       } finally {
 *         completeWriting(destination);
 *         flushBuffered(destination);        //  ← our flush() runs anyway
 *       }
 *     }
 *
 * So a pass that renders the anchors into a boundary queued *behind* a
 * boundary that tripped backpressure reaches our `flush()` with the shell
 * marked emitted and not one byte of the anchors on the wire. The delta
 * drained there is a `<script>` whose `querySelector` finds no anchor: its
 * rules queue as pending and need RNW's client runtime to apply them, where
 * the parser alone would have done it had they arrived after the anchors.
 *
 * A degradation, not a corruption — which is why it was the last one open.
 *
 * WHAT CLOSES IT. The transform scans the bytes it forwards for
 * `data-rnw-group="`, the same attribute the streamed chunk's own
 * `querySelector` uses, so the gate means literally "an anchor's bytes have
 * been through this transform". See trap 6 in the source.
 *
 * The first two tests drive the transform by hand, in Fizz's own shape (N
 * writes then `flush()`), because the *condition* S1 describes is a segment
 * React rendered and did not write — which is exactly a pass with no write
 * for it. The third reproduces the same thing through a real
 * `renderToPipeableStream` under induced backpressure, so the pass shape is
 * React's rather than the test's.
 */

import * as React from 'react';
import { Suspense } from 'react';
import { Writable } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';

import StyleSheet from '../../../exports/StyleSheet';
import View from '../../../exports/View';
import createStyleInjectionTransform from '..';
import { runInRequestScope } from '../../asyncContext';

// TRAP: the node jest config sets `fakeTimers.enableGlobally`, and Fizz
// schedules every flush pass with `setImmediate`.
jest.useRealTimers();
beforeEach(() => {
  jest.useRealTimers();
});

// TRAP: the compiled sheet is process-wide and dedups by declaration, so a
// value an earlier test already used produces no delta at all.
let seed = 13000;
const uniq = () => seed++;

/** The opening of a streamed chunk's self-removing inline script. */
const DELTA_SCRIPT = /<script(?: nonce="[^"]*")?>\(function\(\)\{var w=window/;
/** The attribute that makes a `<style>` a group anchor. */
const ANCHOR = 'data-rnw-group="';
/**
 * Written after the last `flush()` of every hand-driven run. It is what tells
 * "the delta was emitted at the flush" apart from "the gate never opened and
 * `_flush` emitted it at end of stream" — two outcomes that are otherwise
 * indistinguishable from the byte order alone, and only one of which is the
 * fix.
 */
const SENTINEL = '<!--end-of-passes-->';

/** A collecting sink that never applies backpressure. */
function freeSink(chunks) {
  return new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk);
      callback();
    }
  });
}

describe('createStyleInjectionTransform delta gate, hand-driven', () => {
  /**
   * Drive the exact pass sequence S1 describes and return the response.
   *
   * `writeAnchors` decides whether the pass that *renders* the anchors also
   * writes them. Passing false is the backpressure early-return: the segment
   * exists, React has rendered it, and `flushCompletedQueues` returned before
   * `flushCompletedBoundary` could put it on the wire — but the `finally`
   * still called us.
   */
  function drive({ writeAnchors }) {
    return runInRequestScope(
      () =>
        new Promise((resolve, reject) => {
          const chunks = [];
          const sink = freeSink(chunks);
          sink.on('error', reject);
          sink.on('finish', () =>
            resolve(Buffer.concat(chunks).toString('utf8'))
          );

          // No prelude: React owns `<head>`, so the anchors are its markup.
          const injector = createStyleInjectionTransform();
          injector.on('error', reject);
          injector.pipe(sink);

          // Pass 1 — the root segment. `<head>`'s boundary is still pending,
          // so this is a `<!--$?-->` placeholder and nothing else: bytes
          // exist, anchors do not.
          injector.write(Buffer.from('<!doctype html><html><head>', 'utf8'));
          injector.write(Buffer.from('<!--$?--><body><div id="root">', 'utf8'));
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();

          // The `<head>` boundary resolves. `<StyleSheet.Anchors>` renders —
          // which is what `hasEmittedShell()` observes — and a sibling in the
          // same boundary compiles a rule, so there is a delta to place.
          // (`takeShellHTML` is the same `takeShellGroups` call the component
          // makes, and produces the bytes React would write for it.)
          const anchors = StyleSheet.takeShellHTML();
          StyleSheet.create({ gated: { marginTop: uniq() } });

          // Pass 2 — a boundary ahead of the anchors' one trips backpressure,
          // so `flushCompletedQueues` returns before writing the anchors.
          injector.write(
            Buffer.from('<div hidden id="B:0">busy</div>', 'utf8')
          );
          if (writeAnchors) injector.write(Buffer.from(anchors, 'utf8'));
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();

          // Pass 3 — on drain, the anchors finally go out.
          if (!writeAnchors) injector.write(Buffer.from(anchors, 'utf8'));
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();

          // Markup after the last pass, so a delta that only came out of
          // `_flush` lands behind it and is visible as such.
          injector.write(Buffer.from(SENTINEL, 'utf8'));
          injector.end();
        })
    );
  }

  test('no delta is drained while the anchors are rendered but unwritten', async () => {
    const html = await drive({ writeAnchors: false });

    const anchorAt = html.indexOf(ANCHOR);
    const deltaAt = html.search(DELTA_SCRIPT);

    // Vacuity guards: both have to be in the response for the order to mean
    // anything.
    expect(anchorAt).toBeGreaterThan(-1);
    expect(deltaAt).toBeGreaterThan(-1);
    // The defect: the delta went out on the pass that skipped the anchors'
    // segment, so its rules land in a document that has no anchor yet.
    expect(deltaAt).toBeGreaterThan(anchorAt);
    // …and it is still a *streamed* delta: emitted at the flush that follows
    // the anchors, not held back to end of stream.
    expect(deltaAt).toBeLessThan(html.indexOf(SENTINEL));
  });

  test('a delta is drained on the pass that does write the anchors', async () => {
    // The other half, so the fix cannot be "never emit a delta". When the
    // anchors are on the wire the gate is open on that very pass — the
    // delta does not wait for the next one.
    const html = await drive({ writeAnchors: true });

    const anchorAt = html.indexOf(ANCHOR);
    const deltaAt = html.search(DELTA_SCRIPT);
    expect(anchorAt).toBeGreaterThan(-1);
    expect(deltaAt).toBeGreaterThan(anchorAt);
    expect(deltaAt).toBeLessThan(html.indexOf(SENTINEL));
    // Pass 3 wrote nothing, so the delta can only have come from pass 2.
    expect(html.indexOf('id="root"')).toBeLessThan(anchorAt);
  });

  test('a marker split across two writes is still found', async () => {
    // Fizz encodes into a fixed-size view and hands it over whenever it
    // fills, so the cut lands wherever the byte count puts it — inside
    // `data-rnw-group="` as readily as anywhere else. A scanner without a
    // carry-over would miss the anchors entirely and withhold every delta
    // until end of stream.
    const html = await runInRequestScope(
      () =>
        new Promise((resolve, reject) => {
          const chunks = [];
          const sink = freeSink(chunks);
          sink.on('error', reject);
          sink.on('finish', () =>
            resolve(Buffer.concat(chunks).toString('utf8'))
          );

          const injector = createStyleInjectionTransform();
          injector.on('error', reject);
          injector.pipe(sink);

          const anchors = StyleSheet.takeShellHTML();
          StyleSheet.create({ split: { marginTop: uniq() } });

          // One byte at a time: every possible split of the marker occurs.
          const bytes = Buffer.from(anchors, 'utf8');
          for (let at = 0; at < bytes.length; at++) {
            injector.write(bytes.subarray(at, at + 1));
          }
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();
          injector.write(Buffer.from(SENTINEL, 'utf8'));
          injector.end();
        })
    );

    expect(html.indexOf(ANCHOR)).toBeGreaterThan(-1);
    // The assertion that needs the sentinel: the delta was emitted at the
    // flush. A scanner without the carry-over never matches a marker that
    // was written one byte at a time, so its delta falls through to
    // `_flush` and lands *after* the sentinel — still in the right order
    // relative to the anchors, and still wrong.
    const deltaAt = html.search(DELTA_SCRIPT);
    expect(deltaAt).toBeGreaterThan(html.indexOf(ANCHOR));
    expect(deltaAt).toBeLessThan(html.indexOf(SENTINEL));
  });

  test('a marker split between two large chunks is still found', async () => {
    // The one-byte-at-a-time test above only ever exercises the carry with
    // chunks shorter than the carry itself. Fizz's real chunks are 2048 or
    // 4096 bytes, which takes the other branch: the carry is the tail of a
    // chunk far longer than it, and the marker has to be found in a join
    // window of carry + the head of the next chunk rather than by
    // concatenating the two chunks. Every offset the split can land on is
    // driven, because the window's size is the whole thing being pinned —
    // one byte too small and the widest split is missed.
    const CARRY_MAX = ANCHOR.length - 1;
    const filler = Buffer.alloc(8192, 0x61);

    const driveSplit = (gap) =>
      runInRequestScope(
        () =>
          new Promise((resolve, reject) => {
            const chunks = [];
            const sink = freeSink(chunks);
            sink.on('error', reject);
            let markersWritten = 0;
            sink.on('finish', () =>
              resolve({
                html: Buffer.concat(chunks).toString('utf8'),
                markersWritten
              })
            );

            const injector = createStyleInjectionTransform();
            injector.on('error', reject);
            injector.pipe(sink);

            // `takeShellHTML()` is what sets `hasEmittedShell()`, the other
            // half of the gate; only its first anchor is written, so the
            // markup carries exactly one marker and the split is the only
            // way to find it. (The delta `<script>` contains the literal
            // too, inside its own `querySelector`, which is why this counts
            // what was written rather than what came out.)
            const shell = StyleSheet.takeShellHTML();
            const oneAnchor = shell.slice(0, shell.indexOf('</style>') + 8);
            markersWritten = oneAnchor.split(ANCHOR).length - 1;
            StyleSheet.create({ [`bigSplit${gap}`]: { marginTop: uniq() } });

            const bytes = Buffer.from(oneAnchor, 'utf8');
            const at = bytes.indexOf(Buffer.from(ANCHOR, 'latin1')) + gap;
            injector.write(Buffer.concat([filler, bytes.subarray(0, at)]));
            injector.write(Buffer.concat([bytes.subarray(at), filler]));
            // $FlowFixMe - React's hook, deliberately not on the Transform type
            injector.flush();
            injector.write(Buffer.from(SENTINEL, 'utf8'));
            injector.end();
          })
      );

    const withheld = [];
    for (let gap = 1; gap <= CARRY_MAX; gap++) {
      const { html, markersWritten } = await driveSplit(gap);
      // Vacuity: the markup held exactly one marker, and the write above
      // cut it `gap` bytes in, so nothing but the carry can find it.
      expect(markersWritten).toBe(1);
      const deltaAt = html.search(DELTA_SCRIPT);
      // A delta after the sentinel is one that fell through to `_flush`,
      // i.e. the split defeated the scan.
      if (!(deltaAt > -1 && deltaAt < html.indexOf(SENTINEL))) {
        withheld.push(gap);
      }
    }
    expect(withheld).toEqual([]);
  }, 30000);

  test('a non-UTF-8 write withholds the delta, and never loses it', async () => {
    // The scan matches the ASCII marker against raw bytes, so a caller who
    // writes the head as UTF-16 puts `d\0a\0t\0a\0…` on the wire and the
    // gate never opens. React cannot do this — Fizz's Node writer encodes
    // with one module-level `TextEncoder`, which is UTF-8 only — so the
    // transform documents the constraint rather than paying to detect it on
    // React's hottest path (trap 6, A SECOND NARROWING).
    //
    // What must hold is that the degradation is the benign one. Withheld,
    // not lost: the rules still reach the page at end of stream, which is
    // the same place the no-anchor-in-this-stream caller gets them.
    const html = await runInRequestScope(
      () =>
        new Promise((resolve, reject) => {
          const chunks = [];
          const sink = freeSink(chunks);
          sink.on('error', reject);
          sink.on('finish', () =>
            resolve(Buffer.concat(chunks).toString('utf8'))
          );

          const injector = createStyleInjectionTransform();
          injector.on('error', reject);
          injector.pipe(sink);

          const anchors = StyleSheet.takeShellHTML();
          StyleSheet.create({ utf16: { marginTop: uniq() } });

          // Node decodes this before `_transform` sees it, and hands over a
          // Buffer with `encoding === 'buffer'` exactly as it does for a
          // UTF-8 write — the original encoding is not recoverable here.
          injector.write(anchors, 'utf16le');
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();
          injector.write(Buffer.from(SENTINEL, 'utf8'));
          injector.end();
        })
    );

    // Vacuity: the anchors really did go out, just not as bytes the scan
    // can read — so no ASCII marker is in the response ahead of the delta.
    expect(html).toContain('\u0000');
    const deltaAt = html.search(DELTA_SCRIPT);
    const sentinelAt = html.indexOf(SENTINEL);
    expect(sentinelAt).toBeGreaterThan(-1);
    expect(html.slice(0, sentinelAt)).not.toContain(ANCHOR);
    // Withheld to `_flush`…
    expect(deltaAt).toBeGreaterThan(sentinelAt);
    // …and still delivered. This is the half that must not regress if
    // anyone ever tightens the gate: end of stream is exempt precisely so
    // that a stream whose anchors the scan cannot see still gets its CSS.
    expect(deltaAt).toBeGreaterThan(-1);
  }, 30000);

  test('matching bytes alone do not open the gate before a shell exists', async () => {
    // The marker is a text match, so page content can contain it — a docs
    // page quoting RNW's own markup, most obviously, and the streamed
    // chunk's `querySelector` contains it too. It must not be able to drain
    // a delta on its own: before any shell is serialised the watermark has
    // never been reset, so that delta is the WHOLE cumulative sheet, sent
    // with no anchor to receive it and then sent again by the shell.
    // `hasEmittedShell()` is what rules it out, and it is still required
    // alongside the scan for exactly this reason.
    const html = await runInRequestScope(
      () =>
        new Promise((resolve, reject) => {
          const chunks = [];
          const sink = freeSink(chunks);
          sink.on('error', reject);
          sink.on('finish', () =>
            resolve(Buffer.concat(chunks).toString('utf8'))
          );

          const injector = createStyleInjectionTransform();
          injector.on('error', reject);
          injector.pipe(sink);

          StyleSheet.create({ lookalike: { marginTop: uniq() } });
          // Prose about the format, not an anchor. No shell is ever emitted.
          injector.write(
            Buffer.from(
              '<p>an anchor is <code>style data-rnw-group="0"</code></p>',
              'utf8'
            )
          );
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();
          injector.write(Buffer.from(SENTINEL, 'utf8'));
          injector.end();
        })
    );

    // Nothing was drained at the flush. The rules still reach the page —
    // end of stream is exempt from the gate, because nothing is coming
    // after it to carry them — so the delta is behind the sentinel.
    const deltaAt = html.search(DELTA_SCRIPT);
    expect(deltaAt).toBeGreaterThan(-1);
    expect(deltaAt).toBeGreaterThan(html.indexOf(SENTINEL));
  });

  test('multi-byte UTF-8 around the marker survives the scan', async () => {
    // The scan carries bytes across chunk boundaries. It must never decode
    // or re-encode one: that turns any multi-byte sequence straddling a cut
    // into U+FFFD. See trap 3.
    const text = 'é中文😀'.repeat(500);
    const html = await runInRequestScope(
      () =>
        new Promise((resolve, reject) => {
          const chunks = [];
          const sink = freeSink(chunks);
          sink.on('error', reject);
          sink.on('finish', () =>
            resolve(Buffer.concat(chunks).toString('utf8'))
          );

          const injector = createStyleInjectionTransform();
          injector.on('error', reject);
          injector.pipe(sink);

          const bytes = Buffer.from(`<p>${text}</p>`, 'utf8');
          // Cuts every 7 bytes, which is coprime with every sequence length
          // here, so plenty of them land mid-character.
          for (let at = 0; at < bytes.length; at += 7) {
            injector.write(bytes.subarray(at, at + 7));
          }
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();
          injector.end();
        })
    );

    expect(html).toContain(text);
    expect(html).not.toContain('�');
    // The gate stayed shut: no `<style>` anchor was forwarded, so nothing
    // opened it. (The end-of-stream delta is exempt from the gate and does
    // go out — and its own `querySelector` contains the marker text, which
    // is why this asserts on the element rather than on the attribute.)
    expect(html).not.toContain('<style');
  });
});

describe('createStyleInjectionTransform delta gate under real backpressure', () => {
  /**
   * Both boundaries throw the SAME promise, so Fizz pings both in one go and
   * `performWork` completes both before it flushes. That is what puts them
   * in `completedBoundaries` together, in tree order, which is the arrangement
   * S1 needs: the anchors' boundary queued behind one big enough to trip
   * backpressure on its way out.
   */
  function createGate(delay) {
    let done = false;
    let pending = null;
    return function useGate() {
      if (done) return;
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

  test('a boundary that renders the anchors behind a backpressured one', async () => {
    const marginTop = uniq();
    const gate = createGate(10);

    // Big enough that writing it fills the transform's writable buffer and
    // `destination.write()` returns false — which is what makes
    // `flushCompletedQueues` return before the next boundary in the queue.
    let heavy = '';
    for (let row = 0; row < 40000; row++) {
      heavy += `row ${row} `;
    }

    function Heavy() {
      gate();
      return <div>{heavy}</div>;
    }
    // Compiles its rule in its own render, which is strictly after
    // `<StyleSheet.Anchors>` took the shell — so it is a delta rule, not a
    // shell rule.
    function LateRule() {
      const compiled = StyleSheet.create({ gatedLate: { marginTop } });
      return <View style={compiled.gatedLate} />;
    }
    function HeadLate() {
      gate();
      return (
        <React.Fragment>
          <StyleSheet.Anchors />
          <LateRule />
        </React.Fragment>
      );
    }

    const result = await runInRequestScope(
      () =>
        new Promise((resolve, reject) => {
          const chunks = [];
          const parked = [];
          let backpressured = false;
          let finished = false;

          // highWaterMark 1 and a callback that is never called
          // synchronously: the readable side fills, `_transform` is parked,
          // and the transform starts refusing writes — which is the signal
          // React acts on.
          const sink = new Writable({
            highWaterMark: 1,
            write(chunk, encoding, callback) {
              chunks.push(chunk);
              parked.push(callback);
            }
          });
          sink.on('error', reject);
          sink.on('finish', () => {
            finished = true;
            resolve({
              backpressured,
              html: Buffer.concat(chunks).toString('utf8')
            });
          });

          const injector = createStyleInjectionTransform();
          injector.on('error', reject);
          const write = injector.write.bind(injector);
          // $FlowFixMe - test instrumentation
          injector.write = (...args) => {
            const accepted = write(...args);
            if (accepted === false) backpressured = true;
            return accepted;
          };

          const { pipe } = renderToPipeableStream(
            <div id="root">
              <Suspense fallback={null}>
                <Heavy />
              </Suspense>
              <Suspense fallback={null}>
                <HeadLate />
              </Suspense>
            </div>,
            {
              onError: reject,
              onShellError: reject,
              onShellReady() {
                injector.pipe(sink);
                pipe(injector);
              }
            }
          );

          // Nothing drains until well after the boundaries resolve, so the
          // pass that writes `Heavy` genuinely runs out of room. Then one
          // chunk per tick, so the parked state stays real rather than
          // becoming "everything was buffered anyway".
          const release = () => {
            if (finished) return;
            const next = parked.shift();
            if (next != null) next();
            setImmediate(release);
          };
          setTimeout(release, 60);
        })
    );

    const { backpressured, html } = result;
    if (process.env.RNW_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          anchorAt: html.indexOf(ANCHOR),
          backpressured,
          deltaAt: html.search(DELTA_SCRIPT),
          len: html.length
        })
      );
    }
    const anchorAt = html.indexOf(ANCHOR);
    const deltaAt = html.search(DELTA_SCRIPT);

    // Vacuity guards. Without all three the ordering assertion below can
    // pass for the wrong reason.
    expect(backpressured).toBe(true);
    expect(anchorAt).toBeGreaterThan(-1);
    expect(deltaAt).toBeGreaterThan(-1);

    expect(deltaAt).toBeGreaterThan(anchorAt);
  }, 30000);
});
