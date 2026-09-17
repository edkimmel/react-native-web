/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Pins WHAT HAPPENS TO INJECTED BYTES THAT ARRIVE AFTER `end()` — trap 7 in
 * the source.
 *
 * React never puts them there. In `flushCompletedQueues`'s `finally`,
 * `flushBuffered(destination)` (our `flush()`) precedes `destination.end()`
 * in 18.3.1, 19.0.0, 19.1.1, 19.2.0 and 19.3.0. This is therefore about a
 * non-React caller, or a React that reorders — and about the `tail` fallback
 * that exists for it, which adversarial review #6 reported as a variable
 * nothing ever reads.
 *
 * It is read, but only in one of the two arrangements, and the difference is
 * whether `_flush` has already run:
 *
 *   a. The writable queue was still parked when `end()` was called. `end()`
 *      returns immediately with `writableEnded === true`, but `_flush`
 *      cannot run until the queue drains through `_transform` — so it is
 *      still to come, and it reads `tail`. The bytes are delivered.
 *
 *   b. The queue was empty. `end()` runs `_flush` synchronously, before it
 *      returns. Anything pushed after that has missed the last train and
 *      cannot be delivered by anything; the transform says so in
 *      development rather than assigning to a variable nobody reads.
 *
 * Both tests record the observed order of `_flush` against `end()` and
 * `flush()`, and assert on it, because that ordering is the whole reason the
 * two cases differ. Without it, "the delta is in the response" and "the
 * delta is missing" are just two facts with no mechanism attached.
 */

import { Writable } from 'node:stream';

import StyleSheet from '../../../exports/StyleSheet';
import createStyleInjectionTransform from '..';
import { runInRequestScope } from '../../asyncContext';

// TRAP: the node jest config sets `fakeTimers.enableGlobally`, and the drain
// loop below runs on `setImmediate`. Under fake timers the stream never
// progresses.
jest.useRealTimers();
beforeEach(() => {
  jest.useRealTimers();
});

// TRAP: the compiled sheet is process-wide and dedups by declaration, so a
// value an earlier test already used produces no delta at all.
let seed = 15000;
const uniq = () => seed++;

/** The opening of a streamed chunk's self-removing inline script. */
const DELTA_SCRIPT = /<script(?: nonce="[^"]*")?>\(function\(\)\{var w=window/g;
const EPILOGUE = '<!--epilogue-->';
const PRELUDE = (shellCSS) => `<!doctype html><head>${shellCSS}</head><body>`;

const countDeltas = (html) => (html.match(DELTA_SCRIPT) || []).length;

/**
 * Instrument `_flush` so the test can say *when* it ran relative to `end()`
 * and to the late `flush()`, rather than inferring it from the output.
 */
function recordFlushOrder(injector, order) {
  // eslint-disable-next-line no-underscore-dangle
  const real = injector._flush.bind(injector);
  // $FlowFixMe - test instrumentation
  // eslint-disable-next-line no-underscore-dangle
  injector._flush = (callback) => {
    order.push('_flush');
    return real(callback);
  };
}

describe('createStyleInjectionTransform, injection after end()', () => {
  let console$error;

  beforeEach(() => {
    console$error = console.error;
    console.error = jest.fn();
  });

  afterEach(() => {
    console.error = console$error;
  });

  test('a delta pushed after end() while the queue is parked is still delivered', async () => {
    const order = [];
    const state = {};

    const html = await runInRequestScope(
      () =>
        new Promise((resolve, reject) => {
          const chunks = [];
          const parked = [];
          let finished = false;

          // highWaterMark 1 and callbacks that are never called
          // synchronously: the transform's readable side fills,
          // `_transform` is parked, and everything after that waits on the
          // writable side — including, crucially, `_flush`.
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
          recordFlushOrder(injector, order);

          const body = Buffer.alloc(4096, 0x61);
          for (let at = 0; at < 200; at++) injector.write(body);

          injector.end();
          order.push('end');
          state.writableEndedAtEnd = injector.writableEnded;
          state.writableLengthAtEnd = injector.writableLength;

          // The late boundary: its rule is compiled after `end()`, and the
          // caller drains it with one more `flush()`.
          StyleSheet.create({ afterEndParked: { marginTop: uniq() } });
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();
          order.push('flush');

          const release = () => {
            if (finished) return;
            const next = parked.shift();
            if (next != null) next();
            setImmediate(release);
          };
          setImmediate(release);
        })
    );

    // The mechanism, asserted rather than assumed: `end()` closed the
    // writable side with bytes still queued behind it, so `_flush` had not
    // run yet when the late `flush()` arrived.
    expect(state.writableEndedAtEnd).toBe(true);
    expect(state.writableLengthAtEnd).toBeGreaterThan(0);
    expect(order).toEqual(['end', 'flush', '_flush']);

    // And therefore the bytes were delivered. Deleting `tail += html` from
    // `push()` takes this to 0.
    expect(countDeltas(html)).toBe(1);
    // In order: behind React's markup, ahead of the epilogue.
    const deltaAt = html.search(DELTA_SCRIPT);
    expect(deltaAt).toBeGreaterThan(html.lastIndexOf('aaaa'));
    expect(deltaAt).toBeLessThan(html.indexOf(EPILOGUE));
    // Nothing was lost, so nothing is reported.
    expect(console.error).not.toHaveBeenCalled();
  }, 30000);

  test('a delta pushed after _flush has run is reported, not silently dropped', async () => {
    const order = [];

    const html = await runInRequestScope(
      () =>
        new Promise((resolve, reject) => {
          const chunks = [];
          // A sink that never backpressures, so the queue is empty at
          // `end()` and `_flush` runs inside it.
          const sink = new Writable({
            write(chunk, encoding, callback) {
              chunks.push(chunk);
              callback();
            }
          });
          sink.on('error', reject);
          sink.on('finish', () =>
            resolve(Buffer.concat(chunks).toString('utf8'))
          );

          const injector = createStyleInjectionTransform({
            epilogue: EPILOGUE,
            prelude: PRELUDE
          });
          injector.on('error', reject);
          injector.pipe(sink);
          recordFlushOrder(injector, order);

          injector.write(Buffer.from('<p>body</p>', 'utf8'));
          injector.end();
          order.push('end');

          StyleSheet.create({ afterEndDrained: { marginTop: uniq() } });
          // $FlowFixMe - React's hook, deliberately not on the Transform type
          injector.flush();
          order.push('flush');
        })
    );

    // The mechanism: `_flush` ran inside `end()`, so the late `flush()` had
    // nothing left to hand its bytes to.
    expect(order).toEqual(['_flush', 'end', 'flush']);

    // The stream already ended with its own final delta, and the late one
    // could not join it. What must not happen is silence.
    expect(html.endsWith(EPILOGUE)).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('after its stream had already finished')
    );
  }, 30000);

  test('the report is once per transform, not once per process', async () => {
    // The missing-scope warning latches for the lifetime of the module,
    // because a missing `runInRequestScope` is the same wiring mistake on
    // every request. This one names bytes lost from one response, so a
    // second response has to be able to report its own.
    const run = () =>
      runInRequestScope(
        () =>
          new Promise((resolve, reject) => {
            const sink = new Writable({
              write(chunk, encoding, callback) {
                callback();
              }
            });
            sink.on('error', reject);
            sink.on('finish', resolve);

            const injector = createStyleInjectionTransform({
              prelude: PRELUDE
            });
            injector.on('error', reject);
            injector.pipe(sink);
            injector.write(Buffer.from('<p>body</p>', 'utf8'));
            injector.end();

            StyleSheet.create({
              [`afterEndTwice${uniq()}`]: { marginTop: uniq() }
            });
            // $FlowFixMe - React's hook, deliberately not on the Transform type
            injector.flush();
            // A second late push on the SAME transform stays quiet.
            StyleSheet.create({
              [`afterEndTwice${uniq()}`]: { marginTop: uniq() }
            });
            // $FlowFixMe - React's hook, deliberately not on the Transform type
            injector.flush();
          })
      );

    await run();
    expect(console.error).toHaveBeenCalledTimes(1);
    await run();
    expect(console.error).toHaveBeenCalledTimes(2);
  }, 30000);

  test('a destroyed stream reports nothing: the response is gone either way', async () => {
    // A client that hangs up destroys the socket, which destroys us. Bytes
    // going missing is what an aborted response *is*, so reporting it would
    // fire on every disconnect and mean nothing.
    //
    // Destroying BEFORE `_flush` is not what pins the exemption, though —
    // `flushed` is still false there, so the bytes go to `tail` and are
    // silently never read, warning or no warning. The case that needs the
    // explicit `destroyed` check is the other order: a stream that finished
    // normally (so `_flush` ran and `flushed` is set) and was destroyed
    // afterwards. Without the check that is indistinguishable from trap 7b
    // and reports lost bytes on a response that already went out whole.
    const destroyThen = (when) =>
      runInRequestScope(
        () =>
          new Promise((resolve) => {
            const sink = new Writable({
              write(chunk, encoding, callback) {
                callback();
              }
            });
            sink.on('error', () => {});

            const injector = createStyleInjectionTransform({
              epilogue: EPILOGUE,
              prelude: PRELUDE
            });
            injector.on('error', () => {});
            injector.pipe(sink);
            injector.write(Buffer.from('<p>body</p>', 'utf8'));
            if (when === 'after-end') injector.end();
            injector.destroy();

            StyleSheet.create({
              [`afterDestroy${uniq()}`]: { marginTop: uniq() }
            });
            // $FlowFixMe - React's hook, deliberately not on the Transform type
            injector.flush();
            setImmediate(resolve);
          })
      );

    // Aborted mid-response.
    await destroyThen('mid-response');
    expect(console.error).not.toHaveBeenCalled();
    // Destroyed after the response completed — `_flush` has run, so only the
    // `destroyed` check keeps this quiet.
    await destroyThen('after-end');
    expect(console.error).not.toHaveBeenCalled();
  }, 30000);
});
