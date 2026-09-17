/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The two wiring mistakes the transform can see from the inside, and when it
 * says so.
 *
 * Both of these are silent in production by design and neither is
 * recoverable, so what is under test is the report itself: that it fires for
 * the broken arrangement, that it does not fire for the documented one, and
 * — for the missing scope — that it arrives at the end of React's first pass
 * rather than at the end of the response, which is where it used to arrive.
 *
 * TRAP: both warnings are guarded by a flag, one per process for the scope
 * (it is a wiring mistake, identical on every request) and one per transform
 * for the pipe order. The scope tests therefore load a fresh copy of the
 * module graph, or the second of them would observe a warning the first one
 * had already spent.
 *
 * TRAP: `fakeTimers.enableGlobally` in the node jest config fakes
 * `setImmediate`, which Fizz schedules every flush pass with. Real timers
 * are mandatory here.
 */

import * as React from 'react';
import { Suspense } from 'react';
import { Writable } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';

import StyleSheet from '../../../exports/StyleSheet';
import Text from '../../../exports/Text';
import View from '../../../exports/View';

jest.useRealTimers();

let seed = 7000;
const uniq = () => seed++;

const PRELUDE = (shellCSS) =>
  `<!doctype html><html><head><meta charset="utf-8">${shellCSS}</head><body><div id="root">`;
const EPILOGUE = '</div></body></html>';

/**
 * A copy of the transform and of the scope it reads, from one fresh module
 * registry — so the per-process warning flag is fresh too.
 */
function freshModules() {
  let createStyleInjectionTransform;
  let asyncContext;
  jest.isolateModules(() => {
    // `babel-plugin-add-module-exports` collapses `module.exports` to the
    // default while a module has no named runtime exports, which this one
    // does not — so the required value is the function itself.
    const required = require('..');
    createStyleInjectionTransform = required.default || required;
    asyncContext = require('../../asyncContext');
  });
  return {
    createStyleInjectionTransform,
    runInRequestScope: asyncContext.runInRequestScope
  };
}

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

/** A tree whose late boundary compiles a rule of its own. */
function lateTree() {
  const pad = uniq();
  const Late = createSuspendingComponent(() => {
    const compiled = StyleSheet.create({ late: { paddingTop: pad } });
    return <View style={compiled.late} />;
  });
  return (
    <View>
      <Text>shell</Text>
      <Suspense fallback={<Text>loading</Text>}>
        <Late />
      </Suspense>
    </View>
  );
}

/**
 * Render through `injector`, wiring it to the sink in the given order.
 * Resolves with the number of chunks the sink received, and the count it had
 * received at the moment `console.error` first fired.
 */
function render(injector, element, order) {
  return new Promise((resolve, reject) => {
    let chunks = 0;
    let chunksAtFirstWarning = null;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {
      if (chunksAtFirstWarning == null) chunksAtFirstWarning = chunks;
    });
    const sink = new Writable({
      write(chunk, encoding, callback) {
        chunks += 1;
        callback();
      }
    });
    sink.on('error', reject);
    sink.on('finish', () => {
      const calls = spy.mock.calls.map((args) => String(args[0]));
      spy.mockRestore();
      resolve({ calls, chunks, chunksAtFirstWarning });
    });

    const { pipe } = renderToPipeableStream(element, {
      onError: reject,
      onShellError: reject,
      onShellReady() {
        if (order === 'reversed') {
          pipe(injector);
          injector.pipe(sink);
        } else {
          injector.pipe(sink);
          pipe(injector);
        }
      }
    });
  });
}

const matching = (calls, fragment) =>
  calls.filter((message) => message.indexOf(fragment) !== -1);

const PIPE_ORDER = 'injector.pipe(response) first';
const NO_SCOPE = 'from outside a request scope';

describe('createStyleInjectionTransform wiring reports', () => {
  test('reversed pipe order is reported', async () => {
    const { createStyleInjectionTransform, runInRequestScope } = freshModules();
    const result = await runInRequestScope(() =>
      render(
        createStyleInjectionTransform({
          epilogue: EPILOGUE,
          prelude: PRELUDE
        }),
        lateTree(),
        'reversed'
      )
    );
    expect(matching(result.calls, PIPE_ORDER)).toHaveLength(1);
  });

  test('the documented order is not reported', async () => {
    const { createStyleInjectionTransform, runInRequestScope } = freshModules();
    const result = await runInRequestScope(() =>
      render(
        createStyleInjectionTransform({
          epilogue: EPILOGUE,
          prelude: PRELUDE
        }),
        lateTree(),
        'documented'
      )
    );
    expect(result.calls).toEqual([]);
  });

  test('a missing request scope is reported during the response, not after it', async () => {
    const { createStyleInjectionTransform } = freshModules();
    // No `runInRequestScope` anywhere: the delta channel is inert and every
    // late boundary's CSS is missing from the page.
    const result = await render(
      createStyleInjectionTransform({ epilogue: EPILOGUE, prelude: PRELUDE }),
      lateTree(),
      'documented'
    );

    expect(matching(result.calls, NO_SCOPE)).toHaveLength(1);
    // The point of the change: it fires at the end of React's first pass, so
    // there are still chunks to come. At `_flush`, where it used to fire,
    // this would equal the total.
    expect(result.chunksAtFirstWarning).toBeGreaterThan(0);
    expect(result.chunksAtFirstWarning).toBeLessThan(result.chunks);
  });

  test('a scoped response is not reported', async () => {
    const { createStyleInjectionTransform, runInRequestScope } = freshModules();
    const result = await runInRequestScope(() =>
      render(
        createStyleInjectionTransform({
          epilogue: EPILOGUE,
          prelude: PRELUDE
        }),
        lateTree(),
        'documented'
      )
    );
    expect(matching(result.calls, NO_SCOPE)).toEqual([]);
  });
});

/**
 * The pipe-order report must survive a destination that goes away.
 *
 * A client that disconnects mid-response destroys the response, which emits
 * `unpipe` and empties the transform's destination list — and the render
 * carries on for a pass or two before React's abort lands. The check that
 * looks for "nothing is consuming the readable side" then sees exactly what
 * the reversed-`pipe` mistake looks like, and reports it at a caller whose
 * pipe order is correct.
 *
 * Measured before the fix: one plain client abort against a plain
 * `http.ServerResponse`, no worker bridge anywhere, produced the reversed-pipe
 * warning every time. In development that is one wrong diagnostic per
 * disconnect, which is the fastest way to teach someone to ignore the one case
 * the warning exists for.
 */
test('a destination that unpipes mid-response is not the reversed-pipe mistake', async () => {
  const { createStyleInjectionTransform, runInRequestScope } = freshModules();

  const calls = await new Promise((resolve, reject) => {
    runInRequestScope(() => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const injector = createStyleInjectionTransform({
        epilogue: EPILOGUE,
        prelude: PRELUDE
      });

      const sink = new Writable({
        write(chunk, encoding, callback) {
          callback();
        }
      });

      const { abort, pipe } = renderToPipeableStream(lateTree(), {
        onError() {},
        onShellError: reject,
        onShellReady() {
          // The documented order, so anything reported here is a false alarm.
          injector.pipe(sink);
          pipe(injector);

          // The client goes away: the destination is destroyed, `unpipe`
          // fires, and the render keeps producing for a moment.
          setTimeout(() => {
            sink.destroy();
            setTimeout(() => {
              abort();
              setTimeout(() => {
                const seen = spy.mock.calls.map((args) => String(args[0]));
                spy.mockRestore();
                resolve(seen);
              }, 40);
            }, 30);
          }, 5);
        }
      });
    });
  });

  expect(calls.filter((call) => /reached the end of/.test(call))).toEqual([]);
});
