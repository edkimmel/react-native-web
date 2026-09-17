/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `renderToStreamingResponse` through the worker bridge, end to end.
 *
 * The protocol tests next door prove the bridge moves bytes, flushes and
 * backpressure correctly. This proves the thing that actually matters: the
 * adapter cannot tell the difference. The same call that writes into an
 * `http.ServerResponse` writes into `createWorkerResponse()`, and what comes
 * out on the other side of the port is the same streamed document — shell in
 * <head>, late boundary as a delta, and the shell on the wire *before* the
 * boundary resolved.
 *
 * Still one process and one `MessageChannel`; see the protocol suite's header
 * for why a real `Worker` would add noise rather than coverage.
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

let seed = 9000;
const uniq = () => seed++;

/** Suspends on first render, resolves `delay` ms later. */
function createSuspendingComponent(renderResolved, delay = 20) {
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

/** A `View` whose class is compiled at render time, not at module scope. */
function LateView({ style }) {
  const compiled = StyleSheet.create({ late: style });
  return <View style={compiled.late} />;
}

/**
 * The main-thread response: records the document as it accumulates, and the
 * prefix that had been written at each flush, so the streaming property is
 * observable rather than inferred from the final bytes.
 */
function createMainThreadResponse() {
  const chunks = [];
  const headers = {};
  const flushedAt = [];
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
  const soFar = () => Buffer.concat(chunks).toString('utf8');
  response.setHeader = (name, value) => {
    headers[name.toLowerCase()] = value;
  };
  response.flush = () => flushedAt.push(soFar());
  response.statusCode = 0;
  response.on('finish', () => {
    settle({
      flushedAt,
      headers,
      html: soFar(),
      statusCode: response.statusCode
    });
  });
  response.done = done;
  return response;
}

test('the adapter cannot tell the bridge from a ServerResponse', async () => {
  const channel = new MessageChannel();
  const response = createMainThreadResponse();
  pipeWorkerResponse({ id: 'req-1', port: channel.port1, response });

  const shell = StyleSheet.create({
    shell: { backgroundColor: `rgb(${uniq() % 255}, 2, 3)` }
  });
  const pad = uniq();
  const Late = createSuspendingComponent(() => (
    <LateView style={{ paddingTop: pad }} />
  ));

  // Exactly the call a non-worker server makes. The only difference is what
  // `response` is.
  renderToStreamingResponse({
    element: (
      <View style={shell.shell}>
        <Text>shell-content</Text>
        <Suspense fallback={<Text>loading</Text>}>
          <Late />
        </Suspense>
      </View>
    ),
    head: '<title>Worker</title>',
    response: createWorkerResponse({ id: 'req-1', port: channel.port2 })
  });

  const { flushedAt, headers, html, statusCode } = await response.done;

  // Status and headers crossed the port before the first byte.
  expect(statusCode).toBe(200);
  expect(headers['content-type']).toBe('text/html; charset=utf-8');

  // A complete document, assembled by the adapter, delivered by the bridge.
  expect(html.startsWith('<!doctype html><html lang="en"><head>')).toBe(true);
  expect(html).toContain('<title>Worker</title>');
  expect(html).toContain('window.__RNW_HYDRATION__');
  expect(html).toContain('shell-content');
  expect(html.endsWith('</div></body></html>')).toBe(true);

  // One shell anchor, in <head>.
  expect(html.match(/<style[^>]*data-rnw-group="0"/g)).toHaveLength(1);
  expect(html.indexOf('data-rnw-group="0"')).toBeLessThan(
    html.indexOf('<div id="root">')
  );

  // The late boundary's rule arrived through the delta channel, which is
  // inert outside a request scope — so this is also the proof that the
  // adapter's scope survived being driven from across a port.
  expect(html).toMatch(new RegExp(`padding-top:\\s*${pad}px`));
  expect(html.indexOf(`${pad}px`)).toBeGreaterThan(
    html.indexOf('<div id="root">')
  );

  // And it streamed: React's per-pass flush reached the main thread with the
  // shell already written and the late boundary not yet resolved. A bridge
  // that dropped the flush signal, or posted it ahead of the bytes, fails
  // here while still producing identical final HTML.
  //
  // (The final delta rides out in the transform's `_flush`, which is the last
  // thing before `end()` — there is no React flush after it. The claim here
  // is about the shell, which is the one that matters: it reached the socket
  // while the boundary was still pending.)
  const shellFlushIndex = flushedAt.findIndex(
    (prefix) =>
      prefix.includes('<div id="root">') && !prefix.includes(`${pad}px`)
  );
  expect(shellFlushIndex).toBeGreaterThanOrEqual(0);
  expect(flushedAt.length).toBeGreaterThan(shellFlushIndex);

  channel.port1.close();
  channel.port2.close();
});
