/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Pins WHERE `createStyleInjectionTransform` puts its bytes when the stream
 * is under backpressure — the only condition under which the transform can
 * corrupt a response, and the one every other test in this directory misses.
 *
 * THE BUG THIS EXISTS FOR. A Transform has two sides. React's HTML arrives on
 * the writable one, through `write()`, and only reaches the readable one when
 * `_transform` runs. `stream.push()` writes to the readable side directly.
 * Node stops calling `_transform` the moment the readable buffer reaches
 * `readableHighWaterMark` — `Transform.prototype._write` parks the write
 * callback in `kCallback` — and from then on React's `write()` calls pile up
 * on the writable side untouched. An injection that `push()`es therefore
 * jumps the entire parked queue and lands *ahead* of markup React handed over
 * several views ago.
 *
 * That is not a reordering nuisance, it is corruption: Fizz writes one
 * fixed-size view at a time (2048 bytes on React 18, 4096 on 19) and those
 * views end mid-tag by construction — only the pass's final
 * `completeWriting()` write lands on an element boundary. A delta that
 * overtakes view k+1 is spliced into whatever tag view k stopped inside:
 *
 *     <div data-pa<script>(function(){var w=window…
 *
 * which a browser parses as a `<div>` whose attribute names are
 * `data-pa<script>`, `(function`, `w=window`, … The CSS never applies and the
 * markup after it is mangled.
 *
 * WHAT IT TAKES TO SEE IT, since two other harnesses in this directory look
 * like they cover this and do not:
 *
 *   - Several `write()` calls per flush pass. One write per pass cannot
 *     reproduce it: the single chunk is the pass, so nothing of the pass is
 *     left queued behind the injection.
 *   - A destination that actually backpressures. A `Writable` whose `write`
 *     calls its callback immediately never lets the readable buffer fill, so
 *     `_transform` is never parked and `push()` looks correct. The sink here
 *     parks every callback until the whole response has been driven.
 *
 * `index-test.node.js`'s "injection lands between React chunks, never inside
 * one" has the first and not the second: it counts injections against writes,
 * which a mid-tag splice passes just as happily as a clean one.
 *
 * Driven by hand rather than through `renderToPipeableStream` so the pass
 * structure is exact and the result is deterministic. The shape — N views per
 * pass, then `flush()` — is Fizz's own; see the `finally` of
 * `flushCompletedQueues`.
 */

import { Writable } from 'node:stream';

import StyleSheet from '../../../exports/StyleSheet';
import createStyleInjectionTransform from '..';
import { runInRequestScope } from '../../asyncContext';

// TRAP: the node jest config sets `fakeTimers.enableGlobally`, and the drain
// loop below runs on `setImmediate` — the same primitive Fizz schedules its
// flush passes with. Under fake timers the stream simply never progresses.
jest.useRealTimers();
beforeEach(() => {
  jest.useRealTimers();
});

let seed = 11000;
const uniq = () => seed++;

const PRELUDE = (shellCSS) =>
  `<!doctype html><html><head>${shellCSS}</head><body><div id="root">`;
const EPILOGUE = '</div></body></html>';

// React 19's Fizz view. The number is not load-bearing — any size that makes
// a pass span several writes and lands the cut inside a tag will do.
const VIEW_SIZE = 4096;
const PASSES = 24;
const ROWS = 200;

/** The opening of the delta chunk's self-removing inline script. */
const DELTA_SCRIPT = /<script(?: nonce="[^"]*")?>\(function\(\)\{var w=window/g;
const ROW_TAG = /<div data-pass="(\d+)" data-row="(\d+)">/g;

const matchAll = (pattern, text) => {
  const found = [];
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) != null) {
    found.push(match);
  }
  return found;
};

/**
 * Drive `PASSES` Fizz-shaped passes through the transform into a sink that
 * refuses to complete a single write until the whole response has been
 * produced, and resolve with the bytes that came out.
 */
function streamUnderBackpressure() {
  return runInRequestScope(
    () =>
      new Promise((resolve, reject) => {
        const chunks = [];
        const parked = [];
        let finished = false;

        // highWaterMark 1 plus a callback that is never called synchronously:
        // the transform's readable buffer fills, `_transform` is parked, and
        // everything written after that waits on the writable side.
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
          resolve(Buffer.concat(chunks).toString('utf8'));
        });

        const injector = createStyleInjectionTransform({
          epilogue: EPILOGUE,
          prelude: PRELUDE
        });
        injector.on('error', reject);
        injector.pipe(sink);

        for (let pass = 0; pass < PASSES; pass++) {
          // Stands in for a boundary resolving and compiling new CSS, so
          // every pass has a non-empty delta to place.
          StyleSheet.create({ [`bp${pass}`]: { marginTop: uniq() } });

          let html = '';
          for (let row = 0; row < ROWS; row++) {
            html += `<div data-pass="${pass}" data-row="${row}">row ${row}</div>`;
          }
          // Fizz hands over one view at a time; the cuts land mid-tag.
          for (let at = 0; at < html.length; at += VIEW_SIZE) {
            injector.write(Buffer.from(html.slice(at, at + VIEW_SIZE), 'utf8'));
          }
          // React's end-of-pass signal, after `completeWriting()`.
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();
        }
        injector.end();

        // Let the sink accept one chunk per tick, so the parked state above
        // is real rather than an artefact of everything being buffered.
        const release = () => {
          if (finished) return;
          const next = parked.shift();
          if (next != null) next();
          setImmediate(release);
        };
        setImmediate(release);
      })
  );
}

describe('createStyleInjectionTransform under backpressure', () => {
  let html;

  beforeAll(async () => {
    html = await streamUnderBackpressure();
  }, 30000);

  test('every delta lands on an element boundary, never inside a tag', () => {
    const deltas = matchAll(DELTA_SCRIPT, html);
    // Guard against a vacuous pass: there must be deltas to misplace.
    expect(deltas.length).toBeGreaterThan(PASSES / 2);

    const spliced = deltas
      .filter((match) => html[match.index - 1] !== '>')
      .map((match) => html.slice(match.index - 20, match.index + 40));
    expect(spliced).toEqual([]);
  });

  test('no delta overtakes markup React wrote before it', () => {
    // A pass's markup is contiguous: it was all written before the flush that
    // produced the pass's delta. So no delta may sit between a pass's first
    // row tag and its last.
    const rows = matchAll(ROW_TAG, html);
    const deltas = matchAll(DELTA_SCRIPT, html).map((match) => match.index);

    const spans = new Map();
    rows.forEach((match) => {
      const pass = match[1];
      const span = spans.get(pass);
      if (span == null) spans.set(pass, { from: match.index, to: match.index });
      else span.to = match.index;
    });

    const interleaved = [];
    spans.forEach((span, pass) => {
      deltas.forEach((at) => {
        if (at > span.from && at < span.to) {
          interleaved.push(`delta at ${at} inside pass ${pass}`);
        }
      });
    });
    expect(interleaved).toEqual([]);
  });

  test('no two deltas arrive back to back, with a pass of markup skipped', () => {
    // The ordering half of the same defect: once `_transform` is parked, the
    // deltas of passes k…k+n all run ahead of the markup of passes k…k+n, so
    // the response shows a run of deltas and then a run of markup.
    const tokens = matchAll(
      /<div data-pass="(\d+)" data-row="0">|<script(?: nonce="[^"]*")?>\(function\(\)\{var w=window/g,
      html
    ).map((match) => (match[1] != null ? `P${match[1]}` : 'D'));

    const runs = tokens.filter(
      (token, at) => token === 'D' && tokens[at + 1] === 'D'
    );
    expect(runs).toEqual([]);
  });

  test('the markup itself arrives complete and in order', () => {
    const rows = matchAll(ROW_TAG, html).map(
      (match) => `${match[1]}:${match[2]}`
    );
    const expected = [];
    for (let pass = 0; pass < PASSES; pass++) {
      for (let row = 0; row < ROWS; row++) expected.push(`${pass}:${row}`);
    }
    expect(rows).toEqual(expected);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.endsWith(EPILOGUE)).toBe(true);
  });
});

describe('createStyleInjectionTransform downstream bookkeeping', () => {
  test('repeated pipe/unpipe does not accumulate unpipe listeners', () => {
    const injector = createStyleInjectionTransform();
    const sink = new Writable({
      write(chunk, encoding, callback) {
        callback();
      }
    });

    // Node's own `pipe` adds and removes an `unpipe` listener of its own, so
    // a clean cycle leaves the destination at zero. The leak was one extra
    // listener per `pipe()` call that nothing ever took off — twelve cycles
    // is also where Node starts printing MaxListenersExceededWarning.
    for (let i = 0; i < 12; i++) {
      injector.pipe(sink);
      injector.unpipe(sink);
    }
    expect(sink.listenerCount('unpipe')).toBe(0);

    // And the bookkeeping still works after all that: a re-piped destination
    // is tracked again, so React's flush signal reaches it.
    const reached = [];
    // $FlowFixMe - stand in for compression middleware
    sink.flush = () => reached.push(1);
    injector.pipe(sink);
    // $FlowFixMe - React's hook, deliberately not on the Transform type
    injector.flush();
    expect(reached.length).toBe(1);

    injector.unpipe(sink);
    // $FlowFixMe - React's hook, deliberately not on the Transform type
    injector.flush();
    expect(reached.length).toBe(1);
    injector.destroy();
  });

  test('a downstream flush() that throws does not escape into React', () => {
    const console$error = console.error;
    console.error = jest.fn();
    try {
      const injector = createStyleInjectionTransform();
      const reached = [];
      const angry = new Writable({
        write(chunk, encoding, callback) {
          callback();
        }
      });
      // $FlowFixMe - stand in for compression middleware
      angry.flush = () => {
        throw new Error('boom from compression middleware');
      };
      const healthy = new Writable({
        write(chunk, encoding, callback) {
          callback();
        }
      });
      // $FlowFixMe - stand in for compression middleware
      healthy.flush = () => reached.push(1);

      injector.pipe(angry);
      injector.pipe(healthy);

      // React calls this from the `finally` of `flushCompletedQueues`; a
      // throw here aborts the render at an arbitrary point mid-response.
      expect(() => {
        // $FlowFixMe - React's hook, deliberately not on the Transform type
        injector.flush();
      }).not.toThrow();
      // And the destinations after the thrower still get their signal.
      expect(reached.length).toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('threw from its flush()'),
        expect.any(Error)
      );

      injector.destroy();
    } finally {
      console.error = console$error;
    }
  });
});
