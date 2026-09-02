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
  // Rules added in insertion order, bucketed by group number.
  pending: Map<number, Array<string>>,
  // Groups for which a `[stylesheet-group="N"]{}` marker rule has already
  // been emitted in a prior flush during this request. Subsequent flushes
  // skip the marker for these groups; only the new content is emitted.
  emittedGroupMarkers: Set<number>
|};

function createRequestDelta(): RequestDelta {
  return {
    emittedGroupMarkers: new Set(),
    pending: new Map()
  };
}

function appendRequestDelta(cssText: string, groupValue: number): void {
  if (!hasRequestScope()) return;
  const delta = getScopedState<RequestDelta>(
    REQUEST_DELTA_KEY,
    createRequestDelta
  );
  const group = Number(groupValue);
  let bucket = delta.pending.get(group);
  if (bucket == null) {
    bucket = [];
    delta.pending.set(group, bucket);
  }
  bucket.push(cssText);
}

function encodeGroupMarker(group: number): string {
  return `[stylesheet-group="${group}"]{}`;
}

/**
 * Drain the current request's pending delta into ascending `[group, rules]`
 * buckets, emptying the buffer. Returns `[]` if there is no active request
 * scope or nothing pending.
 */
function drainRequestDelta(): Array<[number, Array<string>]> {
  if (!hasRequestScope()) return [];
  const delta = getScopedState<RequestDelta>(
    REQUEST_DELTA_KEY,
    createRequestDelta
  );
  if (delta.pending.size === 0) return [];

  const groups = Array.from(delta.pending.keys()).sort((a, b) => a - b);
  const out: Array<[number, Array<string>]> = [];
  for (const group of groups) {
    const bucket = delta.pending.get(group);
    if (bucket != null && bucket.length > 0) {
      out.push([group, bucket]);
    }
  }
  delta.pending.clear();
  return out;
}

/**
 * Drain the current request's pending delta into a single CSS text fragment.
 * Returns an empty string if there is no active request scope or no pending
 * rules.
 *
 * This is the lower-level, marker-delimited form, kept for callers that
 * assemble their own `<style>` tags. The streaming pipeline uses
 * `takeDeltaHTML` instead, which emits one element per group and needs no
 * markers because the group travels on the element.
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
 * Discard any pending delta entries for the current request without emitting
 * them. The streaming pipeline calls this after the shell head dump, since
 * the full sheet text has already been emitted there and the delta channel
 * should only carry rules added *after* that point.
 */
function resetRequestDelta(): void {
  if (!hasRequestScope()) return;
  const delta = getScopedState<RequestDelta>(
    REQUEST_DELTA_KEY,
    createRequestDelta
  );
  delta.pending.clear();
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
//   - that streamed chunks emit `<style data-rnw-group data-rnw-delta>` plus
//     an inline `<script>` that relocates them into `<head>`
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

const REQUEST_SEQ_KEY = 'StyleSheet.delta-seq';

function nextDeltaSeq(): number {
  // When called outside any request scope the counter falls back to a
  // single process-wide one; the sequence is purely a uniqueness handle
  // for the embedded handshake script and doesn't need cross-request
  // semantics in that mode.
  const counter = hasRequestScope()
    ? getScopedState<{ value: number }>(REQUEST_SEQ_KEY, () => ({ value: 0 }))
    : processWideSeq;
  counter.value += 1;
  return counter.value;
}

const processWideSeq: { value: number } = { value: 0 };

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
 * Move every not-yet-relocated delta `<style>` out of `<body>` and into
 * `<head>`, directly after its group's anchor. Runs synchronously while the
 * chunk is being parsed, so there is no paint between the element applying
 * and it being in the right cascade position.
 *
 * Properties that matter:
 *   - Moving the element re-parses only its own text, so this is O(delta),
 *     not O(whole sheet). Merging the text into the anchor would be O(n^2).
 *   - Idempotent: relocated elements are no longer under `body`, so a re-run
 *     finds nothing. Every chunk can safely run it.
 *   - Fails safe: a delta whose group has no anchor stays in `<body>` rather
 *     than landing in the wrong bucket.
 *   - Intra-group order is irrelevant — styleq dedupes by property key, so
 *     two rules in one group never target the same property on the same
 *     element — which is why inserting right after the anchor is enough.
 *   - Needs no RNW runtime, and works with JS disabled to the extent that
 *     nothing moves: styles still apply, only cross-chunk shorthand vs
 *     longhand ordering is wrong.
 */
const RELOCATE_SCRIPT =
  'var d=document,h=d.head,' +
  "p=d.querySelectorAll('body style[data-rnw-delta]'),i,e,g,a;" +
  'for(i=0;i<p.length;i++){e=p[i];g=e.getAttribute("data-rnw-group");' +
  "a=g?h.querySelector('style[data-rnw-group=\"'+g+'\"]:not([data-rnw-delta])'):null;" +
  'if(a)h.insertBefore(e,a.nextSibling);}';

/**
 * Return the HTML fragment carrying the full cumulative server sheet as one
 * `<style data-rnw-group="G">` per group, ascending — ready to inline
 * anywhere the adapter wants (typically right before `</head>`).
 *
 * **Empty groups are emitted too.** They are the anchors later chunks insert
 * against; an absent anchor would send that chunk's delta to the end of
 * `<head>`, where it outranks every group above it. That is the exact trap
 * both `@layer` and React's `precedence` fall into for a bucket they have
 * not seen before.
 *
 * Also resets the per-request delta buffer: anything dual-written during the
 * shell render is already in this fragment, so subsequent chunks carry only
 * rules added AFTER this point.
 */
function takeShellHTML(options?: EmitOptions = {}): string {
  const groupText = new Map(sheet.getGroupTextContent());
  resetRequestDelta();

  const groups = [];
  orderedGroups.forEach((group) => groups.push(group));
  groupText.forEach((_text, group) => {
    if (groups.indexOf(group) === -1) groups.push(group);
  });
  groups.sort((a, b) => a - b);

  const attr = nonceAttr(options);
  return groups
    .map((group) => {
      const text = groupText.get(group) || '';
      return `<style data-rnw-group="${group}"${attr}>${escapeForStyleTag(
        text
      )}</style>`;
    })
    .join('');
}

/**
 * Return the HTML fragment for a streamed post-shell chunk: the rules that
 * landed in the current request since the last `takeShellHTML` /
 * `takeDeltaHTML` call, as one `<style>` per group, plus a tiny inline
 * script that relocates them into `<head>` and tells the runtime about them.
 *
 * Adapters embed this verbatim at chunk boundaries. Pass `nonce` when the
 * response is served under a CSP that requires one; it is applied to both
 * the style elements and the script.
 *
 * Returns '' if the buffer is empty (no new rules this chunk).
 */
function takeDeltaHTML(options?: EmitOptions = {}): string {
  const buckets = drainRequestDelta();
  if (buckets.length === 0) return '';

  const attr = nonceAttr(options);
  const ids = [];
  let styleTags = '';
  for (const [group, rules] of buckets) {
    const seq = nextDeltaSeq();
    ids.push(seq);
    styleTags +=
      `<style data-rnw-group="${group}" data-rnw-delta="${seq}"${attr}>` +
      `${escapeForStyleTag(rules.join('\n'))}</style>`;
  }

  const pushIds = ids.map((id) => `"${id}"`).join(',');
  const script =
    `<script${attr}>(function(){${RELOCATE_SCRIPT}` +
    `(window.__RNW_DELTA__=window.__RNW_DELTA__||[]).push(${pushIds});` +
    `if(window.__RNW_INGEST_DELTA__)window.__RNW_INGEST_DELTA__();})();</script>`;

  return styleTags + script;
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
  compiledOrderedRules.forEach(([rules, order]) => {
    if (sheet != null) {
      rules.forEach((rule) => {
        const { ruleAdded } = sheet.insert(rule, order);
        // Only mirror rules that the dedup check accepted. Rules that the
        // shared sheet already had (module-load-time inserts from a prior
        // request, or repeated inserts within the same request) must not
        // appear in the delta — they are already in the head dump.
        if (ruleAdded) {
          appendRequestDelta(rule, order);
        }
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

StyleSheet.absoluteFill = absoluteFill;
StyleSheet.absoluteFillObject = absoluteFillObject;
StyleSheet.create = create;
StyleSheet.compose = compose;
StyleSheet.flatten = flatten;
StyleSheet.getSheet = getSheet;
StyleSheet.takeRequestDelta = takeRequestDelta;
StyleSheet.resetRequestDelta = resetRequestDelta;
StyleSheet.takeShellHTML = takeShellHTML;
StyleSheet.takeDeltaHTML = takeDeltaHTML;
// `hairlineWidth` is not implemented using screen density as browsers may
// round sub-pixel values down to `0`, causing the line not to be rendered.
StyleSheet.hairlineWidth = 1;

if (canUseDOM && window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__.resolveRNStyle = StyleSheet.flatten;
}

export type IStyleSheet = {
  (styles: $ReadOnlyArray<any>, options?: Options): StyleProps,
  absoluteFill: Object,
  absoluteFillObject: Object,
  create: typeof create,
  compose: typeof compose,
  flatten: typeof flatten,
  getSheet: typeof getSheet,
  takeRequestDelta: typeof takeRequestDelta,
  resetRequestDelta: typeof resetRequestDelta,
  takeShellHTML: typeof takeShellHTML,
  takeDeltaHTML: typeof takeDeltaHTML,
  hairlineWidth: number
};

const stylesheet: IStyleSheet = StyleSheet;

export default stylesheet;
