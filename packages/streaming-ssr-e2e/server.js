'use strict';

/**
 * A plain `node:http` streaming-SSR server for the Playwright harness.
 *
 * It follows the end-to-end example in
 * packages/react-native-web/STREAMING-SSR.md as closely as a test harness
 * can, and consumes the *built* package (`main` -> dist/cjs/index.js) the
 * way a real consumer would rather than reaching into src.
 *
 * Routes
 *   GET /health           liveness probe for Playwright's `webServer`
 *   GET /env              `{ react }`, so a spec can branch on the major
 *   GET /client.js        the esbuild browser bundle
 *   GET /?delay&gate      shell + late Suspense boundary, hydrated into #root
 *   GET /one-call?…       the same page, through `renderToStreamingResponse`
 *                         instead of the hand-wired transform
 *   GET /document?…       the whole document rendered through React and
 *                         hydrated with `hydrateRoot(document, …)`
 *   GET /streaming-head?… the same, but `<head>` itself is inside the stream:
 *                         a Suspense boundary in `<head>` (or, with
 *                         `above=1`, above it) and the style anchors coming
 *                         from `<StyleSheet.Anchors />` rather than from a
 *                         snapshot taken before the render
 *
 * Query parameters
 *   delay       ms the Suspense boundary takes to resolve on the server (0)
 *   anchors     `shell` renders <StyleSheet.Anchors> above the head boundary
 *               (the recommended shape); anything else puts it inside
 *   headDelay   ms the `<head>` boundary takes, on /streaming-head (120).
 *               Must stay well under `delay`, or the body boundary's CSS
 *               would be compiled before the shell is serialised and the
 *               cross-chunk cascade would not be under test at all.
 *   above       `1` puts the boundary ABOVE `<head>`, so the whole `<html>`
 *               element comes out of it
 *   gate        `1` makes the boundary refuse to hydrate until the spec
 *               calls `window.__RELEASE_DETAILS__()`
 *   boot        ms to hold the client bundle back, so a spec can pin the
 *               order of "deltas land" against "hydration starts"
 *   shellHooks  `1` also puts useWindowDimensions / useColorScheme ABOVE
 *               the Suspense boundary
 *   broken      ms to blank the group-3 style anchor for: a synthetic FOUC,
 *               used only as the negative control for the FOUC detector
 *
 * Set `E2E_REACT_DIR` to run the whole harness against another React; see
 * build.js.
 */

const fs = require('node:fs');
const http = require('node:http');

const { CLIENT_BUNDLE, NODE_BUNDLE, build } = require('./build.js');

// Everything below comes out of the app bundle, so that one esbuild
// resolution decides which React the process uses. In the default build
// react, react-dom and the library are `external` there, so this is Node's
// own resolution of `@edkimmel/react-native-web` -> `main` ->
// dist/cjs/index.js, exactly as a consumer gets it.
let React;
let renderToPipeableStream;
let AppRegistry;
let Appearance;
let Dimensions;
let StyleSheet;
let runInRequestScope;
// From `@edkimmel/react-native-web/server`, not the top-level barrel: the
// server-only half of the SSR surface lives behind its own entry point.
let createStyleInjectionTransform;
let renderToStreamingResponse;
let takeHydrationStateHTML;

// ---------------------------------------------------------------------------
// The deliberate server/browser divergence.
//
// Playwright drives Chromium at 1280x720 with `colorScheme: 'light'` (see
// playwright.config.js). The server declares 1024x768 and 'dark' on purpose.
//
// If the two agreed, every hydration assertion in the suite would pass
// vacuously: "the boundary rendered the server's values" and "the boundary
// rendered the browser's values" would be the same string, and a
// `getServerSnapshot` that wrongly returned the live client value would be
// indistinguishable from a correct one. The divergence is the measurement.
// ---------------------------------------------------------------------------
const SERVER_VIEWPORT = { fontScale: 1, height: 768, scale: 1, width: 1024 };
const SERVER_COLOR_SCHEME = 'dark';

const PORT = Number(process.env.E2E_PORT || 4321);
const ABORT_AFTER_MS = 15000;

let app = null;
let clientBundleSource = '';

// ---------------------------------------------------------------------------
// Per-request style values.
//
// The delta channel is derived from the sheet's revision log, so a rule that
// an earlier request already compiled arrives in the *next* request's shell,
// not in its delta ("it stops happening once the app is warm"). That is
// correct behaviour and it would quietly hollow out the cascade test, which
// only means something while the group-2 shorthand is genuinely arriving
// after <head> was flushed. Giving every request its own values keeps the
// delta non-empty for the whole run; the cascade spec additionally asserts
// that a group-2 delta element really was emitted, so a wrap-around fails
// loudly instead of passing for the wrong reason.
// ---------------------------------------------------------------------------
let requestSeq = 0;

function nextStyleValues(options) {
  const n = requestSeq++;
  return {
    pad: 5 + (n % 400),
    shellHooks: options.shellHooks,
    tint: `rgb(${n % 200}, ${Math.floor(n / 200) % 200}, 128)`
  };
}

function serializeConfig(value) {
  // client.js reproduces this string exactly for the document route.
  return `window.__E2E__=${JSON.stringify(value).replace(/</g, '\\u003c')}`;
}

// `takeHydrationStateHTML()` hands back a complete <script> element, which is
// what you inline into a string prelude. The document route needs the inner
// source instead, because React renders the element.
function unwrapScript(html) {
  return html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
}

function readOptions(url) {
  return {
    above: url.searchParams.get('above') === '1',
    // Where <StyleSheet.Anchors> goes on /streaming-head: 'shell' renders it
    // above the head boundary (recommended), 'late' inside it.
    anchorMode: url.searchParams.get('anchors') === 'shell' ? 'shell' : 'late',
    delay: Math.max(0, Number(url.searchParams.get('delay') || 0)),
    headDelay: Math.max(
      0,
      url.searchParams.has('headDelay')
        ? Number(url.searchParams.get('headDelay'))
        : 120
    ),
    // Hold the client bundle back by this many ms, so a spec can be sure
    // hydration starts only after the streamed chunks have all landed.
    boot: Math.max(0, Number(url.searchParams.get('boot') || 0)),
    // Negative control for the FOUC detector. See sabotage() below.
    broken: Math.max(0, Number(url.searchParams.get('broken') || 0)),
    gate: url.searchParams.get('gate') === '1',
    // Put the device hooks above the Suspense boundary too. Off by default.
    shellHooks: url.searchParams.get('shellHooks') === '1'
  };
}

function onRenderError(error) {
  console.error('[e2e] render error:', error && error.stack);
}

// A deliberate flash, so the FOUC spec can prove its own detector works.
// Blanks the group-3 anchor (which holds the shell probe's background and
// height) for a while, right after <head> is parsed. Nothing in the library
// does this; it exists only to be caught.
function sabotage(options) {
  if (options.broken === 0) return '';
  return (
    '<script>(function(){' +
    'var s=document.querySelector(\'style[data-rnw-group="3"]\');' +
    'var t=s.textContent;s.textContent="";' +
    `setTimeout(function(){s.textContent=t;},${options.broken});` +
    '})();</script>'
  );
}

function bootstrapScripts(options) {
  return [options.boot > 0 ? `/client.js?boot=${options.boot}` : '/client.js'];
}

function armAbort(res, abort) {
  const timer = setTimeout(abort, ABORT_AFTER_MS);
  res.on('close', () => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Route 1: shell + late boundary, hydrated into #root.
// ---------------------------------------------------------------------------
function renderRoot(res, options) {
  // Everything — the render AND the piping it sets up — inside the scope.
  runInRequestScope(() => {
    Dimensions.set({ screen: SERVER_VIEWPORT, window: SERVER_VIEWPORT });
    Appearance.set({ colorScheme: SERVER_COLOR_SCHEME });
    app.setRequestDelay(options.delay);

    const appProps = nextStyleValues(options);
    const config = { appProps, gate: options.gate, route: 'root' };
    // A nonce is threaded through so the CSP path is exercised. No
    // Content-Security-Policy header is sent: React's own inline reveal
    // scripts would need one too, and that is React's plumbing, not this
    // package's.
    const nonce = `e2e-nonce-${requestSeq}`;

    const { element } = AppRegistry.getApplication('App', {
      initialProps: appProps
    });

    const injector = createStyleInjectionTransform({
      epilogue: '</div></body></html>',
      nonce,
      prelude: (shellCSS) =>
        '<!doctype html><html lang="en"><head>' +
        '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width">' +
        '<title>RNW streaming SSR e2e</title>' +
        // The hydration snapshot sits next to the CSS shell, which is the
        // documented placement. The transform does not emit it.
        takeHydrationStateHTML({ nonce }) +
        `<script nonce="${nonce}">${serializeConfig(config)}</script>` +
        shellCSS +
        sabotage(options) +
        '</head><body><div id="root">'
    });

    const { abort, pipe } = renderToPipeableStream(element, {
      bootstrapScripts: bootstrapScripts(options),
      onError: onRenderError,
      onShellError() {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><p>shell error</p>');
      },
      onShellReady() {
        res.statusCode = 200;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // Destination first, then hand the injector to React.
        injector.pipe(res);
        pipe(injector);
      }
    });

    armAbort(res, abort);
  });
}

// ---------------------------------------------------------------------------
// Route 2: the whole document through React, hydrated with
// `hydrateRoot(document, …)`.
// ---------------------------------------------------------------------------
function renderDocument(res, options) {
  runInRequestScope(() => {
    Dimensions.set({ screen: SERVER_VIEWPORT, window: SERVER_VIEWPORT });
    Appearance.set({ colorScheme: SERVER_COLOR_SCHEME });
    app.setRequestDelay(options.delay);

    const appProps = nextStyleValues(options);

    // Taken before the render, not from a prelude, because React owns <head>
    // on this route and the head elements must exist as React elements by
    // the time the tree is built. Every shell rule is already compiled (all
    // of it is module scope), and taking the shell moves the delta watermark
    // synchronously, so whatever the boundary compiles later still arrives
    // as a delta.
    const hydrationJs = unwrapScript(takeHydrationStateHTML());
    const styles = StyleSheet.takeShellGroups();
    const config = {
      appProps,
      gate: options.gate,
      groups: styles.map(([group]) => group),
      hydrationJs,
      route: 'document'
    };

    const element = React.createElement(app.DocumentApp, {
      appProps,
      bootstrapJs: serializeConfig(config),
      hydrationJs,
      styles
    });

    // No `prelude`: React writes the document, doctype included. The
    // transform still handles every delta after that.
    const injector = createStyleInjectionTransform();

    const { abort, pipe } = renderToPipeableStream(element, {
      bootstrapScripts: bootstrapScripts(options),
      onError: onRenderError,
      onShellError() {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><p>shell error</p>');
      },
      onShellReady() {
        res.statusCode = 200;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        injector.pipe(res);
        pipe(injector);
      }
    });

    armAbort(res, abort);
  });
}

// ---------------------------------------------------------------------------
// Route 3: the whole document through React with <head> ITSELF streaming.
//
// The difference from route 2 is one line and it is the whole point: no
// `StyleSheet.takeShellGroups()` here. There is no moment before the render at
// which a snapshot would be right, because `<head>` has not rendered yet — so
// the anchors are `<StyleSheet.Anchors />`, which reads the sheet during its
// own render, wherever in the stream that turns out to be.
// ---------------------------------------------------------------------------
function renderStreamingHead(res, options) {
  runInRequestScope(() => {
    Dimensions.set({ screen: SERVER_VIEWPORT, window: SERVER_VIEWPORT });
    Appearance.set({ colorScheme: SERVER_COLOR_SCHEME });
    app.setRequestDelay(options.delay);
    app.setRequestDelay(options.headDelay, options.above ? 'document' : 'head');

    const appProps = nextStyleValues(options);

    // The hydration snapshot is still taken up front: it is device state, not
    // CSS, and it has to be in the document before any boundary hydrates.
    const hydrationJs = unwrapScript(takeHydrationStateHTML());
    const config = {
      above: options.above,
      anchorMode: options.anchorMode,
      appProps,
      gate: options.gate,
      hydrationJs,
      route: 'streaming-head'
    };

    const element = React.createElement(app.StreamingHeadApp, {
      above: options.above,
      anchorMode: options.anchorMode,
      appProps,
      bootstrapJs: serializeConfig(config),
      hydrationJs
    });

    const injector = createStyleInjectionTransform();

    const { abort, pipe } = renderToPipeableStream(element, {
      bootstrapScripts: bootstrapScripts(options),
      onError: onRenderError,
      onShellError() {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><p>shell error</p>');
      },
      onShellReady() {
        res.statusCode = 200;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        injector.pipe(res);
        pipe(injector);
      }
    });

    armAbort(res, abort);
  });
}

// ---------------------------------------------------------------------------
// Route 4: the same page as route 1, produced by the one-call adapter.
//
// Byte-for-byte equivalence with route 1 is not the claim and is not
// asserted — the adapter writes its own <head> skeleton. What this route is
// for is that the arrangement route 1 spells out by hand, and the orderings
// its comments warn about, come out right when the library owns them: the
// shell in <head>, the late boundary's CSS as a delta, the device snapshot
// the boundaries hydrate against.
//
// The outer `runInRequestScope` is not ceremony either. `setRequestDelay`
// keeps its per-request gate in scoped state, so it has to be set inside a
// scope — and the adapter is documented to adopt an open one rather than
// nest inside it. This route is where that composition is exercised.
// ---------------------------------------------------------------------------
function renderOneCall(res, options) {
  runInRequestScope(() => {
    app.setRequestDelay(options.delay);

    const appProps = nextStyleValues(options);
    // `route: 'root'` on purpose: the client half of this route is route
    // 1's, unchanged. The adapter's output has to be something the ordinary
    // client entry can hydrate.
    const config = { appProps, gate: options.gate, route: 'root' };
    const nonce = `e2e-nonce-${requestSeq}`;

    const { element } = AppRegistry.getApplication('App', {
      initialProps: appProps
    });

    // Headers the adapter does not own are set before the call; it only
    // takes the status line and Content-Type, at onShellReady.
    res.setHeader('Cache-Control', 'no-store');

    renderToStreamingResponse({
      abortAfterMs: ABORT_AFTER_MS,
      bootstrapScripts: bootstrapScripts(options),
      colorScheme: SERVER_COLOR_SCHEME,
      element,
      head:
        '<meta name="viewport" content="width=device-width">' +
        '<title>RNW streaming SSR e2e — one call</title>' +
        `<script nonce="${nonce}">${serializeConfig(config)}</script>` +
        sabotage(options),
      nonce,
      onError: onRenderError,
      response: res,
      viewport: SERVER_VIEWPORT
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Which React the harness is running against. Some behaviours genuinely
  // differ by major — a Suspense boundary above <head> is supported on 19
  // and produces a nested <!doctype> inside a <div hidden> on 18 — and a
  // spec that has to branch should branch on a measured fact rather than on
  // an env var the runner may or may not have set.
  if (url.pathname === '/env') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ react: React.version }));
    return;
  }

  if (url.pathname === '/client.js') {
    const wait = Math.max(0, Number(url.searchParams.get('boot') || 0));
    setTimeout(() => {
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/javascript; charset=utf-8'
      });
      res.end(clientBundleSource);
    }, wait);
    return;
  }

  if (url.pathname === '/streaming-head') {
    renderStreamingHead(res, readOptions(url));
    return;
  }

  if (url.pathname === '/document') {
    renderDocument(res, readOptions(url));
    return;
  }

  if (url.pathname === '/one-call') {
    renderOneCall(res, readOptions(url));
    return;
  }

  if (url.pathname === '/') {
    renderRoot(res, readOptions(url));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

build()
  .then(() => {
    // eslint-disable-next-line
    app = require(NODE_BUNDLE);
    ({ React, renderToPipeableStream } = app);
    ({ AppRegistry, Appearance, Dimensions, StyleSheet, runInRequestScope } =
      app.rnw);
    ({
      createStyleInjectionTransform,
      renderToStreamingResponse,
      takeHydrationStateHTML
    } = app.rnwServer);
    clientBundleSource = fs.readFileSync(CLIENT_BUNDLE, 'utf8');
    AppRegistry.registerComponent('App', () => app.App);
    server.listen(PORT, '127.0.0.1', () => {
      console.log(
        `[e2e] listening on http://127.0.0.1:${PORT} ` +
          `(react ${React.version})`
      );
    });
  })
  .catch((error) => {
    console.error('[e2e] build failed:', error);
    process.exit(1);
  });
