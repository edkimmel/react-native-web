/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Backpressure, end to end.
 *
 * The protocol suite proves the *bridge* holds its write callbacks when the
 * consumer stalls. That is not the interesting claim. The interesting claim is
 * the one in the module comment — that holding those callbacks makes Node
 * apply real backpressure back through the pipe, through the style-injection
 * Transform, and into Fizz, "the only place that can actually slow down".
 * Nothing proved that Fizz ever hears about it.
 *
 * The measurement: render the same app to a consumer that never drains, and
 * count the bytes the render manages to push into the bridge before it is
 * stopped. Compare against a fast consumer, which gives the true document
 * size.
 *
 * What makes this conclusive is not the ratio — a ratio can be made small by
 * making the document large. It is that the stalled figure is *flat* while
 * the document grows. Measured across an 8x range:
 *
 *   document 222 KB -> 66.0 KB produced while stalled  (29.7%)
 *   document 441 KB -> 66.3 KB                         (15.0%)
 *   document 880 KB -> 65.9 KB                         ( 7.5%)
 *   document 1.76 MB -> 67.3 KB                        ( 3.8%)
 *
 * A constant ceiling is bounded memory; a proportional one would mean the
 * whole document buffers in the worker and the backpressure is cosmetic. This
 * test pins the constant by rendering two documents that differ 4x and
 * asserting the stalled figures do not.
 *
 * TRAP: `fakeTimers.enableGlobally` fakes `setImmediate`, which Fizz schedules
 * every flush pass with and which the bridge batches on. Real timers only.
 */

import * as React from 'react';
import { Suspense } from 'react';
import { MessageChannel } from 'node:worker_threads';
import { Writable } from 'node:stream';

import StyleSheet from '../../../exports/StyleSheet';
import Text from '../../../exports/Text';
import View from '../../../exports/View';
import renderToStreamingResponse from '../../streamingResponse';
import { createWorkerResponse, pipeWorkerResponse } from '..';

jest.useRealTimers();
beforeEach(() => {
  jest.useRealTimers();
});

let seed = 60000;
const uniq = () => seed++;

const ROWS_PER_BOUNDARY = 40;

function Rows({ n, tag }) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(<Text key={i}>{`${tag}-row-${i}-` + 'x'.repeat(120)}</Text>);
  }
  return <View>{items}</View>;
}

function makeBoundary(index, delay) {
  let done = false;
  let pending = null;
  return function Boundary() {
    if (!done) {
      if (pending == null) {
        pending = new Promise((resolve) => {
          setTimeout(() => {
            done = true;
            resolve();
          }, delay);
        });
      }
      throw pending;
    }
    return <Rows n={ROWS_PER_BOUNDARY} tag={`b${index}`} />;
  };
}

function bigApp(boundaries) {
  const children = [];
  for (let i = 0; i < boundaries; i++) {
    const Boundary = makeBoundary(i, 1 + (i % 5));
    children.push(
      <Suspense fallback={<Text>l</Text>} key={i}>
        <Boundary />
      </Suspense>
    );
  }
  const shell = StyleSheet.create({ shell: { marginTop: uniq() } });
  return <View style={shell.shell}>{children}</View>;
}

/**
 * Render `boundaries` worth of app through the bridge. `stall` decides
 * whether the main-thread consumer ever calls its write callback.
 */
function run(boundaries, { stall }) {
  const channel = new MessageChannel();
  let held = [];

  const response = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, callback) {
      if (stall) held.push(callback);
      else callback();
    }
  });
  response.setHeader = () => {};
  response.statusCode = 0;

  pipeWorkerResponse({ port: channel.port1, response, onError() {} });

  const bridge = createWorkerResponse({ port: channel.port2 });

  // Everything the render pushes into the bridge. With backpressure reaching
  // Fizz this plateaus; without it, it reaches the whole document.
  let intoBridge = 0;
  const write = bridge.write.bind(bridge);
  bridge.write = (chunk, encoding, callback) => {
    intoBridge += Buffer.byteLength(chunk);
    return write(chunk, encoding, callback);
  };

  const finished = new Promise((resolve) => response.on('finish', resolve));
  renderToStreamingResponse({ element: bigApp(boundaries), response: bridge });

  return {
    close() {
      bridge.destroy();
      channel.port1.close();
      channel.port2.close();
    },
    finished,
    produced: () => intoBridge,
    queued: () => bridge.writableLength,
    release() {
      const callbacks = held;
      held = [];
      callbacks.forEach((callback) => callback());
    }
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SMALL = 30;
const LARGE = 120;

test('a stalled consumer stops Fizz, and the backlog is bounded', async () => {
  // Control runs establish the true document size at each scale.
  const smallControl = run(SMALL, { stall: false });
  await smallControl.finished;
  const smallTotal = smallControl.produced();
  smallControl.close();

  const largeControl = run(LARGE, { stall: false });
  await largeControl.finished;
  const largeTotal = largeControl.produced();
  largeControl.close();

  // The documents really do differ by roughly the factor the boundary count
  // does, or the comparison below proves nothing.
  expect(largeTotal / smallTotal).toBeGreaterThan(3);

  const smallStalled = run(SMALL, { stall: true });
  const largeStalled = run(LARGE, { stall: true });
  await wait(400);

  const smallProduced = smallStalled.produced();
  const largeProduced = largeStalled.produced();

  // Fizz was stopped well short of finishing, at both scales.
  expect(smallProduced).toBeLessThan(smallTotal / 2);
  expect(largeProduced).toBeLessThan(largeTotal / 4);

  // And the ceiling is a constant, not a fraction: a 4x document does not
  // buy a 4x backlog. This is the assertion that distinguishes real
  // backpressure from the whole document buffering in the worker.
  const ratio = largeProduced / smallProduced;
  expect(ratio).toBeGreaterThan(0.5);
  expect(ratio).toBeLessThan(2);

  // The backlog is held in the bridge's own writable buffer, which is what
  // bounds the worker's memory.
  expect(largeStalled.queued()).toBeLessThanOrEqual(largeProduced);

  smallStalled.close();
  largeStalled.close();
});
