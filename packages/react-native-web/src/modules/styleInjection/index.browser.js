/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Streaming-SSR CSS injection — the browser/native stand-in.
 *
 * Substituted for `./index.js` by the `browser` field map in
 * `package.json`, so that bundling the package for a browser or native
 * target does not drag `node:stream` (or, through it, the whole SSR path)
 * into the output. `../asyncContext` splits the same way and for the same
 * reason.
 *
 * There is no useful degradation available: the value this returns would be
 * a Node `stream.Transform`, and nothing here can produce one. So it throws.
 * Reaching this file at runtime means either a browser bundle called a
 * server-only API, or a non-Node server runtime resolved the `browser`
 * condition — in which case pipe the framework's own stream and drive
 * `StyleSheet.takeShellHTML()` / `StyleSheet.takeDeltaHTML()` by hand.
 */

export type StyleInjectionOptions = {
  epilogue?: ?string,
  nonce?: ?string,
  prelude?: ?(shellHTML: string) => string,
  ...
};

export default function createStyleInjectionTransform(
  options?: StyleInjectionOptions
): empty {
  throw new Error(
    'react-native-web: createStyleInjectionTransform() is a Node server API ' +
      'and is not available in this build. It wraps a node:stream Transform ' +
      "around React's renderToPipeableStream output. On a runtime without " +
      'node:stream, call StyleSheet.takeShellHTML() and ' +
      'StyleSheet.takeDeltaHTML() directly from your own stream plumbing.'
  );
}
