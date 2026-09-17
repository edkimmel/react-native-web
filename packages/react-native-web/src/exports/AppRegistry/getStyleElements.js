/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Node } from 'react';

import React from 'react';
import StyleSheet from '../StyleSheet';
import { getScopedState, hasRequestScope } from '../../modules/asyncContext';

export type StyleFormat = 'grouped' | 'legacy';

/**
 * Props applied to every emitted `<style>`. `nonce` is the one that matters
 * in practice (CSP), but anything valid on a `<style>` and safe to repeat
 * across N sibling elements is allowed. `id` is not: see below.
 */
export type StyleElementProps = { nonce?: ?string, ... };

// ---------------------------------------------------------------------------
// Mixing guard
//
// The two SSR formats are mutually exclusive within one document. The client
// already refuses to guess: `StyleSheet/dom`'s `detectMode` throws in
// development when it finds both per-group anchors and the legacy
// `#react-native-stylesheet`, because their relative cascade order is
// undefined. In production it cannot afford to throw, so it silently picks
// one and mis-cascades.
//
// This guard is the server-side half of that same rule, reported at the call
// that creates the problem rather than at the client that inherits it. Like
// the client precedent it is development-only.
//
// Scoping: when the render is wrapped in `runInRequestScope` the flags live
// in that request's state, so two concurrent requests never see each other's
// choice. Outside a scope they fall back to state local to a single
// `getApplication()` result, which is the unit an SSR caller destructures
// both accessors out of. A process-wide flag would be wrong: one process may
// legitimately serve a grouped page and a legacy page.
// ---------------------------------------------------------------------------

const REQUEST_FORMAT_KEY = 'AppRegistry.styleFormat';

type FormatState = {| emitted: Set<StyleFormat> |};

function createFormatState(): FormatState {
  return { emitted: new Set() };
}

/**
 * Build the per-`getApplication()` recorder that both style accessors call
 * before emitting anything.
 */
export function createStyleFormatGuard(): (format: StyleFormat) => void {
  const localState = createFormatState();

  return function recordStyleFormat(format: StyleFormat): void {
    if (process.env.NODE_ENV === 'production') {
      return;
    }
    const state = hasRequestScope()
      ? getScopedState<FormatState>(REQUEST_FORMAT_KEY, createFormatState)
      : localState;
    state.emitted.add(format);
    if (state.emitted.size > 1) {
      throw new Error(
        'react-native-web: this render emitted both the grouped stylesheet ' +
          '(getStyleElements) and the legacy single stylesheet ' +
          '(getStyleElement). Their relative cascade order is undefined, so ' +
          'this is never safe, and a document containing both is rejected by ' +
          'the client. Emit one or the other.'
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Grouped style elements
// ---------------------------------------------------------------------------

/**
 * The server sheet in the fork's grouped format: one `<style
 * data-rnw-group="G">` per compiler group, ascending, as an array of keyed
 * React elements. Render the array into `<head>`.
 *
 * This is the streaming-compatible counterpart to `getStyleElement`. It goes
 * through `StyleSheet.takeShellGroups()` rather than reading the sheet
 * directly, so it inherits that function's two load-bearing properties
 * verbatim:
 *
 *   - EVERY group is emitted, including empty ones. The empty elements are
 *     the anchors a later streamed chunk inserts its delta against. A chunk
 *     that finds no anchor for its group applies nothing: it queues its
 *     rules and they stay invisible until RNW's client runtime boots and
 *     drains them, so a missing anchor turns a parser-only guarantee into a
 *     JS-dependent one.
 *   - The per-request delta watermark is reset synchronously with the
 *     snapshot, so no rule can land in neither the shell nor a later delta.
 *
 * The array is returned rather than a fragment because a fragment hides the
 * elements from the caller: SSR pipelines commonly count, slice or interleave
 * them (a nonce audit, splitting `<head>` across chunks). Both render
 * identically under `renderToString` / `renderToStaticMarkup`, and the
 * elements are keyed so React does not warn about the array.
 */
export default function getStyleElements(
  props?: ?StyleElementProps
): Array<Node> {
  if (process.env.NODE_ENV !== 'production') {
    if (props != null && (props: any).id != null) {
      throw new Error(
        'react-native-web: getStyleElements() applies its props to every ' +
          'emitted <style>, so "id" would produce duplicate ids. The group ' +
          'number already identifies each element via its data-rnw-group ' +
          'attribute.'
      );
    }
  }

  // `nonce` is applied as a React prop rather than baked into the shell
  // string, so React escapes it once and it never round-trips through an
  // HTML attribute and back.
  return StyleSheet.takeShellGroups().map(([group, text]) => (
    <style
      {...props}
      dangerouslySetInnerHTML={{ __html: text }}
      data-rnw-group={String(group)}
      key={`rnw-group-${group}`}
    />
  ));
}
