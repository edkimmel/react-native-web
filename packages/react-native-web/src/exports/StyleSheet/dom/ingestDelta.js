/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type { OrderedCSSStyleSheet } from './createOrderedCSSStyleSheet';

/**
 * Client-side ingest path for streaming-SSR delta tags emitted by the server.
 *
 * The pipeline the consumer is expected to use, per chunk:
 *
 *   <style data-rnw-delta="N">@layer rnw-2 { .r-foo {...} }</style>
 *   <script>
 *     (window.__RNW_DELTA__ = window.__RNW_DELTA__ || []).push("N");
 *     if (window.__RNW_INGEST_DELTA__) window.__RNW_INGEST_DELTA__();
 *   </script>
 *
 * The browser applies the `<style data-rnw-delta>` rules immediately — that
 * is the no-FOUC guarantee. The inline script is *only* a bookkeeping
 * signal: it tells RNW that the rule is already present in the document
 * so a later StyleSheet.create call for the same atomic class can dedup
 * instead of re-inserting a duplicate into the primary sheet at runtime.
 * Cross-sheet cascade ordering is handled by the named layers themselves;
 * the bookkeeping transfer is purely a runtime-dedup optimization.
 *
 * If the inline script runs before RNW's runtime has installed
 * __RNW_INGEST_DELTA__, the ID stays in the queue; RNW drains the queue
 * on first sheet bootstrap. If RNW never loads (JS-disabled bots), the
 * page still renders correctly — only the bookkeeping is unused.
 *
 * Re-processing a delta is a no-op (processed IDs are tracked).
 */

declare var window: {
  __RNW_DELTA__?: Array<string | number>,
  __RNW_INGEST_DELTA__?: () => void,
  ...
};

const QUEUE_KEY = '__RNW_DELTA__';
const HOOK_KEY = '__RNW_INGEST_DELTA__';

const slice = Array.prototype.slice;

// Decode `rnw-X` or `rnw-X-Y` → X or X.Y. Returns null on malformed input.
function groupForLayerName(name: ?string): ?number {
  if (name == null || name.indexOf('rnw-') !== 0) return null;
  const rest = name.slice(4);
  if (rest === '') return null;
  const n = Number(rest.replace(/-/g, '.'));
  return isFinite(n) ? n : null;
}

// Extract the group number from a `@layer rnw-N { … }` CSSLayerBlockRule.
function decodeLayerBlockGroup(cssRule: {
  cssText: string,
  name?: string
}): ?number {
  if (typeof cssRule.name === 'string') {
    return groupForLayerName(cssRule.name);
  }
  const cssText = cssRule.cssText;
  if (cssText == null || cssText.indexOf('@layer ') !== 0) return null;
  const match = cssText.match(/^@layer\s+([\w-]+)\s*\{/);
  if (match == null) return null;
  return groupForLayerName(match[1]);
}

/**
 * Install the global ingest hook and drain any pending queued deltas. Safe
 * to call multiple times — only the first call installs the hook; subsequent
 * calls are no-ops aside from draining the queue.
 *
 * `sheets` is the live array of OrderedCSSStyleSheets that the dom wrapper
 * keeps; the hook updates every sheet (so Shadow DOM clones learn about
 * deltas too). The reference is captured by closure so future deltas pushed
 * after the hook is installed land in the same set.
 */
export function installDeltaIngest(
  sheets: $ReadOnlyArray<OrderedCSSStyleSheet>
): void {
  if (typeof window === 'undefined') return;

  const processed: Set<string> = new Set();

  function ingestOne(id: string | number): void {
    const key = String(id);
    if (processed.has(key)) return;
    processed.add(key);

    const element = document.querySelector(
      `style[data-rnw-delta="${cssEscape(key)}"]`
    );
    if (element == null) return;
    // $FlowFixMe — HTMLStyleElement.sheet is incorrectly typed
    const cssSheet: ?CSSStyleSheet = element.sheet;
    if (cssSheet == null) return;

    slice.call(cssSheet.cssRules).forEach((cssRule) => {
      const group = decodeLayerBlockGroup(cssRule);
      if (group == null) return;
      // CSSLayerBlockRule extends CSSGroupingRule which exposes .cssRules.
      const innerRules = cssRule.cssRules;
      if (innerRules == null) return;
      slice.call(innerRules).forEach((innerRule) => {
        const innerText = innerRule.cssText;
        sheets.forEach((s) => {
          s.registerExisting(innerText, group);
        });
      });
    });
  }

  function drain(): void {
    const queue = window[QUEUE_KEY];
    if (!Array.isArray(queue)) return;
    while (queue.length > 0) {
      const id = queue.shift();
      if (id != null) ingestOne(id);
    }
  }

  if (typeof window[HOOK_KEY] !== 'function') {
    // $FlowFixMe — augmenting window with our internal hook
    window[HOOK_KEY] = drain;
  }
  // Always drain on install in case entries arrived before the hook existed.
  drain();
}

// Minimal CSS attribute-selector escape for the delta id. Delta ids are
// emitted by the server as plain digit / hyphen strings, so this only
// needs to cover the long-tail of consumers who pass something weird.
function cssEscape(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1f"\\]/g, '\\$&');
}
