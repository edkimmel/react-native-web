/**
 * Copyright (c) Nicolas Gallagher.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import { atomic, classic, inline } from './compiler';
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
  pending: Map<number, Array<string>>
|};

function createRequestDelta(): RequestDelta {
  return { pending: new Map() };
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

// Encode a group number as a CSS layer name. Mirrors the helper in
// dom/createOrderedCSSStyleSheet.js; kept inline here to avoid coupling
// the API export to a sub-module path.
function layerNameForGroup(group: number): string {
  return `rnw-${String(group).replace('.', '-')}`;
}

/**
 * Drain the current request's pending delta into a CSS text fragment suitable
 * for emission as `<style data-rnw-delta="...">{textContent}</style>` in the
 * streamed response. Returns an empty string if there is no active request
 * scope or no pending rules.
 *
 * Output uses CSS Cascade Layers — one `@layer rnw-<group> { … }` block per
 * group that has pending rules. Layer ordering is established by the shell
 * head dump's `@layer …;` declaration; subsequent deltas don't need to
 * re-declare. Re-emitting a layer block for an already-declared layer is
 * idempotent — the browser merges the rules into the same cascade tier.
 */
function takeRequestDelta(): string {
  if (!hasRequestScope()) return '';
  const delta = getScopedState<RequestDelta>(
    REQUEST_DELTA_KEY,
    createRequestDelta
  );
  if (delta.pending.size === 0) return '';

  const orderedGroups = Array.from(delta.pending.keys()).sort((a, b) =>
    a > b ? 1 : -1
  );
  const blocks = [];
  for (const group of orderedGroups) {
    const bucket = delta.pending.get(group);
    if (bucket == null || bucket.length === 0) continue;
    blocks.push(
      `@layer ${layerNameForGroup(group)} {\n${bucket.join('\n')}\n}`
    );
  }
  delta.pending.clear();
  return blocks.join('\n');
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
}

// ---------------------------------------------------------------------------
// SSR injection helpers
//
// Higher-level helpers that return ready-to-inline HTML fragments. SSR
// adapters call these and embed the strings verbatim into the response.
// Adapters do NOT need to know:
//   - that the shell goes into `<style id="react-native-stylesheet">`
//   - that streamed chunks use `<style data-rnw-delta="N">` + an inline
//     `<script>` handshake
//   - what the handshake script contains, or the names of any window
//     globals it touches
// Those details are opaque to callers and may change without affecting
// adapter code, provided the produced HTML is treated as a single
// inert blob.
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

/**
 * Return the HTML fragment that carries the full cumulative server sheet,
 * ready to inline anywhere the adapter wants (typically right before
 * `</head>`). Also resets the per-request delta buffer — anything that
 * was dual-written during the shell render is already in the dump, so
 * subsequent streaming chunks should only carry rules added AFTER this
 * point.
 *
 * The returned fragment is the primary RNW stylesheet element; client
 * runtime will adopt it on boot and append to it via insertRule. This
 * keeps shell rules and runtime additions inside the same CSSOM, which
 * is the only place CSS Cascade Layer ordering is reliable.
 *
 * Returns '' if there are no rules to emit.
 */
function takeShellHTML(): string {
  const { textContent } = getSheet();
  resetRequestDelta();
  if (!textContent) return '';
  return `<style id="react-native-stylesheet">${escapeForStyleTag(
    textContent
  )}</style>`;
}

/**
 * Return the HTML fragment for a streamed post-shell chunk: the rules
 * that landed in the current request since the last `takeShellHTML` /
 * `takeDeltaHTML` call, plus a tiny inline handshake script that tells
 * the runtime to learn about them.
 *
 * Adapters embed this verbatim at chunk boundaries. The internals of
 * the script — what window globals it touches, how it coordinates with
 * the runtime — are intentionally opaque.
 *
 * Returns '' if the buffer is empty (no new rules this chunk).
 */
function takeDeltaHTML(): string {
  const delta = takeRequestDelta();
  if (!delta) return '';
  const seq = nextDeltaSeq();
  const styleTag = `<style data-rnw-delta="${seq}">${escapeForStyleTag(
    delta
  )}</style>`;
  const handshake =
    `<script>(window.__RNW_DELTA__=window.__RNW_DELTA__||[]).push("${seq}");` +
    `if(window.__RNW_INGEST_DELTA__)window.__RNW_INGEST_DELTA__();</script>`;
  return styleTag + handshake;
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
type StyleProps = [string, { [key: string]: mixed } | null];
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
