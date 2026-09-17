/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Concurrent responses through the bridge.
 *
 * Everything else in this directory drives one response at a time, which is
 * the one shape a worker never actually sees. `renderToPipeableStream`
 * interleaves concurrent renders through the same module-level state, and
 * keeping one request's viewport or color scheme out of another's markup is
 * the entire reason `runInRequestScope` exists. None of that had been
 * exercised across a port.
 *
 * Both multiplexing strategies are covered, because they are different code
 * paths: a `MessageChannel` per response (no ids), and one shared port with
 * distinct ids.
 *
 * TRAP: the node jest config sets `fakeTimers.enableGlobally`, which fakes
 * `setImmediate` — the primitive Fizz schedules flush passes with, and the
 * tick the bridge batches on. Real timers are mandatory.
 *
 * TRAP: the compiled stylesheet is process-wide and dedups by selector, so
 * every request here takes a padding value no other test has used.
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

function tick(n = 10) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) {
    p = p.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return p;
}

let seed = 20000;
const uniq = () => seed++;

const CONCURRENCY = 8;

/** Suspends on first render, resolves `delay` ms later. */
function createSuspendingComponent(renderResolved, delay) {
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

function LateView({ style }) {
  const compiled = StyleSheet.create({ late: style });
  return <View style={compiled.late} />;
}

function createResponse() {
  const chunks = [];
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const response = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk);
      callback();
    }
  });
  response.setHeader = () => {};
  response.statusCode = 0;
  response.on('finish', () => settle(Buffer.concat(chunks).toString('utf8')));
  response.done = done;
  return response;
}

/** The JSON the hydration snapshot script carries. */
function hydrationPayload(html) {
  const match = /window\.__RNW_HYDRATION__=({.*?})<\/script>/.exec(html);
  return match == null ? null : JSON.parse(match[1].replace(/\\u003c/g, '<'));
}

/**
 * One request's distinguishing marks: a viewport no other request has, a
 * color scheme, and a late-boundary rule that must appear in this document
 * and in no other. The delays are staggered and interleaved so the renders
 * genuinely overlap rather than queueing behind one another.
 */
function createRequests(count) {
  const requests = [];
  for (let i = 0; i < count; i++) {
    const width = 300 + i * 37;
    requests.push({
      colorScheme: i % 2 === 0 ? 'dark' : 'light',
      index: i,
      pad: uniq(),
      viewport: {
        fontScale: 1 + i / 100,
        height: 500 + i * 11,
        scale: 1,
        width
      },
      // Reverse-ordered against index, so completion order is not start
      // order and the interleaving is real.
      delay: 5 + (count - i) * 4
    });
  }
  return requests;
}

function startRender(request, response) {
  const shell = StyleSheet.create({
    shell: { marginTop: request.pad + 100000 }
  });
  const Late = createSuspendingComponent(
    () => <LateView style={{ paddingTop: request.pad }} />,
    request.delay
  );
  renderToStreamingResponse({
    colorScheme: request.colorScheme,
    element: (
      <View style={shell.shell}>
        <Text>{`req-${request.index}`}</Text>
        <Suspense fallback={<Text>loading</Text>}>
          <Late />
        </Suspense>
      </View>
    ),
    head: `<title>req-${request.index}</title>`,
    response,
    viewport: request.viewport
  });
}

function assertNoCrossContamination(requests, documents) {
  requests.forEach((request, i) => {
    const html = documents[i];
    const label = `request ${request.index}`;

    // The document is this request's, start to finish.
    expect(html).toContain(`<title>req-${request.index}</title>`);
    expect(html).toContain(`req-${request.index}`);
    expect(html.endsWith('</div></body></html>')).toBe(true);

    // The device state this request asked for, and not a neighbour's. This
    // is the assertion the whole file exists for.
    const snapshot = hydrationPayload(html);
    expect(snapshot).not.toBe(null);
    expect(snapshot.Dimensions.window).toEqual(request.viewport);
    expect(snapshot.Dimensions.screen).toEqual(request.viewport);
    expect(snapshot.Appearance.colorScheme).toBe(request.colorScheme);

    // Its own late rule arrived...
    expect(html).toMatch(new RegExp(`padding-top:\\s*${request.pad}px`));

    // ...and no *markup* from any other request did. The CSS delta is a
    // different matter — see `the delta channel over-delivers` below, where
    // that documented imprecision is pinned rather than asserted away.
    requests.forEach((other) => {
      if (other.index === request.index) return;
      expect(html).not.toContain(`<title>req-${other.index}</title>`);
      expect(html).not.toContain(`req-${other.index}<`);
    });

    // Exactly one shell, in <head>. Two anchor sets per group is the cascade
    // inversion the shell rules exist to prevent.
    expect(html.match(/<style[^>]*data-rnw-group="0"/g) || []).toHaveLength(1);
    expect(html.indexOf('data-rnw-group="0"')).toBeLessThan(
      html.indexOf('<div id="root">')
    );

    expect(label).toBe(label);
  });
}

test('concurrent responses on dedicated channels do not cross', async () => {
  const requests = createRequests(CONCURRENCY);
  const channels = requests.map(() => new MessageChannel());
  const responses = requests.map(() => createResponse());

  requests.forEach((request, i) => {
    pipeWorkerResponse({ port: channels[i].port1, response: responses[i] });
  });

  // Started in one synchronous run, so every render is in flight at once and
  // Fizz is genuinely interleaving their passes.
  requests.forEach((request, i) => {
    startRender(request, createWorkerResponse({ port: channels[i].port2 }));
  });

  const documents = await Promise.all(responses.map((r) => r.done));
  assertNoCrossContamination(requests, documents);

  channels.forEach((channel) => {
    channel.port1.close();
    channel.port2.close();
  });
});

test('concurrent responses sharing one port do not cross', async () => {
  const requests = createRequests(CONCURRENCY);
  const channel = new MessageChannel();
  const responses = requests.map(() => createResponse());

  requests.forEach((request, i) => {
    pipeWorkerResponse({
      id: `req-${i}`,
      port: channel.port1,
      response: responses[i]
    });
  });

  requests.forEach((request, i) => {
    startRender(
      request,
      createWorkerResponse({ id: `req-${i}`, port: channel.port2 })
    );
  });

  const documents = await Promise.all(responses.map((r) => r.done));
  assertNoCrossContamination(requests, documents);

  // Every id let go of the shared port once its response finished, so a
  // long-lived worker does not accumulate them. The tick is for the final
  // acks, which round-trip after the main-thread responses have already
  // emitted `'finish'`.
  await tick();
  expect(channel.port1.listenerCount('message')).toBe(0);
  expect(channel.port2.listenerCount('message')).toBe(0);

  channel.port1.close();
  channel.port2.close();
});

/**
 * The one thing concurrency here does NOT isolate, pinned so it stays a known
 * property rather than a discovery.
 *
 * `drainRequestDelta` sends everything added to the shared sheet since this
 * request's watermark, because it cannot ask which rules this request's own
 * render inserted: a lazily imported module runs `StyleSheet.create` once per
 * process, so for every request after the first the rules its boundary needs
 * were inserted by somebody else. The cost is that a cold server under
 * concurrent load sends each request some rules only a neighbour needed. It is
 * inert — ingest dedups by selector, and the client never references a class
 * it did not render — and it stops once the app is warm. See "The delta is
 * derived from the sheet's revision log" in STREAMING-SSR.md.
 *
 * What must NOT leak is device state, which the tests above cover. This test
 * exists so that if the delta ever does become per-request-precise, the change
 * is deliberate and this assertion is updated rather than silently passing.
 */
test('the delta channel over-delivers across concurrent requests, by design', async () => {
  const requests = createRequests(4);
  const channels = requests.map(() => new MessageChannel());
  const responses = requests.map(() => createResponse());

  requests.forEach((request, i) => {
    pipeWorkerResponse({ port: channels[i].port1, response: responses[i] });
  });
  requests.forEach((request, i) => {
    startRender(request, createWorkerResponse({ port: channels[i].port2 }));
  });

  const documents = await Promise.all(responses.map((r) => r.done));

  // Every document carries its own rule...
  documents.forEach((html, i) => {
    expect(html).toMatch(new RegExp(`padding-top:\\s*${requests[i].pad}px`));
  });

  // ...and the earliest-started request, whose watermark is oldest, also
  // carries the rules every later request compiled. This is the documented
  // imprecision, not a scope leak: the device-state assertions above pass on
  // the same responses.
  const foreignInFirst = requests
    .slice(1)
    .filter((other) =>
      new RegExp(`padding-top:\\s*${other.pad}px`).test(documents[0])
    );
  expect(foreignInFirst.length).toBeGreaterThan(0);

  // The last-started request's watermark is newest, so nothing foreign
  // precedes it — which is what makes this a watermark effect rather than a
  // broadcast.
  const last = documents[documents.length - 1];
  const foreignInLast = requests
    .slice(0, -1)
    .filter((other) => new RegExp(`padding-top:\\s*${other.pad}px`).test(last));
  expect(foreignInLast).toEqual([]);

  channels.forEach((channel) => {
    channel.port1.close();
    channel.port2.close();
  });
});
