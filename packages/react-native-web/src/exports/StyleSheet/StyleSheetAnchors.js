/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Node } from 'react';

import React from 'react';
import StyleSheet from './index';
import canUseDOM from '../../modules/canUseDom';
import { drainDeltaQueue } from './dom/ingestDelta';
import { findShellAnchors } from './dom/createCSSStyleSheet';
import { getScopedState, hasRequestScope } from '../../modules/asyncContext';

export type StyleSheetAnchorsProps = { nonce?: ?string, ... };

/**
 * The stylesheet shell as React elements, read at *render* time.
 *
 * Published as `StyleSheet.Anchors` rather than as a top-level
 * `StyleSheetAnchors` export: it is a StyleSheet concern, the top-level
 * barrel is otherwise entirely react-native's surface, and `StyleSheet` is
 * the name the RNW babel plugin can rewrite to a deep import. The file keeps
 * its own name (and the component its own `displayName`) so stack traces and
 * devtools still say what it is; the attachment is at the bottom of
 * `./index.js`.
 *
 * ## What it is for
 *
 * There are four spellings of one emission and they differ only in when the
 * sheet is read and who owns the resulting nodes:
 *
 *   StyleSheet.takeShellHTML()      raw HTML, for a caller assembling the
 *                                   document as a string
 *   StyleSheet.takeShellGroups()    `[group, cssText]` pairs
 *   AppRegistry…getStyleElements()  React elements, snapshot taken by the
 *                                   caller before the render
 *   <StyleSheet.Anchors />          React elements, snapshot taken during
 *                                   its own render
 *
 * The first three all require the caller to hold the snapshot before React
 * starts rendering `<head>`. That is fine while `<head>` is static. It stops
 * working the moment `<head>` itself streams — a Suspense boundary inside it,
 * or one above it — because then the anchors have to exist as React elements
 * wherever the app puts them, including inside a boundary that has not
 * resolved when the caller would have had to take the snapshot.
 *
 * Rendering the snapshot is also strictly *more complete*: a component inside
 * a suspended boundary renders after the boundary resolved, so it sees every
 * rule compiled up to that point rather than every rule compiled before the
 * render began. Whatever it misses is exactly what the delta channel carries.
 *
 * ## The invariant, and why it also resets the watermark
 *
 * Every rule must end up in exactly one of the shell or a later delta —
 * never both, never neither. `takeShellGroups()` serialises the whole
 * cumulative sheet and moves this request's delta watermark to the sheet's
 * current revision in the same synchronous step, so:
 *
 *   - nothing lands in neither: a rule compiled before this render is in the
 *     text below; one compiled after is past the watermark and arrives as a
 *     delta;
 *   - nothing lands in both: the watermark is the exact revision this text
 *     was taken at, so no delta can re-send what is already here.
 *
 * Not resetting would be the worse failure of the two. On a document route
 * there is no `prelude`, so `createStyleInjectionTransform` never calls
 * `takeShellHTML()` and nothing else would move the watermark: the first
 * delta would then re-send the entire sheet, duplicating every rule in the
 * anchors' CSSOM.
 *
 * ## Fizz can render this more than once
 *
 * If a sibling inside the same Suspense boundary suspends *after* this
 * component ran, Fizz discards the boundary's segment and retries the whole
 * thing. The snapshot is therefore cached in request-scoped state, so a
 * retry re-emits byte-identical anchors and the watermark stays pinned to
 * the revision those bytes were taken at. Without the cache the second
 * attempt would move the watermark forward while the first attempt's bytes
 * were the ones that already went out — the "in neither" half of the
 * invariant. Outside a request scope there is no delta channel at all, so
 * the snapshot is simply re-read.
 *
 * ## …which is why the cache has to tell a retry from a second instance
 *
 * A second `<StyleSheet.Anchors />` in one document duplicates every anchor —
 * the cascade inversion `DUPLICATE_SHELL` describes — and it is the only
 * spelling of the shell that can be duplicated *by accident*, because it is
 * the only one that composes: a layout and a page both rendering it, a
 * shared `<Head>`, a copy-pasted route. So it is the one spelling that most
 * needs the duplicate-shell guard, and a cache keyed on "have we taken a
 * snapshot yet" is exactly what stops it reaching it.
 *
 * `useId` is the discriminator. React derives it from the component's
 * position in the tree, which is what makes it survive a Fizz retry (the
 * retry re-renders the same component at the same position, so hydration
 * ids have to agree) while differing between two instances (that is what it
 * is *for* — it has to be unique enough to be a DOM id). A cache hit from an
 * id already seen is a retry and is silent; a cache hit from a new id is a
 * second shell and is announced through `takeShellGroups()`, the same entry
 * point the other three spellings warn from. The cached bytes are still what
 * is returned: a retry must stay byte-identical, and there is nothing better
 * to hand the duplicate anyway.
 *
 * ## On the client it mirrors the document, it does not re-read the sheet
 *
 * Hydration compares `dangerouslySetInnerHTML` against the DOM, so the client
 * has to reproduce the server's text exactly. Re-reading the client sheet
 * would not: it has been hydrated from the anchors and added to at runtime.
 * Reading each anchor's own `innerHTML` is exact by construction, and it stays
 * exact however many rules a streamed chunk has `insertRule`d into the
 * element, because `insertRule` never writes back to an element's text.
 *
 * A client-only render (no server anchors at all) renders nothing here and
 * lets RNW's runtime create the anchors on demand, which is what it does for
 * an app that never had a shell. There is no hydration in that case, so there
 * is nothing for a runtime-created node to skew.
 */

const ANCHORS_KEY = 'StyleSheet.anchors';

type AnchorsState = {|
  groups: ?Array<[number, string]>,
  // The `useId` of every instance that has taken (or been handed) the
  // snapshot. A repeat visit from an id already here is a Fizz retry; a
  // visit from a new id is a second `<StyleSheet.Anchors />`.
  instances: Set<string>
|};

function readServerGroups(instanceId: string): Array<[number, string]> {
  if (!hasRequestScope()) return StyleSheet.takeShellGroups();
  const state = getScopedState<AnchorsState>(ANCHORS_KEY, () => ({
    groups: null,
    instances: new Set()
  }));
  const cached = state.groups;
  if (cached != null) {
    if (!state.instances.has(instanceId)) {
      state.instances.add(instanceId);
      // A second instance really is a second serialisation of the shell, so
      // it is announced as one — through the public entry point rather than
      // a private flag, so all four spellings share a single guard instead
      // of three plus an exception. The result is thrown away: the bytes
      // have to remain the cached ones (a retry of the first instance must
      // still be byte-identical), and with the watermark pinned by the
      // first shell this call moves nothing.
      StyleSheet.takeShellGroups();
    }
    return cached;
  }
  state.instances.add(instanceId);
  const groups = StyleSheet.takeShellGroups();
  state.groups = groups;
  return groups;
}

// The document's shell anchors, read once per page.
//
// Memoised because this component's own output matches the selector it
// reads: a `<style data-rnw-group>` that is neither a delta nor a runtime
// anchor is indistinguishable from one the server sent, and nothing in the
// DOM records which React tree put it there. So any render in which a new
// instance's `useState` initializer runs while a previous instance's anchors
// are still mounted — a concurrent transition, an offscreen pre-render, an
// error-boundary reset, all of which render the replacement before
// committing the removal — reads 2N anchors and renders 2N, with duplicate
// keys and a `<head>` twice the size it should be. Reading once is also
// simply more honest: an anchor's text is fixed for the life of the
// document, so there is nothing a later read could learn.
//
// Only a non-empty read is latched. An empty one is the client-only case
// (no server anchors, RNW's runtime owns the sheet), and caching it would
// make that answer permanent for a page whose anchors had merely not been
// reached yet.
//
// The latch is released when the anchors it describes leave the document,
// which is the only event that can change the answer — a document whose
// shell has been torn out is a different document, and the elements are
// kept for exactly that test rather than re-querying, since the query is
// what cannot be trusted here.
let clientAnchors: ?Array<HTMLElement> = null;
let clientGroups: ?Array<[number, string]> = null;

function readClientGroups(): Array<[number, string]> {
  const cached = clientGroups;
  const cachedAnchors = clientAnchors;
  if (
    cached != null &&
    cachedAnchors != null &&
    cachedAnchors.every((element) => element.isConnected)
  ) {
    return cached;
  }
  // Shell anchors only. RNW's own sheet boots when the client bundle
  // evaluates, which on a streaming `<head>` is before the server's anchors
  // have arrived, so by now `<head>` may also contain runtime anchors this
  // library created. Mirroring those back to React would render `<style>`
  // elements the server never sent — duplicate keys, a hydration mismatch,
  // and a client re-render of the whole document.
  const anchors = findShellAnchors(document);
  const groups = anchors.map(([group, element]) => [group, element.innerHTML]);
  if (groups.length > 0) {
    clientAnchors = anchors.map(([, element]) => element);
    clientGroups = groups;
  }
  return groups;
}

// `useInsertionEffect` is React's hook for writing styles into the document:
// it runs during the commit, before layout effects and before the browser
// can paint, which is what a still-pending delta needs. It is a no-op in
// Fizz on both supported majors, so it is safe on the server. The fallback
// is only for a host that predates it.
const useAnchorsCommitted =
  // $FlowFixMe[prop-missing] — React 18+ only
  typeof React.useInsertionEffect === 'function'
    ? React.useInsertionEffect
    : React.useEffect;

// `useId` is also React 18+. On a host without it every instance reports the
// same id, which collapses to the old behaviour — a second instance is taken
// for a retry and does not warn — rather than to a false positive. Resolved
// once at module scope so the hook call site is unconditional.
const useAnchorInstanceId: () => string =
  // $FlowFixMe[prop-missing] — React 18+ only
  typeof React.useId === 'function' ? React.useId : () => '';

let warnedRuntimeAnchors = false;

/**
 * Report the one `<head>` shape this library cannot repair from the inside.
 *
 * RNW's sheet boots when the client bundle evaluates. When the anchors are
 * inside the `<head>` boundary they have not arrived at that point, so the
 * sheet has nowhere to put the rules it is compiling and
 * `createGroupStyleElement` creates `<style data-rnw-runtime>` of its own —
 * as `head.firstChild`, which is a `<style>` React did not render sitting
 * where React expects its own first `<head>` child. That is precisely the
 * shape a streamed delta was changed to refuse to create; the runtime
 * cannot make the same choice, because a delta that waits is applied later
 * by somebody else whereas a rule the sheet declines to place is simply
 * never placed (`groupedInsert` returning false un-records it).
 *
 * This component's commit is the moment the situation becomes knowable: if
 * `<StyleSheet.Anchors>` is mounted then React owns the anchors, so a
 * `data-rnw-runtime` element in `<head>` is a foreign node inside a subtree
 * React is hydrating. Gated on React 18 because 18 is where it is harmful:
 * React 18's hydration cannot walk past a `<style>` where it expected a
 * `<meta>`, and the whole document silently falls back to client rendering.
 * React 19 skips a foreign node whose tag does not match, so the same DOM is
 * benign there and warning would be noise.
 *
 * There is nothing to fix at runtime — the alternative to creating the node
 * was dropping the rules — so this names the two arrangements that avoid the
 * window entirely.
 */
function warnIfRuntimeAnchorsSkewHydration(): void {
  if (warnedRuntimeAnchors) return;
  const major = parseInt(React.version, 10);
  if (major !== 18) return;
  const head = document.head;
  if (head == null) return;
  const runtime = head.querySelectorAll(
    'style[data-rnw-group][data-rnw-runtime]'
  );
  if (runtime.length === 0) return;
  warnedRuntimeAnchors = true;
  console.error(
    'react-native-web: this library created ' +
      runtime.length +
      ' <style> element(s) in <head> before the document anchors ' +
      'arrived, and React 18 cannot hydrate past a <style> it did not ' +
      'render — the document falls back to client rendering, silently. ' +
      'Render <StyleSheet.Anchors /> above the <head> Suspense boundary ' +
      'rather than inside it, so the anchors go out in the first flush, or ' +
      'load the client bundle after <head> has streamed. React 19 skips ' +
      'these elements and is unaffected.'
  );
}

export default function StyleSheetAnchors(
  props?: ?StyleSheetAnchorsProps
): Node {
  if (process.env.NODE_ENV !== 'production') {
    if (props != null && (props: any).id != null) {
      throw new Error(
        'react-native-web: <StyleSheet.Anchors> applies its props to every ' +
          'emitted <style>, so "id" would produce duplicate ids. The group ' +
          'number already identifies each element via its data-rnw-group ' +
          'attribute.'
      );
    }
  }

  // Identifies this instance across Fizz retries. See "…which is why the
  // cache has to tell a retry from a second instance" above. Unused on the
  // client, where the document rather than the sheet is the source.
  const instanceId = useAnchorInstanceId();

  // Captured once per instance. On the client the value can never change —
  // an anchor's text is fixed for the life of the document — but freezing it
  // also means a re-render can never add or remove a `<head>` child, which
  // is the mutation this whole design exists to avoid.
  const [groups] = React.useState(() =>
    canUseDOM ? readClientGroups() : readServerGroups(instanceId)
  );

  // The anchors are in the document as of this commit. Any chunk that ran
  // while they were still streaming left its rules queued rather than
  // creating a `<style>` of its own; this is the signal that they can now be
  // applied. Cheap and idempotent when the queue is empty, which is the
  // common case.
  useAnchorsCommitted(() => {
    drainDeltaQueue();
    if (process.env.NODE_ENV !== 'production') {
      warnIfRuntimeAnchorsSkewHydration();
    }
  }, []);

  return groups.map(([group, text]) => (
    <style
      {...props}
      dangerouslySetInnerHTML={{ __html: text }}
      data-rnw-group={String(group)}
      key={`rnw-group-${group}`}
    />
  ));
}
