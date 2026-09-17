/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `renderToStreamingResponse` against the real `react-dom/server` Node
 * streaming renderer, with real Suspense boundaries that resolve on a timer.
 *
 * What is actually under test is the wiring, not the CSS format — the format
 * has its own suite next door in `../../styleInjection/__tests__`. These
 * assert that the one call produces what the guide's hand-written example
 * produces: a document whose head carries the shell and the hydration
 * snapshot, a late boundary whose CSS arrives as a delta (which it can only
 * do from inside a request scope), and per-request device state that does
 * not leak between concurrent renders.
 *
 * TRAP: the node jest config sets `fakeTimers.enableGlobally`, which fakes
 * `setImmediate` — the primitive Fizz schedules every flush pass with. Under
 * fake timers `renderToPipeableStream` never progresses. Real timers are
 * mandatory.
 *
 * TRAP: the compiled stylesheet is process-wide and dedups by selector, so a
 * declaration an earlier test already inserted produces no delta at all.
 * Every test takes its values from `uniq()`.
 */

import * as React from 'react';
import { Suspense } from 'react';
import { Writable } from 'node:stream';

import StyleSheet from '../../../exports/StyleSheet';
import Text from '../../../exports/Text';
import View from '../../../exports/View';
import Dimensions from '../../../exports/Dimensions';
import renderToStreamingResponse from '..';
import { runInRequestScope } from '../../asyncContext';

jest.useRealTimers();
beforeEach(() => {
  jest.useRealTimers();
});

let seed = 5000;
const uniq = () => seed++;

const VIEWPORT = { fontScale: 1, height: 768, scale: 1, width: 1024 };

/**
 * A stand-in for `http.ServerResponse`: a Writable that also carries the
 * three members the adapter touches. `done` resolves with the whole response
 * once the stream finishes.
 */
function createResponse() {
  const chunks = [];
  const headers = {};
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
  // $FlowFixMe - test double
  response.setHeader = (name, value) => {
    headers[name.toLowerCase()] = value;
  };
  response.on('finish', () => {
    settle({
      headers,
      html: Buffer.concat(chunks).toString('utf8'),
      statusCode: response.statusCode
    });
  });
  // $FlowFixMe - test double
  response.statusCode = 0;
  // $FlowFixMe - test double
  response.done = done;
  return response;
}

/** Suspends forever, with no timer to keep the process alive. */
function createNeverResolvingComponent() {
  const pending = new Promise(() => {});
  return function Never() {
    throw pending;
  };
}

/** Suspends on first render, resolves `delay` ms later. */
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

/** A `View` whose class is compiled at render time, not at module scope. */
function LateView({ style, testID }) {
  const compiled = StyleSheet.create({ late: style });
  return <View dataSet={{ testid: testID }} style={compiled.late} />;
}

/** The JSON the hydration snapshot script carries. */
function hydrationPayload(html) {
  const match = /window\.__RNW_HYDRATION__=({.*?})<\/script>/.exec(html);
  return match == null ? null : JSON.parse(match[1].replace(/\\u003c/g, '<'));
}

const flatten = (value) =>
  JSON.stringify(
    value == null ? null : Object.keys(value).map((k) => value[k])
  );

describe('renderToStreamingResponse', () => {
  test('streams a complete document around the app', async () => {
    const styles = StyleSheet.create({
      shell: { backgroundColor: `rgb(${uniq() % 255}, 1, 1)` }
    });
    const response = createResponse();

    renderToStreamingResponse({
      element: (
        <View style={styles.shell}>
          <Text>hello</Text>
        </View>
      ),
      head: '<title>Test</title>',
      response
    });

    const { headers, html, statusCode } = await response.done;

    expect(statusCode).toBe(200);
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.startsWith('<!doctype html><html lang="en"><head>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>Test</title>');
    expect(html).toContain('<div id="root">');
    expect(html.endsWith('</div></body></html>')).toBe(true);
    // The shell stylesheet, and exactly one of it.
    expect(html.match(/data-rnw-group="0"/g)).toHaveLength(1);
    // …in <head>, ahead of the app.
    expect(html.indexOf('data-rnw-group="0"')).toBeLessThan(
      html.indexOf('<div id="root">')
    );
    expect(html).toContain('hello');
  });

  test('opens a request scope, so a late boundary streams its CSS as a delta', async () => {
    // A pixel value rather than a color: RNW normalises colors on the way
    // into the sheet, so the string this test looks for would not be the
    // string it wrote.
    const pad = uniq();
    const Late = createSuspendingComponent(() => (
      <LateView style={{ paddingTop: pad }} testID="late" />
    ));
    const response = createResponse();

    renderToStreamingResponse({
      element: (
        <View>
          <Suspense fallback={<Text>loading</Text>}>
            <Late />
          </Suspense>
        </View>
      ),
      response
    });

    const { html } = await response.done;

    // The boundary resolved and its markup is in the response…
    expect(html).toContain('data-testid="late"');
    // …its rule was compiled after <head> went out, so it can only have
    // arrived through the delta channel, which is inert outside a scope.
    const rule = `padding-top:${pad}px`;
    expect(html).toContain(rule);
    expect(html.indexOf(rule)).toBeGreaterThan(html.indexOf('<div id="root">'));
    // And the delta left no DOM node behind, per the streamed format. (The
    // attribute name still occurs inside the script's own querySelector,
    // which is why this looks for an element rather than the string.)
    expect(html).not.toMatch(/<style[^>]*data-rnw-delta/);
  });

  test('carries this request’s device state in the hydration snapshot', async () => {
    const response = createResponse();

    renderToStreamingResponse({
      colorScheme: 'dark',
      element: <Text>x</Text>,
      response,
      viewport: VIEWPORT
    });

    const { html } = await response.done;
    const payload = hydrationPayload(html);

    expect(payload).not.toBe(null);
    expect(flatten(payload)).toContain('"width":1024');
    expect(flatten(payload)).toContain('dark');
    // In <head>, so it parses before any boundary can hydrate against it.
    expect(html.indexOf('__RNW_HYDRATION__')).toBeLessThan(
      html.indexOf('<div id="root">')
    );
  });

  test('isolates device state between concurrent responses', async () => {
    const wide = { fontScale: 1, height: 600, scale: 1, width: 1440 };
    const narrow = { fontScale: 1, height: 800, scale: 1, width: 375 };

    const a = createResponse();
    const b = createResponse();
    renderToStreamingResponse({
      colorScheme: 'dark',
      element: <Text>a</Text>,
      response: a,
      viewport: wide
    });
    renderToStreamingResponse({
      colorScheme: 'light',
      element: <Text>b</Text>,
      response: b,
      viewport: narrow
    });

    const [resultA, resultB] = await Promise.all([a.done, b.done]);

    expect(flatten(hydrationPayload(resultA.html))).toContain('"width":1440');
    expect(flatten(hydrationPayload(resultA.html))).toContain('dark');
    expect(flatten(hydrationPayload(resultB.html))).toContain('"width":375');
    expect(flatten(hydrationPayload(resultB.html))).toContain('light');
  });

  test('uses an already-open request scope instead of nesting one', async () => {
    const response = createResponse();
    const screen = { fontScale: 1, height: 2000, scale: 2, width: 3000 };
    const window = { fontScale: 1, height: 500, scale: 2, width: 600 };

    await runInRequestScope(() => {
      // Asymmetric screen/window, which the adapter's own `viewport` option
      // cannot express. A nested scope would be seeded from the process
      // defaults and would throw this away.
      Dimensions.set({ screen, window });
      renderToStreamingResponse({ element: <Text>x</Text>, response });
      return response.done;
    });

    const flat = flatten(hydrationPayload((await response.done).html));
    expect(flat).toContain('"width":600');
    expect(flat).toContain('"width":3000');
  });

  test('honours rootId, lang, status and nonce', async () => {
    const response = createResponse();

    renderToStreamingResponse({
      element: <Text>x</Text>,
      lang: 'pt-BR',
      nonce: 'n0nce',
      response,
      rootId: 'app-root',
      status: 201
    });

    const { html, statusCode } = await response.done;

    expect(statusCode).toBe(201);
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain('<div id="app-root">');
    expect(html).toContain('<style data-rnw-group="0" nonce="n0nce">');
    expect(html).toContain('<script nonce="n0nce">window.__RNW_HYDRATION__');
  });

  test('sends a 500 when the shell itself fails', async () => {
    const response = createResponse();
    const Boom = () => {
      throw new Error('shell exploded');
    };
    const onError = jest.fn();

    renderToStreamingResponse({ element: <Boom />, onError, response });

    const { html, statusCode } = await response.done;
    expect(statusCode).toBe(500);
    expect(html).toContain('Something went wrong');
    expect(onError).toHaveBeenCalled();
  });

  test('a custom onShellError owns the response', async () => {
    const response = createResponse();
    const Boom = () => {
      throw new Error('shell exploded');
    };

    renderToStreamingResponse({
      element: <Boom />,
      onError() {},
      onShellError(error) {
        response.statusCode = 503;
        response.end(`<p>${String(error.message)}</p>`);
      },
      response
    });

    const { html, statusCode } = await response.done;
    expect(statusCode).toBe(503);
    expect(html).toBe('<p>shell exploded</p>');
  });

  test('rejects a call it cannot serve, at the call site', () => {
    const response = createResponse();
    expect(() => renderToStreamingResponse({ response })).toThrow(
      /requires `element`/
    );
    expect(() => renderToStreamingResponse({ element: <Text /> })).toThrow(
      /requires `response`/
    );
    expect(() =>
      renderToStreamingResponse({
        element: <Text />,
        response,
        rootId: 'oops"><script>'
      })
    ).toThrow(/invalid `rootId`/);
    expect(() =>
      renderToStreamingResponse({
        element: <Text />,
        lang: 'en"><script>',
        response
      })
    ).toThrow(/invalid `lang`/);
  });

  test('returns an abort handle that ends the response', async () => {
    const response = createResponse();
    const Never = createNeverResolvingComponent();

    const handle = renderToStreamingResponse({
      element: (
        <View>
          <Text>shell</Text>
          <Suspense fallback={<Text>loading</Text>}>
            <Never />
          </Suspense>
        </View>
      ),
      onError() {},
      // The shell is on the wire; the boundary is not going to resolve for a
      // minute. Giving up here is what an abort deadline does, and the
      // document still has to close properly.
      onShellReady() {
        handle.abort();
      },
      response
    });

    expect(typeof handle.abort).toBe('function');

    const { html } = await response.done;
    expect(html).toContain('shell');
    expect(html).toContain('loading');
    expect(html.endsWith('</div></body></html>')).toBe(true);
  });
});
