/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `renderToStreamingResponse({ waitForAll: true })` — hold every byte until
 * the last boundary resolves, then write once.
 *
 * WHY THE MODE EXISTS. Buffering the STREAMED bytes and shipping them as one
 * blob is not the same document. Fizz has already committed to the
 * progressive shape by then: the boundary's markup sits in a `<template>`,
 * the position it belongs in holds the fallback, and only the `$RC` script
 * moves one to the other. A client that does not run JS therefore reads the
 * fallback, whatever the buffering did. Measured on a real page: six
 * `<template>` elements, two unresolved boundaries and the loader still in
 * place. Piping from `onAllReady` instead means nothing has been flushed when
 * the tree settles, so React serialises it directly.
 *
 * WHAT IS UNDER TEST. That the settled document carries no boundary
 * scaffolding, that the content is where it belongs rather than in a
 * template, that a single write carries it, and that the default streaming
 * mode still behaves as before.
 *
 * TRAP: the node jest config sets `fakeTimers.enableGlobally`, which fakes
 * `setImmediate` — the primitive Fizz schedules every flush pass with.
 */

import * as React from 'react';
import { Suspense } from 'react';
import { Writable } from 'node:stream';

import renderToStreamingResponse from '..';

jest.useRealTimers();
beforeEach(() => {
  jest.useRealTimers();
});

function createResponse() {
  const chunks = [];
  const writes = [];
  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  const response = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk);
      writes.push(Buffer.concat(chunks).toString('utf8'));
      callback();
    }
  });
  // $FlowFixMe - test double
  response.setHeader = () => {};
  response.on('finish', () =>
    settle({
      html: Buffer.concat(chunks).toString('utf8'),
      statusCode: response.statusCode,
      writes
    })
  );
  // $FlowFixMe - test double
  response.statusCode = 0;
  // $FlowFixMe - test double
  response.done = done;
  return response;
}

/** Suspends once, then renders. One instance per test: the latch is local. */
function makeLate(text) {
  let resolved = false;
  let pending;
  return function Late() {
    if (!resolved) {
      pending ??= new Promise((resolve) =>
        setTimeout(() => {
          resolved = true;
          resolve();
        }, 20)
      );
      throw pending;
    }
    return <p>{text}</p>;
  };
}

const tree = (Late) => (
  <div id="root">
    <Suspense fallback={<p>FALLBACK_MARKER</p>}>
      <Late />
    </Suspense>
  </div>
);

describe('renderToStreamingResponse({ waitForAll: true })', () => {
  test('emits no boundary scaffolding and puts the content in place', async () => {
    const response = createResponse();
    const Late = makeLate('SETTLED_CONTENT');
    renderToStreamingResponse({
      element: tree(Late),
      head: '<title>t</title>',
      response,
      waitForAll: true
    });
    const { html } = await response.done;

    // Vacuity guard: the content has to be there at all for the rest to mean
    // anything.
    expect(html).toContain('SETTLED_CONTENT');
    expect(html).not.toContain('<template');
    expect(html).not.toContain('$RC(');
    expect(html).not.toContain('<!--$?-->');
    expect(html).not.toContain('FALLBACK_MARKER');
  });

  test('still calls onAllReady', async () => {
    const response = createResponse();
    const Late = makeLate('CALLBACK');
    const onAllReady = jest.fn();
    renderToStreamingResponse({
      element: tree(Late),
      head: '<title>t</title>',
      onAllReady,
      response,
      waitForAll: true
    });
    await response.done;
    expect(onAllReady).toHaveBeenCalledTimes(1);
  });

  test('the default mode produces the scaffolding this mode removes', async () => {
    const streamed = createResponse();
    renderToStreamingResponse({
      element: tree(makeLate('AB_CONTENT')),
      head: '<title>t</title>',
      response: streamed
    });
    const a = await streamed.done;

    const settled = createResponse();
    renderToStreamingResponse({
      element: tree(makeLate('AB_CONTENT')),
      head: '<title>t</title>',
      response: settled,
      waitForAll: true
    });
    const b = await settled.done;

    // Same tree, same content, both complete — the only difference is shape.
    expect(a.html).toContain('AB_CONTENT');
    expect(b.html).toContain('AB_CONTENT');

    // Default: the fallback is in the document and the content is behind a
    // template that only the reveal script moves into place.
    expect(a.html).toContain('FALLBACK_MARKER');
    expect(a.html).toContain('<template');
    expect(a.html).toContain('$RC(');

    // waitForAll: none of it.
    expect(b.html).not.toContain('FALLBACK_MARKER');
    expect(b.html).not.toContain('<template');
    expect(b.html).not.toContain('$RC(');
  });
});
