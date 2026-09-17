/**
 * Copyright (c) Nicolas Gallagher.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import { atomic, classic, inline, orderedGroups } from './compiler';
import { createSheet } from './dom';
import { localizeStyle } from './localizeStyle';
import { preprocess } from './preprocess';
import { styleq } from 'styleq';
import { validate } from './validate';
import canUseDOM from '../../modules/canUseDom';
import StyleSheetAnchors from './StyleSheetAnchors';
import { getScopedState, hasRequestScope } from '../../modules/asyncContext';

const staticStyleMap: WeakMap<Object, Object> = new WeakMap();
const sheet = createSheet();

// ---------------------------------------------------------------------------
// Per-request delta tracking
//
// On the server, callers wrap each SSR render in `runInRequestScope`. Any rule
// inserted into the process-wide sheet during the scope is also pushed into a
// per-request delta buffer here, so the streaming pipeline can emit only the
// rules that landed during the current chunk. Outside any scope (client,
// legacy two-pass renderer, module-load time on the server) this is a no-op
// and the shared sheet behaves exactly as upstream.
// ---------------------------------------------------------------------------

const REQUEST_DELTA_KEY = 'StyleSheet.delta';

type RequestDelta = {|
  // The sheet revision this request's client has been brought up to date
  // with: everything recorded at or before it has already been sent, in the
  // shell dump or in an earlier chunk. Starts at 0 — a client that has
  // received nothing is behind everything.
  revision: number,
  // Whether this request has already serialised a shell. A second shell is
  // a verbatim copy of the first, so emitting both into one document
  // duplicates every group anchor — see the warning in `takeShellGroups`.
  emittedShell: boolean,
  // Groups for which a `[stylesheet-group="N"]{}` marker rule has already
  // been emitted in a prior flush during this request. Subsequent flushes
  // skip the marker for these groups; only the new content is emitted.
  // Used by `takeRequestDelta`'s marker format only — `takeDeltaHTML`
  // carries the group as a field of its script payload instead.
  emittedGroupMarkers: Set<number>
|};

function createRequestDelta(): RequestDelta {
  return {
    emittedGroupMarkers: new Set(),
    emittedShell: false,
    revision: 0
  };
}

function encodeGroupMarker(group: number): string {
  return `[stylesheet-group="${group}"]{}`;
}

/**
 * Everything recorded in the shared sheet since this request last flushed,
 * bucketed by group ascending, and advance the request's watermark past it.
 * Returns `[]` outside a request scope or when nothing has been added.
 *
 * Note what this deliberately does *not* do: it does not ask which rules
 * this request's own render inserted. It cannot — a lazily imported module
 * runs `StyleSheet.create` once per process, so for every request after the
 * first the rules its Suspense boundary needs were inserted by somebody
 * else's render and this request inserts nothing at all. Anything keyed on
 * "did I insert it?" therefore sends that request an empty delta and its
 * client renders the boundary unstyled.
 *
 * Sending everything added since the watermark can hand a request rules only
 * a concurrent request needed. That is the same imprecision `takeShellHTML`
 * already has — it dumps the whole process sheet to every client — and it
 * costs nothing once the app is warm, because then nothing is being added
 * and every delta is empty. Duplicate rules are inert on the client anyway:
 * ingest dedups by selector.
 */
function drainRequestDelta(): Array<[number, Array<string>]> {
  if (!hasRequestScope()) return [];
  const delta = getScopedState<RequestDelta>(
    REQUEST_DELTA_KEY,
    createRequestDelta
  );

  const revision = sheet.getRevision();
  if (revision <= delta.revision) return [];
  const added = sheet.getRulesSince(delta.revision);
  delta.revision = revision;

  const buckets: Map<number, Array<string>> = new Map();
  for (const [group, cssText] of added) {
    let bucket = buckets.get(group);
    if (bucket == null) {
      bucket = [];
      buckets.set(group, bucket);
    }
    bucket.push(cssText);
  }

  return Array.from(buckets.keys())
    .sort((a, b) => a - b)
    .map((group) => [group, (buckets.get(group): any)]);
}

/**
 * Drain the current request's pending delta into a single CSS text fragment.
 * Returns an empty string if there is no active request scope or no pending
 * rules.
 *
 * This is the lower-level, marker-delimited form, kept for callers that
 * assemble their own `<style>` tags. The streaming pipeline uses
 * `takeDeltaHTML` instead, which needs no markers because it carries the
 * group alongside each bucket of rules in its script payload.
 *
 * Each group present in the delta is preceded by its `[stylesheet-group="N"]`
 * marker rule the first time it appears for the request; subsequent flushes
 * skip the marker because the client already knows the group exists.
 */
function takeRequestDelta(): string {
  const buckets = drainRequestDelta();
  if (buckets.length === 0) return '';
  const delta = getScopedState<RequestDelta>(
    REQUEST_DELTA_KEY,
    createRequestDelta
  );
  const out = [];
  for (const [group, rules] of buckets) {
    if (!delta.emittedGroupMarkers.has(group)) {
      out.push(encodeGroupMarker(group));
      delta.emittedGroupMarkers.add(group);
    }
    for (const rule of rules) {
      out.push(rule);
    }
  }
  return out.join('\n');
}

/**
 * Declare this request's client up to date with the sheet as it stands now,
 * so the delta channel carries only what arrives after this point. The
 * streaming pipeline calls this from `takeShellHTML`, which has just
 * serialised the whole sheet.
 *
 * Both calls are synchronous with no await between them, so the watermark
 * taken here matches exactly what the shell emitted. That is load-bearing:
 * a rule slipping in between would be in neither the shell nor any delta.
 */
function resetRequestDelta(): void {
  if (!hasRequestScope()) return;
  const delta = getScopedState<RequestDelta>(
    REQUEST_DELTA_KEY,
    createRequestDelta
  );
  delta.revision = sheet.getRevision();
  // Calling this IS declaring that the sheet as it stands has reached the
  // client — which is what `hasEmittedShell()` reports, so a caller who
  // serialises the sheet themselves (`getSheet()` into their own `<style>`,
  // a template engine, a non-React server) and then resets the watermark by
  // hand is recognised as having emitted a shell, exactly as
  // `takeShellHTML()` is. Set without warning: `takeShellGroups` has already
  // been through `markShellEmitted`, and warning again there would fire the
  // duplicate-shell error on every first emission.
  delta.emittedShell = true;
  // Note: we do not reset emittedGroupMarkers — once a marker has been emitted
  // for the request (e.g. inline in the shell dump's text), subsequent chunks
  // should not re-emit it.
}

// ---------------------------------------------------------------------------
// SSR injection helpers
//
// Higher-level helpers that return ready-to-inline HTML fragments. SSR
// adapters call these and embed the strings verbatim into the response.
// Adapters do NOT need to know:
//   - that the shell emits one `<style data-rnw-group="G">` per group
//   - that streamed chunks emit a single self-removing inline `<script>`
//     that inserts their rules into the anchors' CSSOM
//   - what that script contains, or the names of any window globals it
//     touches
// Those details are opaque to callers and may change without affecting
// adapter code, provided the produced HTML is treated as a single
// inert blob.
//
// Why per-group elements: RNW compiles CSS at runtime, so rules are
// discovered progressively and must be streamed across chunks — but they
// still need the priority order that makes longhands (group 3) beat the
// shorthands they override (group 2.x), regardless of which chunk each
// arrived in. Making each group a physically separate `<style>` in `<head>`,
// ascending, means priority is plain DOM order: no `@layer` (unsupported
// below Chrome 99 / Safari 15.4, and it fails by rendering *nothing*), no
// shorthand expansion, and no dependency on React's hoisting.
// ---------------------------------------------------------------------------

/**
 * A unique handle for one streamed chunk, used as the key of the replay
 * guard (`window.__RNW_DELTA_SEEN__`) the emitted script consults.
 *
 * The guard is **page**-scoped, and a page is not always one response. ESI
 * and SSI, a micro-frontend composition, a shell-plus-island architecture —
 * anything that concatenates the output of two `runInRequestScope` renders
 * into one document — puts two independent delta streams in front of one
 * `__RNW_DELTA_SEEN__`. A counter that restarts per request then hands both
 * streams a chunk claiming the same number, and the second one is discarded
 * as a replay: `if(!k[seq])` is false, so it inserts nothing AND never
 * reaches `__RNW_DELTA__`, which means the runtime does not apply it either.
 * Those rules are lost outright, silently, in production.
 *
 * So the handle is unique per *process run* rather than per request: a
 * monotonic counter (which covers every stream this process produces,
 * however they are composed) behind a random prefix (which covers the
 * fragments a second process produced). It is only ever compared for
 * equality — nothing reads it as an ordinal — so making it a string costs
 * nothing.
 *
 * The alphabet is `[0-9a-z]` by construction, which is what lets the script
 * embed it as a quoted key with no further escaping.
 */
const DELTA_SEQ_PREFIX = Math.random().toString(36).slice(2, 10);
const processWideSeq: { value: number } = { value: 0 };

function nextDeltaSeq(): string {
  processWideSeq.value += 1;
  return `${DELTA_SEQ_PREFIX}-${processWideSeq.value}`;
}

// Escape `</style` so a rule containing it can't break out of the
// surrounding <style> tag. Atomic rules don't contain this in practice
// but it's cheap to be safe.
function escapeForStyleTag(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

type EmitOptions = { nonce?: ?string, ... };

// Escape a value for an HTML double-quoted attribute.
function escapeForAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function nonceAttr(options: EmitOptions): string {
  const nonce = options.nonce;
  return nonce != null && nonce !== ''
    ? ` nonce="${escapeForAttr(nonce)}"`
    : '';
}

/**
 * Escape a JSON payload for embedding inside a `<script>` element.
 *
 * `JSON.stringify` already handles quotes, backslashes and control
 * characters, so the only thing left is HTML: an unescaped `<` lets a rule
 * containing `</script>` (or `<!--`) end the element early and inject
 * markup. `<` is the same character to the JS parser and inert to the
 * HTML tokenizer, so escaping every `<` closes both. U+2028/U+2029 are
 * legal in JSON strings but were line terminators in JS before ES2019, so
 * they are escaped too rather than relying on the engine being new enough.
 */
function escapeForScriptTag(json: string): string {
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Build the inline script a streamed chunk carries: the chunk's rules,
 * inserted straight into the CSSOM of the anchors the shell already put in
 * `<head>`, after which the script deletes itself.
 *
 * ## Why not a `<style>` element plus a relocation script
 *
 * The previous format streamed `<style data-rnw-group data-rnw-delta>` into
 * `<body>` and moved it into `<head>` behind its anchor. That works right up
 * until the app renders the whole document through React and calls
 * `hydrateRoot(document, …)`. React hydrates a parent's children by walking
 * DOM siblings in order, so the relocated elements — which React never
 * rendered — shift every anchor past the first insertion by one. React then
 * binds its group-3 fiber to the element sitting in group 2.2's slot. React
 * 18 logs one dev warning and leaves the DOM alone, so nothing looks wrong;
 * the damage is latent, and the next render of `<head>` writes group-3 rules
 * into a group-2.2 element — exactly the cascade inversion the anchors exist
 * to prevent. Production is silent about all of it.
 *
 * Inserting into the CSSOM leaves no node behind. Once the script has run
 * and removed itself the DOM is byte-identical to React's server output, so
 * there is nothing for hydration to skew against.
 *
 * ## Why it is still correct
 *
 *   - CASCADE POSITION IS STRONGER, NOT WEAKER. The rules live in the
 *     anchor's own sheet, so their bucket *is* the anchor's position in
 *     `<head>`. The old format depended on landing at the right offset
 *     among siblings; that dependency is what broke. Intra-group order
 *     stays irrelevant because styleq dedupes by property key, so two rules
 *     in one group never target the same property on the same element.
 *   - O(delta). `insertRule` parses one rule. (The `O(n^2)` warning the old
 *     comment carried was about appending to `textContent`, which re-parses
 *     the whole sheet — a different operation.)
 *   - IDEMPOTENT. Each chunk's script owns a unique sequence number and
 *     records it in `__RNW_DELTA_SEEN__`, so a deliberate replay of the
 *     source inserts nothing twice. The script also removes itself, so the
 *     parser can never run it twice on its own.
 *   - EVERY `insertRule` IS WRAPPED. The CSSOM rejects rules it does not
 *     understand (vendor prefixes, unknown pseudos) by throwing, and one
 *     bad rule must not drop the rest of the chunk.
 *   - NEEDS NO RNW RUNTIME. Registering the rules with the runtime is a
 *     separate, optional step: the queue is drained whenever RNW boots.
 *
 * ## The missing anchor: queue, never create
 *
 * The script used to create the missing `<style>` itself, on the reasoning
 * that a missing anchor meant no shell had been emitted and therefore no
 * React-owned `<head>` to skew. That reasoning has a hole: once the app
 * puts a Suspense boundary in or above `<head>`, the anchors are React
 * elements that simply have not streamed yet, and creating one there is
 * the single DOM shape measured to silently mis-bind
 * `hydrateRoot(document, …)` — a `<style>` React did not render, sitting
 * between `<style>` elements it did. React matches hydration candidates by
 * tag, empty `<style>` anchors are textually identical, so React binds its
 * fiber to the intruder and every later sibling shifts by one. Production
 * says nothing about it; the DOM is not repaired; the next render of
 * `<head>` writes one group's rules into another group's element.
 *
 * So the script applies nothing and leaves the payload in
 * `window.__RNW_DELTA__` flagged `p`, to be applied by RNW's client
 * runtime once an anchor exists. The queue is re-drained by every later
 * chunk, by RNW's sheet bootstrap, and by `<StyleSheet.Anchors>`'s own
 * commit — which is exactly the moment React has put the anchors in the
 * document. See `dom/ingestDelta.js`.
 *
 * Cost of the change: a chunk whose group has no anchor now needs JS to
 * become visible, where before it needed only the parser. That is not
 * reachable from the documented flow — every shell spelling
 * (`takeShellHTML`, `takeShellGroups`, `getStyleElements`,
 * `<StyleSheet.Anchors>`) emits an anchor for every group in
 * `orderedGroups`, empty ones included — so it takes a caller who streams
 * deltas having emitted no shell at all.
 *
 * ## JS disabled
 *
 * A delta only ever carries rules compiled *after* `takeShellHTML()`, which
 * the transform calls at the first flush following `onShellReady`. By
 * construction those rules can only style Suspense boundary content, and
 * React streams that inside a `<div hidden>` that nothing reveals without
 * its own inline `$RC` script. So a client that will not run this script
 * will not reveal the content it styles either, and the same argument
 * covers a CSP that blocks inline scripts — it blocks React's too. (A
 * caller who serialises the shell *before* the shell render, rather than
 * from the transform, moves shell rules into the first delta and does give
 * up the no-JS rendering of those. That is already a departure from the
 * documented flow, and it was already giving up their cascade position.)
 */
function deltaScript(seq: string, payloadJson: string): string {
  // The handle is a string, so it is embedded as a quoted key. Its alphabet
  // is `[0-9a-z-]` (see `nextDeltaSeq`), so `JSON.stringify` is a formality
  // rather than a defence — but it is the formality that keeps the quoting
  // correct if the handle's shape ever changes.
  const key = JSON.stringify(seq);
  return (
    '(function(){' +
    // `currentScript` is only valid synchronously, at the top of the IIFE.
    // Reading it from inside any callback yields null.
    'var w=window,d=document,s=d.currentScript,' +
    'k=w.__RNW_DELTA_SEEN__||(w.__RNW_DELTA_SEEN__={}),' +
    'q=w.__RNW_DELTA__||(w.__RNW_DELTA__=[]),' +
    `p=${payloadJson},i,j,b,r,a,h;` +
    // Everything after the declarations is guarded, and the self-removal is
    // in `finally`. The reachable thrower is `__RNW_INGEST_DELTA__` — RNW's
    // own hook, or whatever a page has put on that global — and a throw
    // there would otherwise strand this `<script>` in the DOM. In a
    // React-rendered `<head>` a stranded node is exactly the foreign-sibling
    // shape that mis-binds hydration, which is the thing this format exists
    // to avoid: the script would trade a bookkeeping failure for the
    // corruption it was designed to prevent. Rules are inserted and queued
    // before the hook runs, so swallowing costs only the bookkeeping.
    'try{' +
    `if(!k[${key}]){k[${key}]=1;` +
    'for(i=0;i<p.length;i++){b=p[i];r=b.r;' +
    // `:not([data-rnw-runtime])` — only the shell's own anchors. A runtime
    // anchor is one RNW created before the shell arrived; its position in
    // `<head>` is not the cascade bucket, so writing there would put this
    // chunk's rules in the wrong place. Queue instead; the runtime resolves
    // the right element when it applies them.
    "a=d.querySelector('style[data-rnw-group=\"'+b.g+'\"]" +
    ":not([data-rnw-delta]):not([data-rnw-runtime])');" +
    // `a.sheet` is null for an element the parser has not finished, so the
    // two conditions are one question: is there somewhere to write?
    'h=a&&a.sheet;' +
    'if(h){for(j=0;j<r.length;j++){' +
    'try{h.insertRule(r[j],h.cssRules.length)}catch(e){}}}' +
    // No anchor: mark the bucket pending and hand it to the runtime. See
    // "The missing anchor" above — creating the element here is the one
    // thing that reintroduces the hydration skew.
    'else{b.p=1;}' +
    'q.push(b);}' +
    'if(w.__RNW_INGEST_DELTA__)w.__RNW_INGEST_DELTA__();}' +
    '}catch(e){}finally{' +
    'if(s&&s.parentNode)s.parentNode.removeChild(s);}})();'
  );
}

/**
 * The full cumulative server sheet as `[group, cssText]` pairs, ascending —
 * the structured form of the shell, for callers that build their own
 * elements rather than inlining a string. `AppRegistry.getStyleElements()`
 * is the in-tree consumer; `takeShellHTML` below is the other.
 *
 * **Empty groups are included.** They are the anchors later chunks insert
 * their rules into. A chunk that finds no anchor for its group applies
 * nothing at all: it queues its rules (`deltaScript`'s `b.p=1` branch) and
 * they stay invisible until RNW's client runtime boots and drains them, so
 * an absent anchor turns a parser-only guarantee into a JS-dependent one.
 * That is also the exact trap both `@layer` and React's `precedence` fall
 * into for a bucket they have not seen before.
 *
 * `cssText` is already escaped for embedding in a `<style>` element, because
 * every consumer embeds it in one and `dangerouslySetInnerHTML` does no
 * escaping of its own. Escaping here rather than at each call site keeps one
 * source of truth for it.
 *
 * **`take`, not `get`.** This module spells a pure read `get*` and a read
 * that consumes something `take*`, and this is the most consuming call on
 * the surface: it marks the shell emitted and moves the delta watermark, so
 * it decides what every subsequent delta contains. It was `getShellGroups`
 * before it was ever documented; the name now matches the convention its
 * two neighbours (`takeShellHTML`, `takeDeltaHTML`) already follow.
 *
 * The FIRST call in a request also resets the per-request delta buffer:
 * anything dual-written during the shell render is already in this snapshot,
 * so subsequent chunks carry only rules added AFTER this point. Both calls
 * are synchronous with nothing between them, which is what makes the shell
 * and the delta channel exhaustive. A second call in the same request is a
 * bug the caller is told about and deliberately does NOT move the watermark
 * again — see the comment on the reset below.
 */
const DUPLICATE_SHELL =
  'react-native-web: this request serialised the stylesheet shell more than ' +
  'once. Each shell is the whole cumulative sheet, so a document containing ' +
  'two of them has two of every group anchor, and a streamed delta — whose ' +
  'rules go into the FIRST anchor for their group — then sits ahead of the ' +
  'second copy of every higher group, inverting the cascade the anchors ' +
  'exist to ' +
  'guarantee. Emit one shell per document: takeShellHTML(), takeShellGroups() ' +
  'and AppRegistry getStyleElements() are three spellings of the same ' +
  'emission, not three separate ones. Re-emitting deliberately (retrying ' +
  'after an aborted response, where the first shell never reached the wire) ' +
  'is fine and this warning can be ignored.';

/**
 * Record that this request has serialised a shell, and complain if it had
 * already done so. Returns true iff this was the FIRST shell of the request.
 *
 * ## Why this reports in production too
 *
 * A second shell cannot be made safe, only visible. Two anchor sets in one
 * document mean the second copy of group 2 sits *after* the first copy of
 * group 3, so a shorthand beats the longhand that is supposed to override
 * it — and that is true no matter what the second copy contains, because
 * the cascade reads DOM order, not intent. There is nothing to repair:
 * suppressing the second emission would break hydration for whichever
 * instance rendered it (the client mirrors the document, so it would render
 * anchors the server never sent), and the server cannot know which of the
 * two emissions the caller will actually put on the wire.
 *
 * Which leaves failing loudly, and a dev-only warning is not loud enough:
 * the symptom is a page that renders with some rules silently outranked by
 * others, which is exactly the class of bug nobody reproduces locally. The
 * production signal is deliberately `console.error` rather than a throw —
 * by the time this fires the response is usually already on the wire, and
 * aborting a half-written document is worse than mis-cascading it. The
 * legitimate case (re-emitting after an aborted response) is named in the
 * message so it can be ignored knowingly rather than silently.
 */
function markShellEmitted(): boolean {
  // Only meaningful per request. Outside a scope this state is a process
  // singleton, so the second render in a long-lived client or test process
  // would trip the warning for no reason — and `hasEmittedShell()` would
  // answer for the process rather than for the response.
  if (!hasRequestScope()) return true;
  const delta = getScopedState<RequestDelta>(
    REQUEST_DELTA_KEY,
    createRequestDelta
  );
  if (delta.emittedShell) {
    console.error(DUPLICATE_SHELL);
    return false;
  }
  delta.emittedShell = true;
  return true;
}

/**
 * Has this request serialised its shell yet?
 *
 * The question a streaming adapter needs before it emits a delta, and only
 * answerable here. A delta's rules go into the `<head>` anchors the shell
 * emitted; a delta that goes out before the shell has rules with nowhere to
 * land, and — worse — steals them from the shell that is about to be
 * serialised, so the same CSS is sent twice.
 *
 * That ordering is not hypothetical once `<head>` is inside the stream. On
 * React 18 a Suspense boundary in `<head>` is flushed as a placeholder
 * immediately, so React produces bytes, and any adapter keying off "React
 * has written something" would drain a delta while the anchors are still
 * several chunks away.
 *
 * Always false outside a request scope, where there is no delta channel to
 * order anything against.
 */
function hasEmittedShell(): boolean {
  if (!hasRequestScope()) return false;
  return getScopedState<RequestDelta>(REQUEST_DELTA_KEY, createRequestDelta)
    .emittedShell;
}

function takeShellGroups(): Array<[number, string]> {
  const isFirstShell = markShellEmitted();
  const groupText = new Map(sheet.getGroupTextContent());
  // Only the FIRST shell of a request moves the watermark. A second shell is
  // already a bug (see `markShellEmitted`), and moving the watermark again
  // makes it a *silent* one: a rule compiled between the two calls is in the
  // second shell's text and past the new watermark, so it appears in exactly
  // one place — the second, mis-cascading copy of its group — and no delta
  // ever mentions it. Leaving the watermark where the first shell put it
  // sends that rule down the delta channel as well, where it lands in the
  // FIRST anchor for its group, which is the position the cascade was
  // designed around. The rule is then in both places rather than only the
  // wrong one; duplicates are inert (ingest dedups by selector, and the two
  // declarations are identical), a lost cascade position is not.
  if (isFirstShell) {
    resetRequestDelta();
  }

  const groups = [];
  orderedGroups.forEach((group) => groups.push(group));
  groupText.forEach((_text, group) => {
    if (groups.indexOf(group) === -1) groups.push(group);
  });
  groups.sort((a, b) => a - b);

  return groups.map((group) => [
    group,
    escapeForStyleTag(groupText.get(group) || '')
  ]);
}

/**
 * The same shell as `takeShellGroups`, pre-rendered to an HTML fragment —
 * ready to inline anywhere the adapter wants, typically right before
 * `</head>`. Pass `nonce` when the response is served under a CSP.
 */
function takeShellHTML(options?: EmitOptions = {}): string {
  const attr = nonceAttr(options);
  return takeShellGroups()
    .map(
      ([group, text]) =>
        `<style data-rnw-group="${group}"${attr}>${text}</style>`
    )
    .join('');
}

/**
 * Return the HTML fragment for a streamed post-shell chunk: the rules that
 * landed in the current request since the last `takeShellHTML` /
 * `takeDeltaHTML` call, as a single self-removing inline `<script>` that
 * inserts them into the CSSOM of the `<head>` anchors the shell emitted and
 * hands them to the runtime.
 *
 * No `<style>` element is emitted. See `deltaScript` for why — the short
 * version is that a node React did not render is a node
 * `hydrateRoot(document, …)` mis-binds every later sibling against.
 *
 * Adapters embed this verbatim at chunk boundaries. Pass `nonce` when the
 * response is served under a CSP that requires one; it is applied to the
 * `<script>`, which is the only element this emits.
 *
 * Returns '' if the buffer is empty (no new rules this chunk).
 */
function takeDeltaHTML(options?: EmitOptions = {}): string {
  const buckets = drainRequestDelta();
  if (buckets.length === 0) return '';

  // One sequence number per chunk, not per group: the whole chunk is one
  // script, and the number is only a replay guard.
  const seq = nextDeltaSeq();
  const payload = buckets.map(([group, rules]) => ({ g: group, r: rules }));
  const payloadJson = escapeForScriptTag(JSON.stringify(payload));

  return (
    `<script${nonceAttr(options)}>` +
    deltaScript(seq, payloadJson) +
    '</script>'
  );
}

const defaultPreprocessOptions = { shadow: true, textShadow: true };

function customStyleq(styles, options: Options = {}) {
  const { writingDirection, ...preprocessOptions } = options;
  const isRTL = writingDirection === 'rtl';
  return styleq.factory({
    transform(style) {
      const compiledStyle = staticStyleMap.get(style);
      if (compiledStyle != null) {
        return localizeStyle(compiledStyle, isRTL);
      }
      return preprocess(style, {
        ...defaultPreprocessOptions,
        ...preprocessOptions
      });
    }
  })(styles);
}

function insertRules(compiledOrderedRules) {
  // No delta bookkeeping here. The per-request delta is derived from the
  // sheet's revision log at flush time, which is what makes it correct for a
  // request whose rules were inserted by a concurrent one.
  compiledOrderedRules.forEach(([rules, order]) => {
    if (sheet != null) {
      rules.forEach((rule) => {
        sheet.insert(rule, order);
      });
    }
  });
}

function compileAndInsertAtomic(style) {
  const [compiledStyle, compiledOrderedRules] = atomic(
    preprocess(style, defaultPreprocessOptions)
  );
  insertRules(compiledOrderedRules);
  return compiledStyle;
}

function compileAndInsertReset(style, key) {
  const [compiledStyle, compiledOrderedRules] = classic(style, key);
  insertRules(compiledOrderedRules);
  return compiledStyle;
}

/* ----- API ----- */

const absoluteFillObject = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  bottom: 0
};

const absoluteFill = create({ x: { ...absoluteFillObject } }).x;

/**
 * create
 */
function create<T: Object>(styles: T): $ReadOnly<T> {
  Object.keys(styles).forEach((key) => {
    const styleObj = styles[key];
    // Only compile at runtime if the style is not already compiled
    if (styleObj != null && styleObj.$$css !== true) {
      let compiledStyles;
      if (key.indexOf('$raw') > -1) {
        compiledStyles = compileAndInsertReset(styleObj, key.split('$raw')[0]);
      } else {
        if (process.env.NODE_ENV !== 'production') {
          validate(styleObj);
          styles[key] = Object.freeze(styleObj);
        }
        compiledStyles = compileAndInsertAtomic(styleObj);
      }
      staticStyleMap.set(styleObj, compiledStyles);
    }
  });
  return styles;
}

/**
 * compose
 */
function compose(style1: any, style2: any): any {
  if (process.env.NODE_ENV !== 'production') {
    /* eslint-disable prefer-rest-params */
    const len = arguments.length;
    if (len > 2) {
      const readableStyles = [...arguments].map((a) => flatten(a));
      throw new Error(
        `StyleSheet.compose() only accepts 2 arguments, received ${len}: ${JSON.stringify(
          readableStyles
        )}`
      );
    }
    /* eslint-enable prefer-rest-params */
    /*
    console.warn(
      'StyleSheet.compose(a, b) is deprecated; use array syntax, i.e., [a,b].'
    );
    */
  }
  return [style1, style2];
}

/**
 * flatten
 */
function flatten(...styles: any): { [key: string]: any } {
  const flatArray = styles.flat(Infinity);
  const result = {};
  for (let i = 0; i < flatArray.length; i++) {
    const style = flatArray[i];
    if (style != null && typeof style === 'object') {
      // $FlowFixMe
      Object.assign(result, style);
    }
  }
  return result;
}

/**
 * getSheet
 */
function getSheet(): { id: string, textContent: string } {
  return {
    id: sheet.id,
    textContent: sheet.getTextContent()
  };
}

/**
 * resolve
 */
// styleq >= 0.2.0 returns a third element: a debug string, currently always ''.
// It does not affect rendered output; `createDOMProps` destructures only the
// first two. Typed here so the declared shape matches what styleq actually
// returns.
type StyleProps = [string, { [key: string]: mixed } | null, string];
type Options = {
  shadow?: boolean,
  textShadow?: boolean,
  writingDirection: 'ltr' | 'rtl'
};

function StyleSheet(styles: any, options?: Options = {}): StyleProps {
  const isRTL = options.writingDirection === 'rtl';
  const styleProps: StyleProps = customStyleq(styles, options);
  if (Array.isArray(styleProps) && styleProps[1] != null) {
    styleProps[1] = inline(styleProps[1], isRTL);
  }
  return styleProps;
}
// The statics, as one object literal rather than fourteen assignments.
//
// This is the only shape Flow can check. `const stylesheet: IStyleSheet =
// StyleSheet` below reads like the guard on this surface and is not one:
// Flow 0.148 treats a function's statics as unsealed, so that annotation
// holds whether or not any of these members exist, has the wrong type, or
// was never assigned at all. An object literal checked against an exact
// object type is checked member by member — a missing member, a member
// whose type drifted, and a member named in `IStyleSheet` that nothing
// assigns are each an error — and `StyleSheetStatics` is derived from
// `IStyleSheet` rather than repeated, so the two lists cannot diverge.
const statics: StyleSheetStatics = {
  // The fourth spelling of the shell emission, and the only one that is a
  // React component. It hangs here rather than on the top-level barrel for
  // two reasons. It is a StyleSheet concern — its three siblings are already
  // `StyleSheet.takeShellHTML`, `StyleSheet.takeShellGroups` and
  // `AppRegistry.getApplication().getStyleElements()` — and a component-shaped
  // name in the barrel is indistinguishable from `View` or `Text` to anyone
  // reading the export list, while being the one entry there with no React
  // Native counterpart. It is also the only placement the RNW babel plugin can
  // see: that plugin rewrites `import { X } from 'react-native-web'` to a deep
  // import only for names that are directories under `src/exports`, so
  // `StyleSheet` resolves to `dist/exports/StyleSheet` while a top-level
  // `StyleSheetAnchors` fell through to the whole barrel.
  //
  // A static property rather than a named export for the same reason as
  // `Dimensions.unstable_hydrationStore` (see the comment there):
  // `babel-plugin-add-module-exports` only collapses `module.exports` to the
  // default while this module has no named exports, and every deep `require`
  // of `dist/cjs/exports/StyleSheet` depends on that collapse.
  //
  // The import is circular — StyleSheetAnchors reads `StyleSheet` back — but
  // only in the direction that resolves, and the hoist that resolves it is in
  // the *other* module: Babel compiles `StyleSheetAnchors.js`'s
  // default-exported function declaration to an `exports.default =
  // StyleSheetAnchors` above its own `require`s, so by the time this module's
  // `require('./StyleSheetAnchors')` returns — in either entry order — the
  // component is already on the exports object. (This module does not hoist:
  // it ends with `exports.default = stylesheet`, after everything.) The
  // component in turn only touches `StyleSheet` from inside render, long
  // after both modules have finished evaluating.
  Anchors: StyleSheetAnchors,
  absoluteFill,
  absoluteFillObject,
  compose,
  create,
  flatten,
  getSheet,
  // `hairlineWidth` is not implemented using screen density as browsers may
  // round sub-pixel values down to `0`, causing the line not to be rendered.
  hairlineWidth: 1,
  hasEmittedShell,
  resetRequestDelta,
  takeDeltaHTML,
  takeRequestDelta,
  takeShellGroups,
  takeShellHTML
};

Object.assign(StyleSheet, statics);

if (canUseDOM && window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__.resolveRNStyle = flatten;
}

export type IStyleSheet = {
  (styles: $ReadOnlyArray<any>, options?: Options): StyleProps,
  Anchors: typeof StyleSheetAnchors,
  absoluteFill: Object,
  absoluteFillObject: Object,
  create: typeof create,
  compose: typeof compose,
  flatten: typeof flatten,
  getSheet: typeof getSheet,
  takeRequestDelta: typeof takeRequestDelta,
  resetRequestDelta: typeof resetRequestDelta,
  takeShellGroups: typeof takeShellGroups,
  hasEmittedShell: typeof hasEmittedShell,
  takeShellHTML: typeof takeShellHTML,
  takeDeltaHTML: typeof takeDeltaHTML,
  hairlineWidth: number
};

// `IStyleSheet` without its call signature, exactly: every member of
// `IStyleSheet` and nothing else. Deriving it here rather than writing the
// list twice is what makes a member added to `IStyleSheet` an error at the
// literal above instead of an unchecked promise to consumers.
type StyleSheetStatics = $Exact<$Diff<IStyleSheet, {||}>>;

// Vacuous as a check (see the comment on `statics`), kept because it is the
// annotation consumers and `gen-flow-files` read.
const stylesheet: IStyleSheet = StyleSheet;

export default stylesheet;
