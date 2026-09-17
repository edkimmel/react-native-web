/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `renderToStreamingResponse({ renderDocument: true })` — the mode in which
 * the element renders `<html>`/`<head>`/`<body>` and the adapter writes no
 * markup of its own.
 *
 * WHY THE MODE EXISTS. React only hoists `<title>`/`<meta>`/`<link>` into a
 * real `<head>` element it is rendering. With the string `head` the adapter
 * has already written `</head>` before React's first byte, so hoisted
 * metadata lands in `<body>` — measured, and not a defect anything here can
 * repair: once `</head>` is on the wire it is closed. An app that wants
 * React's metadata (or `hydrateRoot(document, …)`) has to own the document,
 * and until now owning it meant giving up everything else this wrapper does
 * and re-deriving the pipe order by hand.
 *
 * WHAT IS ACTUALLY UNDER TEST. Not the CSS format and not the anchor gate —
 * both have their own suites in `../../styleInjection/__tests__`. These pin
 * the three things the mode itself decides: that no adapter markup is
 * emitted, that omitting `prelude` still leaves a streaming delta channel
 * (i.e. the anchor scan is reached, rather than every delta falling through
 * to `_flush`), and that the default mode is untouched.
 *
 * TRAP: the node jest config sets `fakeTimers.enableGlobally`, which fakes
 * `setImmediate` — the primitive Fizz schedules every flush pass with.
 *
 * TRAP: the compiled stylesheet is process-wide and dedups by declaration,
 * so a value an earlier test already used produces no delta at all.
 */

import * as React from 'react';
import { Suspense } from 'react';
import { Writable } from 'node:stream';

import StyleSheet from '../../../exports/StyleSheet';
import View from '../../../exports/View';
import renderToStreamingResponse from '..';
import { takeHydrationStateScript } from '../../hydrationState';

jest.useRealTimers();
beforeEach(() => {
  jest.useRealTimers();
});

let seed = 7100;
const uniq = () => seed++;

/** The opening of a streamed chunk's self-removing inline script. */
const DELTA_SCRIPT = /<script(?: nonce="[^"]*")?>\(function\(\)\{var w=window/;
/** The attribute that makes a `<style>` a group anchor. */
const ANCHOR = 'data-rnw-group="';

/**
 * A stand-in for `http.ServerResponse` that also remembers what had been
 * written at the end of each write — which is what lets a test ask what was
 * in the FIRST flush rather than only what the whole response contains.
 */
function createResponse() {
  const chunks = [];
  const writes = [];
  const headers = {};
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
  response.setHeader = (name, value) => {
    headers[name.toLowerCase()] = value;
  };
  response.on('finish', () => {
    settle({
      firstWrite: writes.length > 0 ? writes[0] : '',
      headers,
      html: Buffer.concat(chunks).toString('utf8'),
      statusCode: response.statusCode,
      writes
    });
  });
  // $FlowFixMe - test double
  response.statusCode = 0;
  // $FlowFixMe - test double
  response.done = done;
  return response;
}

/** Suspends on first render, resolves `delay` ms later. */
function createSuspendingComponent(renderResolved, delay = 15) {
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
 * The shape this mode is for, and the shape the Theseus spike uses: React
 * owns the document, `<head>` is entirely above the boundary, and the whole
 * app is inside one top-level `<Suspense>` so the shell is head plus
 * fallback.
 *
 * `<StyleSheet.Anchors />` goes above the boundary deliberately — the
 * anchors are the stylesheet, and behind a boundary the browser paints
 * before the CSS exists. See "Rendering <head> through React" in
 * STREAMING-SSR.md.
 */
function Document({ children, fallback, title }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{title}</title>
        <script
          dangerouslySetInnerHTML={{ __html: takeHydrationStateScript() }}
        />
        <StyleSheet.Anchors />
      </head>
      <body>
        <div id="app">
          <Suspense fallback={fallback}>{children}</Suspense>
        </div>
      </body>
    </html>
  );
}

describe('renderToStreamingResponse({ renderDocument: true })', () => {
  test('emits no markup of its own — React writes the whole document', async () => {
    const Late = createSuspendingComponent(() => (
      <LateView style={{ marginTop: uniq() }} />
    ));
    const response = createResponse();

    renderToStreamingResponse({
      element: (
        <Document fallback={<View />} title="Doc">
          <Late />
        </Document>
      ),
      renderDocument: true,
      response
    });

    const { html, statusCode } = await response.done;

    expect(statusCode).toBe(200);
    // React's doctype, not the adapter's — and exactly one of each, which is
    // the assertion that fails if the prologue is ever emitted here too.
    expect(html.split('<!DOCTYPE html>').length - 1).toBe(1);
    expect(html.split('<html').length - 1).toBe(1);
    expect(html.split('</html>').length - 1).toBe(1);
    // The adapter's own root div, and its epilogue's `</body>`. React closes
    // the document once, at the end of the shell; a second `</body>` is the
    // epilogue having been emitted as well. (The epilogue's full literal
    // `</div></body></html>` cannot be asserted against directly — the tree
    // itself renders a div that React closes in exactly that sequence.)
    expect(html).not.toContain('<div id="root">');
    expect(html.split('</body>').length - 1).toBe(1);
    // …and the tree's own document markup is all there.
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<div id="app">');
  });

  test('the first flush is a complete <head> plus the fallback', async () => {
    // The point of the whole exercise: with the app behind one top-level
    // boundary, everything above it — title, metadata, the stylesheet — is
    // on the wire before any of the app's data has resolved.
    const Late = createSuspendingComponent(
      () => <View dataSet={{ testid: 'resolved' }} />,
      40
    );
    const response = createResponse();

    renderToStreamingResponse({
      element: (
        <Document title="Early">
          <Suspense fallback={<View dataSet={{ testid: 'fallback' }} />}>
            <Late />
          </Suspense>
        </Document>
      ),
      renderDocument: true,
      response
    });

    const { firstWrite, html } = await response.done;

    // Vacuity: the boundary really did resolve later in the response.
    expect(html).toContain('data-testid="resolved"');
    expect(firstWrite).not.toContain('data-testid="resolved"');

    // The shell: a closed <head> carrying the title and the anchors, and the
    // fallback in <body>.
    expect(firstWrite).toContain('<title>Early</title>');
    expect(firstWrite).toContain(ANCHOR);
    expect(firstWrite).toContain('window.__RNW_HYDRATION__=');
    expect(firstWrite.indexOf('</head>')).toBeGreaterThan(
      firstWrite.indexOf('<title>')
    );
    expect(firstWrite).toContain('data-testid="fallback"');
  });

  test('a boundary that resolves late still streams its CSS as a delta', async () => {
    // Without a `prelude` the transform falls back to scanning the byte
    // stream for an anchor, because the shell is now React's markup and not
    // its own. If that path is not reached — or the anchors never render —
    // every delta is withheld to `_flush` and the whole response's CSS
    // arrives in one lump at the very end. This is the assertion that the
    // mode is actually streaming and not merely producing a correct
    // document.
    //
    // Two boundaries resolving at different times are what make the two
    // outcomes distinguishable. `</html>` cannot: React closes the document
    // at the end of the SHELL and appends every later boundary's markup and
    // script after it, so a delta streamed at the right moment is after
    // `</html>` too. What only streaming can produce is the first
    // boundary's rules ahead of the second boundary's markup.
    const first = uniq();
    const second = uniq();
    const Early = createSuspendingComponent(
      () => <LateView style={{ marginTop: first }} />,
      15
    );
    const Late = createSuspendingComponent(
      () => <LateView style={{ marginTop: second }} />,
      80
    );
    const response = createResponse();

    renderToStreamingResponse({
      element: (
        <Document fallback={<View />} title="Delta">
          <Early />
          <Suspense fallback={<View />}>
            <Late />
          </Suspense>
        </Document>
      ),
      renderDocument: true,
      response
    });

    const { html } = await response.done;

    const anchorAt = html.indexOf(ANCHOR);
    const firstDeltaAt = html.indexOf(`margin-top:${first}px`);
    const secondMarkupAt = html.indexOf('id="S:1"');

    expect(anchorAt).toBeGreaterThan(-1);
    expect(html.search(DELTA_SCRIPT)).toBeGreaterThan(-1);
    // The rules the boundaries compiled are in deltas, not in the shell: the
    // anchors went out before either of them existed.
    expect(html.indexOf('</head>')).toBeLessThan(firstDeltaAt);
    // Vacuity: the second boundary really did stream separately.
    expect(secondMarkupAt).toBeGreaterThan(-1);
    // The assertion. Withheld to `_flush`, the first boundary's rules would
    // be behind the second boundary's markup, at the end of the response.
    expect(firstDeltaAt).toBeGreaterThan(anchorAt);
    expect(firstDeltaAt).toBeLessThan(secondMarkupAt);
    // …and the second boundary's own rules are in the response as well.
    expect(html).toContain(`margin-top:${second}px`);
  });

  test('applies the nonce to the delta it emits', async () => {
    const Late = createSuspendingComponent(() => (
      <LateView style={{ marginTop: uniq() }} />
    ));
    const response = createResponse();

    renderToStreamingResponse({
      element: (
        <Document fallback={<View />} title="Nonce">
          <Late />
        </Document>
      ),
      nonce: 'abc123',
      renderDocument: true,
      response
    });

    const { html } = await response.done;
    const deltaAt = html.search(DELTA_SCRIPT);
    expect(deltaAt).toBeGreaterThan(-1);
    expect(html.slice(deltaAt, deltaAt + 40)).toContain('nonce="abc123"');
  });

  test('rejects the options that describe the prologue it no longer writes', () => {
    // Ignoring these is the failure this throw exists for: a `head` that
    // goes nowhere is a <title> missing from a page that still returns 200.
    const base = {
      element: <Document fallback={null} title="x" />,
      renderDocument: true,
      response: createResponse()
    };

    expect(() =>
      renderToStreamingResponse({ ...base, head: '<title>x</title>' })
    ).toThrow(/`head`.*`renderDocument`/s);
    expect(() => renderToStreamingResponse({ ...base, lang: 'fr' })).toThrow(
      /`lang`/
    );
    expect(() => renderToStreamingResponse({ ...base, rootId: 'app' })).toThrow(
      /`rootId`/
    );
    // All three at once are named in one message, so a caller fixes them in
    // one pass rather than three.
    let message = '';
    try {
      renderToStreamingResponse({
        ...base,
        head: '<title>x</title>',
        lang: 'fr',
        rootId: 'app'
      });
    } catch (error) {
      message = String(error.message);
    }
    expect(message).toContain('`head`');
    expect(message).toContain('`lang`');
    expect(message).toContain('`rootId`');
  });

  test('the default mode still writes the document itself', async () => {
    // The regression guard. `renderDocument` is opt-in and everything about
    // the string-`head` path — prologue, hydration snapshot, shell, root div,
    // epilogue — has to be exactly what it was.
    const response = createResponse();

    renderToStreamingResponse({
      element: <View dataSet={{ testid: 'app' }} />,
      head: '<title>Default</title>',
      response
    });

    const { html } = await response.done;

    expect(html.startsWith('<!doctype html><html lang="en"><head>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8"><title>Default</title>');
    expect(html).toContain('window.__RNW_HYDRATION__=');
    expect(html).toContain(ANCHOR);
    expect(html).toContain('<body><div id="root">');
    expect(html.endsWith('</div></body></html>')).toBe(true);
  });
});
