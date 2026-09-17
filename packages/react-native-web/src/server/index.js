/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

/**
 * `react-native-web/server` — the parts of the SSR surface that only ever run
 * on a server.
 *
 * WHY THIS EXISTS AS A SEPARATE ENTRY POINT. The top-level barrel is
 * react-native's API surface; every name in it has a react-native
 * counterpart, and the two this fork adds there (`runInRequestScope`,
 * `configureRequestScope`) are the ones an app calls where it *renders*.
 * Everything here is called where it *serves*: it belongs to the response,
 * not to the component tree, and a browser bundle has no use for any of it.
 *
 * `createStyleInjectionTransform` makes that structural rather than
 * conditional. It wraps a `node:stream` Transform, so the browser build of
 * `../modules/styleInjection` exists only to throw; keeping it out of the
 * barrel means a browser bundle no longer pulls the throwing stand-in in
 * merely for importing `View`. The `browser` field map in `package.json`
 * still covers the `dist/modules/styleInjection` paths, so a bundler that
 * does reach this entry from a browser target gets the same stand-in it
 * always did — this moves the wall, it does not remove the old one.
 *
 * Resolution is the package's `exports` map, and it has to be. A checked-in
 * `server/package.json` directory shim — the way `react-dom/server` did it
 * before `exports` maps — resolves for `require()` and for every bundler, but
 * Node's ESM resolver does no directory and no `main`-field resolution for a
 * bare-specifier subpath, so `import … from 'react-native-web/server'` in a
 * native `"type": "module"` server fails with ERR_UNSUPPORTED_DIR_IMPORT. The
 * shim still ships as the fallback for toolchains that ignore `exports`.
 *
 * The map pays for that with package-wide encapsulation, so the deep
 * `dist/…` imports consumers and this repo's babel plugin emit are enumerated
 * there explicitly; see "Entry points" in STREAMING-SSR.md for what that
 * costs and why the condition ladders on `.` and `./server` must match.
 *
 *     import { renderToPipeableStream } from 'react-dom/server';
 *     import { runInRequestScope } from 'react-native-web';
 *     import {
 *       createStyleInjectionTransform,
 *       takeHydrationStateHTML
 *     } from 'react-native-web/server';
 */

export type { StyleInjectionOptions } from '../modules/styleInjection';
export type { HydrationStateOptions } from '../modules/hydrationState';
export type {
  StreamingResponseHandle,
  StreamingResponseOptions
} from '../modules/streamingResponse';
export type {
  PipeWorkerResponseHandle,
  PipeWorkerResponseOptions,
  WorkerResponseOptions
} from '../modules/workerBridge';

// Streaming SSR, in one call: opens the request scope, applies this
// request's device state, builds the document head around the stylesheet
// shell and the hydration snapshot, and pipes React into the response in the
// order the transform needs. It is the documented end-to-end example with
// the orderings owned by the library instead of the caller; reach past it to
// `createStyleInjectionTransform` when React renders `<head>` itself.
export { default as renderToStreamingResponse } from '../modules/streamingResponse';

// Streaming SSR. Returns a Node `stream.Transform` to pipe
// `renderToPipeableStream` through: it emits the shell stylesheet ahead of
// React's first byte and splices each Suspense boundary's newly compiled CSS
// in at React's own chunk boundaries. Must be called inside
// `runInRequestScope`.
export { default as createStyleInjectionTransform } from '../modules/styleInjection';

// Streaming SSR out of a worker thread, for a render CPU-bound enough to
// block the event loop. An http.ServerResponse cannot cross a thread
// boundary — its socket is a handle — so `createWorkerResponse` stands in for
// it inside the worker and `pipeWorkerResponse` writes the bytes on the main
// thread. The pair exists because the obvious hand-rolled version drops
// React's per-pass flush signal and has no backpressure at all, both
// silently; see the module comment.
export {
  createWorkerResponse,
  isWorkerResponseMessage,
  pipeWorkerResponse
} from '../modules/workerBridge';

// Hydration state. `takeHydrationStateHTML` returns a <script> tag carrying
// this request's device state (viewport, color scheme) to the client, where
// it becomes the frozen snapshot every Suspense boundary hydrates against —
// however late it hydrates. Deliberately independent of the CSS shell: the
// app decides where the tag goes. `registerHydrationState` lets a downstream
// SSR helper put its own `getScopedState` state into the same snapshot.
// `takeHydrationStateScript` is the same payload without the `<script>`
// wrapper, for a `<head>` React renders: there the tag has to be a React
// element, so the app wants the source text and not markup.
export {
  registerHydrationState,
  takeHydrationStateHTML,
  takeHydrationStateScript
} from '../modules/hydrationState';

// The scope accessors downstream SSR helpers build their own per-request
// state on. They read the scope `runInRequestScope` opened; on the client
// they would answer for a process-wide singleton, which is a question only
// server code has a reason to ask.
export {
  getProcessState,
  getScopedState,
  hasRequestScope
} from '../modules/asyncContext';
