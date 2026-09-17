/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * One call that streams a React tree into a Node HTTP response with this
 * package's streaming-SSR plumbing already wired correctly.
 *
 * WHY THIS EXISTS. Everything it does was already possible with
 * `runInRequestScope` + `createStyleInjectionTransform` +
 * `takeHydrationStateHTML`, and the guide's end-to-end example is exactly
 * this code written out by hand. But that example is ~45 lines in which the
 * *order* of four calls is load-bearing and every way of getting it wrong
 * fails silently — see "Gotchas" in STREAMING-SSR.md. This collapses the
 * documented arrangement into one call so those orderings are not the
 * caller's to get right:
 *
 *   - the request scope wraps the render AND the `onShellReady` handler that
 *     pipes it, not just the render;
 *   - `injector.pipe(response)` runs before `pipe(injector)`, so React's
 *     end-of-pass flush signal reaches the response (and any compression
 *     stream between the two) from the very first pass;
 *   - the piping happens from `onShellReady`, so the shell render has
 *     finished compiling CSS before the shell is serialised;
 *   - the shell goes out through the transform rather than around it, as
 *     UTF-8, so the anchor gate opens and deltas actually stream;
 *   - exactly one shell is emitted, and the hydration snapshot is in the
 *     document before any boundary can hydrate against it.
 *
 * TWO DOCUMENT MODES, AND THE DEFAULT IS THE STRING ONE.
 *
 * By default this writes the document around the app: doctype, `<html>`,
 * `<head>` (built from the `head` string), the stylesheet shell, the
 * hydration snapshot, `<body>`, the root div, and the closing tags. React
 * renders only what goes inside the root div.
 *
 * With `renderDocument: true` it writes none of that. The element is
 * expected to render `<html>`/`<head>`/`<body>` itself, so React's metadata
 * hoisting has a real `<head>` to hoist into and `hydrateRoot(document, …)`
 * has a whole document to hydrate. Everything else this function owns — the
 * request scope, the per-request device state, the transform, the pipe
 * order, the abort deadline, the status line — is identical.
 *
 * What moves to the caller in that mode, and it is exactly three things:
 *
 *   - the stylesheet anchors, as `<StyleSheet.Anchors />` in `<head>`,
 *     above every Suspense boundary in it. This is not a convenience: the
 *     anchors have to be elements React rendered, because a `<style>` in a
 *     React-owned `<head>` that React did not render mis-binds hydration
 *     silently. See "Rendering <head> through React" in the guide.
 *   - the hydration snapshot, as
 *     `<script dangerouslySetInnerHTML={{ __html: takeHydrationStateScript() }} />`.
 *   - the doctype, which React writes for you as soon as the tree renders
 *     `<html>`.
 *
 * `head`, `lang` and `rootId` describe the prologue that no longer exists,
 * so passing one alongside `renderDocument` is rejected at the call site
 * rather than ignored. An ignored `head` is a `<title>` that vanishes from
 * a page that still renders, which is the failure shape this whole file was
 * written to avoid.
 *
 *     renderToStreamingResponse({
 *       element: <Document />,      // renders <html><head>…</head><body>…
 *       renderDocument: true,
 *       response: res,
 *       bootstrapScripts: ['/client.js']
 *     });
 *
 * `renderDocument` does NOT imply a Suspense boundary above `<html>`. If the
 * tree has one, React >= 19.1 is a hard floor — 19.0 and 18 emit a document
 * that is not a document. See "React version support" in the guide.
 *
 * There is no Web Streams variant, for the reason recorded in
 * `../styleInjection`.
 *
 * COMPOSING WITH YOUR OWN SCOPE. If a request scope is already open, this
 * uses it instead of opening a nested one — a nested scope would be seeded
 * from the process defaults and would discard whatever the outer scope had
 * set. So per-request state this function has no option for goes in an outer
 * `runInRequestScope`:
 *
 *     runInRequestScope(() => {
 *       Dimensions.set({ screen, window });   // asymmetric screen/window
 *       renderToStreamingResponse({ element, response: res });
 *     });
 *
 * Usage:
 *
 *     import { renderToStreamingResponse } from 'react-native-web/server';
 *
 *     app.get('/*', (req, res) => {
 *       renderToStreamingResponse({
 *         element: AppRegistry.getApplication('App', {}).element,
 *         response: res,
 *         head: '<title>App</title><meta name="viewport" ' +
 *               'content="width=device-width">',
 *         bootstrapScripts: ['/client.js'],
 *         colorScheme: req.cookies.theme === 'dark' ? 'dark' : 'light',
 *         viewport: { fontScale: 1, height: 800, scale: 1, width: 1024 },
 *         nonce: res.locals.cspNonce
 *       });
 *     });
 */

import type { Node as ReactNode } from 'react';
import type { ColorSchemeName } from '../../exports/Appearance';
import type { DisplayMetrics } from '../../exports/Dimensions';

import { renderToPipeableStream } from 'react-dom/server';
import Appearance from '../../exports/Appearance';
import Dimensions from '../../exports/Dimensions';
import createStyleInjectionTransform from '../styleInjection';
import { hasRequestScope, runInRequestScope } from '../asyncContext';
import { takeHydrationStateHTML } from '../hydrationState';

export type StreamingResponseOptions = {
  // Milliseconds before the render is aborted, so a boundary that never
  // resolves cannot hold the response open forever. `0` disables the timer.
  abortAfterMs?: ?number,
  bootstrapModules?: ?Array<string>,
  bootstrapScripts?: ?Array<string>,
  // This request's color scheme, as `Appearance.set({ colorScheme })`.
  colorScheme?: ?ColorSchemeName,
  // The tree to render. Typically `AppRegistry.getApplication(…).element`.
  element: ReactNode,
  // Markup for `<head>`, placed after the charset and before this package's
  // hydration snapshot and stylesheet shell. `<title>`, the viewport meta,
  // link tags — everything the document needs that React does not render.
  // Not valid with `renderDocument`.
  head?: ?string,
  // `lang` on `<html>`. Not valid with `renderDocument`.
  lang?: ?string,
  // CSP nonce. Applied to every <style> and <script> this package emits and
  // passed to React for its bootstrap scripts.
  nonce?: ?string,
  onAllReady?: ?() => void,
  // Every error React reports, recoverable ones included. Defaults to
  // `console.error`; pass a function to route them somewhere real.
  onError?: ?(error: mixed, errorInfo?: mixed) => void,
  // Called when the shell itself failed, before anything has been written.
  // The default sends a minimal 500. A replacement owns the response.
  onShellError?: ?(error: mixed) => void,
  // Called after the response has been piped and the first bytes are on
  // their way, for logging or metrics.
  onShellReady?: ?() => void,
  // The element renders `<html>`/`<head>`/`<body>` itself, so this emits no
  // prologue and no epilogue of its own. See "TWO DOCUMENT MODES" above for
  // the three things that then become the caller's.
  renderDocument?: ?boolean,
  // The Node `http.ServerResponse` (or any writable stream) to stream into.
  response: Object,
  // `id` of the div the app is rendered into, and the one the client passes
  // to `AppRegistry.runApplication({ rootTag })`. Not valid with
  // `renderDocument`: React owns the body there, root div included.
  rootId?: ?string,
  status?: ?number,
  // This request's viewport, applied to both `screen` and `window`. For
  // different values per key, call `Dimensions.set` in an outer scope.
  viewport?: ?DisplayMetrics,
  ...
};

export type StreamingResponseHandle = {|
  // React's abort, for a caller that wants to give up early.
  abort: () => void
|};

const DEFAULT_ABORT_AFTER_MS = 10000;
const DEFAULT_ROOT_ID = 'root';
const DEFAULT_LANG = 'en';

// Both are interpolated into an HTML attribute, so neither may be the thing
// that ends it. Validating instead of escaping keeps the failure at the call
// site, where the mistake is: these are developer constants, not user input,
// and a `rootId` that needed escaping would not survive `getElementById`
// on the client anyway.
const VALID_ROOT_ID = /^[A-Za-z][A-Za-z0-9_:.-]*$/;
const VALID_LANG = /^[A-Za-z0-9-]+$/;

function required<T>(value: ?T, name: string, expected: string): T {
  if (value == null) {
    throw new TypeError(
      `react-native-web: renderToStreamingResponse() requires \`${name}\` (${expected}).`
    );
  }
  return value;
}

export default function renderToStreamingResponse(
  options: StreamingResponseOptions
): StreamingResponseHandle {
  const opts: StreamingResponseOptions =
    options != null ? options : (({}: $FlowFixMe): StreamingResponseOptions);

  const element = required(opts.element, 'element', 'the React tree to render');
  const response = required(
    opts.response,
    'response',
    'the Node http.ServerResponse to stream into'
  );

  const renderDocument = opts.renderDocument === true;

  // Rejected rather than ignored. All three describe the prologue this
  // function writes, and in `renderDocument` mode there is no prologue: a
  // `head` that goes nowhere is a `<title>` missing from a page that still
  // renders and still returns 200, which is precisely the class of silent
  // failure this wrapper exists to make impossible. Named individually so
  // the message says which one to move into the tree.
  if (renderDocument) {
    const ignored = ['head', 'lang', 'rootId'].filter(
      (name) => (opts: $FlowFixMe)[name] != null
    );
    if (ignored.length > 0) {
      throw new TypeError(
        'react-native-web: renderToStreamingResponse() got ' +
          ignored.map((name) => `\`${name}\``).join(' and ') +
          ' together with `renderDocument`, which writes no document of its ' +
          'own. Render that content in the tree instead: `head` becomes ' +
          'elements in <head> (with <StyleSheet.Anchors /> above every ' +
          'Suspense boundary there), `lang` becomes <html lang>, and ' +
          '`rootId` becomes whatever wrapper the tree puts around the app.'
      );
    }
  }

  const rootId = opts.rootId != null ? opts.rootId : DEFAULT_ROOT_ID;
  if (!VALID_ROOT_ID.test(rootId)) {
    throw new TypeError(
      `react-native-web: renderToStreamingResponse() got an invalid \`rootId\` (${rootId}). ` +
        'It becomes an HTML id attribute, so it must start with a letter and ' +
        'contain only letters, digits and "_", ":", ".", "-".'
    );
  }

  const lang = opts.lang != null ? opts.lang : DEFAULT_LANG;
  if (!VALID_LANG.test(lang)) {
    throw new TypeError(
      `react-native-web: renderToStreamingResponse() got an invalid \`lang\` (${lang}). ` +
        'It becomes the lang attribute on <html>, so it must be a BCP 47 tag ' +
        'such as "en" or "pt-BR".'
    );
  }

  const nonce = opts.nonce;
  const head = opts.head != null ? opts.head : '';
  const abortAfterMs =
    opts.abortAfterMs != null ? opts.abortAfterMs : DEFAULT_ABORT_AFTER_MS;

  // Opening a nested scope would seed a fresh store from the process
  // defaults and throw away everything the outer one set, so an open scope
  // is used as-is. See "COMPOSING WITH YOUR OWN SCOPE" above.
  return hasRequestScope() ? render() : runInRequestScope(render);

  function render(): StreamingResponseHandle {
    if (opts.viewport != null) {
      Dimensions.set({ screen: opts.viewport, window: opts.viewport });
    }
    if (opts.colorScheme != null) {
      Appearance.set({ colorScheme: opts.colorScheme });
    }

    // With `renderDocument` there is no prologue and no epilogue: React
    // writes the doctype and every tag. Omitting `prelude` is also what
    // switches the transform onto its anchor byte-scan, which is the gate
    // that has to hold once the anchors are React's markup rather than
    // ours — see trap 6 in `../styleInjection`. The shell is then taken by
    // `<StyleSheet.Anchors />` during its own render instead of here.
    const injector = renderDocument
      ? createStyleInjectionTransform({ nonce })
      : createStyleInjectionTransform({
          epilogue: `</div></body></html>`,
          nonce,
          // Runs once, immediately before React's first byte. Taking the
          // shell here — the latest moment before any body markup — is what
          // puts every rule the shell render compiled into <head> as plain
          // <style>, leaving the delta channel carrying only what a later
          // boundary adds.
          prelude: (shellCSS) =>
            `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
            head +
            // The device-state snapshot every boundary hydrates against.
            // Before the shell only for readability; it needs to be anywhere
            // in <head>, and the transform deliberately does not emit it
            // itself.
            takeHydrationStateHTML({ nonce }) +
            shellCSS +
            `</head><body><div id="${rootId}">`
        });

    const { abort, pipe } = renderToPipeableStream(element, {
      bootstrapModules: opts.bootstrapModules,
      bootstrapScripts: opts.bootstrapScripts,
      nonce,
      onAllReady: opts.onAllReady,
      onError(error: mixed, errorInfo?: mixed) {
        if (opts.onError != null) {
          opts.onError(error, errorInfo);
        } else {
          console.error(error);
        }
      },
      onShellError(error: mixed) {
        if (opts.onShellError != null) {
          opts.onShellError(error);
          return;
        }
        // Nothing has been written yet, so the status line is still ours.
        response.statusCode = 500;
        if (typeof response.setHeader === 'function') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
        response.end(
          '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
            '<title>Error</title></head><body><p>Something went wrong.' +
            '</p></body></html>'
        );
      },
      onShellReady() {
        response.statusCode = opts.status != null ? opts.status : 200;
        if (typeof response.setHeader === 'function') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
        // Destination first, then React. The transform consumes React's
        // per-pass `flush()` in order to inject there, and can only forward
        // it to destinations it already knows about — so a `response` piped
        // second would not see the first pass flushed, and a compression
        // stream in between would sit on the shell until the next boundary
        // resolved. This is the ordering the whole wrapper exists to own.
        injector.pipe(response);
        pipe(injector);
        if (opts.onShellReady != null) opts.onShellReady();
      }
    });

    if (abortAfterMs > 0) {
      const timer = setTimeout(abort, abortAfterMs);
      // Node's `Timeout` is unref-able and Flow's `TimeoutID` does not say
      // so. Unref'd because this deadline is a backstop for a boundary that
      // never resolves, not a reason to keep a process alive: the open
      // socket already does that for as long as the response is real.
      const unref = (timer: $FlowFixMe).unref;
      if (typeof unref === 'function') unref.call(timer);
      if (typeof response.on === 'function') {
        response.on('close', () => {
          clearTimeout(timer);
          // A client that went away mid-response leaves React rendering for
          // nobody. `writableEnded` is true on an ordinary completion, so
          // this only fires on a real disconnect.
          if (response.writableEnded !== true) abort();
        });
      }
    }

    return { abort };
  }
}
