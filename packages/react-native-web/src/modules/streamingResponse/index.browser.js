/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * `renderToStreamingResponse` — the browser/native stand-in.
 *
 * Substituted for `./index.js` by the `browser` field map in `package.json`,
 * for the same reason `../styleInjection` and `../asyncContext` split that
 * way: bundling the package for a browser or native target must not drag
 * `node:stream` — or, here, `react-dom/server` — into the output.
 *
 * There is no useful degradation. It streams a Node `http.ServerResponse`
 * through a `node:stream` Transform; neither exists here. So it throws,
 * loudly, at the call rather than at some later byte.
 */

// Declared here rather than re-exported from `./index.js`, so that nothing
// in this file names the module the `browser` field exists to keep out.
export type StreamingResponseOptions = {
  element: mixed,
  response: Object,
  ...
};

export type StreamingResponseHandle = {| abort: () => void |};

export default function renderToStreamingResponse(
  options: StreamingResponseOptions
): empty {
  throw new Error(
    'react-native-web: renderToStreamingResponse() is a Node server API and ' +
      'is not available in this build. It streams React through a ' +
      'node:stream Transform into an http.ServerResponse. On a runtime ' +
      'without node:stream, call StyleSheet.takeShellHTML() and ' +
      "StyleSheet.takeDeltaHTML() from your framework's own stream hooks."
  );
}
