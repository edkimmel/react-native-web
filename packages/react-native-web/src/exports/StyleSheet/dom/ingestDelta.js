/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type { OrderedCSSStyleSheet } from './createOrderedCSSStyleSheet';

/**
 * Client-side ingest path for streaming-SSR deltas emitted by the server.
 *
 * The pipeline the consumer is expected to use, per chunk (see
 * `StyleSheet.takeDeltaHTML`):
 *
 *   <script>(function(){
 *     var s = document.currentScript;
 *     // insert this chunk's rules straight into the <head> anchor's CSSOM
 *     (window.__RNW_DELTA__ = window.__RNW_DELTA__ || [])
 *       .push({ g: 2, r: ['.r-foo{...}'] });
 *     if (window.__RNW_INGEST_DELTA__) window.__RNW_INGEST_DELTA__();
 *     s.remove();
 *   })();</script>
 *
 * The browser applies the rules the moment `insertRule` returns — that is
 * the no-FOUC guarantee — and it applies them *inside the anchor's own
 * sheet*, which is what puts them in the right place in the cascade. The
 * script then deletes itself, so the chunk leaves no node behind for
 * `hydrateRoot(document, …)` to mis-bind its `<head>` fibers against.
 * Neither half depends on RNW's runtime having loaded.
 *
 * For the ordinary chunk this hook is *only* a bookkeeping signal: it tells
 * RNW that the rule is already present in the document so a later
 * StyleSheet.create call for the same atomic class can dedup instead of
 * re-inserting a duplicate at runtime. The one case where it does the work
 * itself is a chunk that found no anchor to write into — see below.
 *
 * If the inline script runs before RNW's runtime has installed
 * __RNW_INGEST_DELTA__, the entry stays in the queue; RNW drains the queue
 * on first sheet bootstrap. Even a queue that is never drained is only a
 * missed optimisation, because boot-time hydration reads each anchor's live
 * `cssRules` (see `collectGroupSheets` in ../dom/index.js) and therefore
 * already sees every rule an earlier chunk inserted. The queue exists for
 * the chunks that arrive *after* boot, when nothing re-reads the anchors.
 *
 * Two entry shapes are accepted:
 *
 *   { g, r }        the current format: the group, and its rules as text.
 *                   The chunk's script already put them into the group
 *                   anchor's CSSOM, so ingest is bookkeeping only.
 *   { g, r, p: 1 }  the same, but PENDING: the chunk found no anchor for
 *                   its group and applied nothing. Ingest has to do the
 *                   applying, and can only do it once an anchor exists.
 *   "N" | N         the legacy format: the `data-rnw-delta` id of a
 *                   `<style>` element the server streamed into the page.
 *                   No longer emitted — the elements were the hydration
 *                   hazard — but still read, so a client bundle newer than
 *                   the server that rendered the page keeps working.
 *
 * ## Why a chunk can arrive before its anchor, and why it waits
 *
 * When the app renders `<head>` through React and puts a Suspense boundary
 * in or above it, the anchors are React elements that do not exist until
 * that boundary resolves. The chunk's script used to create the missing
 * `<style>` itself. That is the single DOM shape measured to silently
 * mis-bind `hydrateRoot(document, …)`: React matches hydration candidates
 * by tag, so a `<style>` React did not render, sitting between `<style>`
 * elements it did, is indistinguishable from the node React expected and
 * every later sibling shifts by one — in production, with no warning.
 *
 * So the chunk now applies nothing and leaves the payload queued, flagged
 * `p`. The queue is drained again on every subsequent chunk, when RNW's
 * sheet boots, and from `<StyleSheet.Anchors>`'s own commit — the moment
 * React has put the anchors in the document. An entry whose anchor is
 * still missing stays in the queue rather than being dropped or applied
 * somewhere arbitrary — until the parser reaches the end of the document,
 * after which no React-rendered anchor can still be coming and the entry is
 * applied through `insert`, which creates an anchor of its own. See
 * `parserFinished` below for why that is safe at exactly that moment and
 * not before.
 *
 * Re-processing a delta is a no-op: legacy ids are tracked, and rule
 * payloads dedup by selector inside `registerExisting` / `insert`, which
 * share one `recordRule` check. That is also what makes a runtime
 * `StyleSheet.create` for the same atomic class dedup rather than insert a
 * second copy, whichever path got there first.
 */

type DeltaRules = {
  g: number | string,
  p?: mixed,
  r: Array<string>,
  ...
};
type DeltaEntry = DeltaRules | string | number;

declare var window: {
  __RNW_DELTA__?: Array<DeltaEntry>,
  __RNW_INGEST_DELTA__?: () => void,
  ...
};

const QUEUE_KEY = '__RNW_DELTA__';
const HOOK_KEY = '__RNW_INGEST_DELTA__';

const slice = Array.prototype.slice;
const groupSplitPattern = /["']/g;

function readGroupAttr(element: Element): ?number {
  const raw = element.getAttribute('data-rnw-group');
  if (raw == null || raw === '') return null;
  const group = Number(raw);
  return isFinite(group) ? group : null;
}

function decodeGroupRule(cssRule: CSSStyleRule): ?number {
  // Marker rules look like `[stylesheet-group="N"]{}`. Pull N out of the
  // selector text in a way that tolerates either quote style.
  const selector = cssRule.selectorText;
  if (selector == null) return null;
  const parts = selector.split(groupSplitPattern);
  if (parts.length < 2) return null;
  const n = Number(parts[1]);
  return isFinite(n) ? n : null;
}

/**
 * Ask the installed hook to re-run. A no-op before RNW's sheet has booted,
 * because the queue is drained on install anyway.
 *
 * Exists for `<StyleSheet.Anchors>`: when the anchors are inside a Suspense
 * boundary they appear in the document long after the chunk that needed
 * them ran, and the component's commit is the only moment anything knows
 * they are now there.
 */
export function drainDeltaQueue(): void {
  if (typeof window === 'undefined') return;
  const hook = window[HOOK_KEY];
  if (typeof hook === 'function') hook();
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
 *
 * `hasGroupAnchor` answers "does `<head>` already contain the anchor for
 * this group?" without creating one. Only pending entries consult it; see
 * the header for why synthesising the element instead is not an option.
 */
export function installDeltaIngest(
  sheets: $ReadOnlyArray<OrderedCSSStyleSheet>,
  hasGroupAnchor?: ?(group: number) => boolean
): void {
  if (typeof window === 'undefined') return;

  const processed: Set<string> = new Set();

  // Once the parser has reached the end of the document, no further shell
  // anchor is ever going to arrive — every streamed segment, including a
  // `<head>` boundary that `$RC` relocated, is already in the DOM. Anything
  // still waiting at that point is waiting for something that does not
  // exist, so it stops waiting and takes whatever anchor RNW's own runtime
  // provides (creating one if need be, which is safe precisely because no
  // React-rendered anchor is coming to collide with it).
  //
  // This is the path a caller who streams deltas but emits no shell at all
  // ends up on. It is not reachable from the documented flow — every shell
  // spelling emits an anchor for every group — and it costs those callers
  // JS where the old create-it-in-the-chunk fallback did not, but it ends
  // with the rules applied rather than dropped.
  //
  // Read live rather than latched by the listener below: the listener is
  // only a prompt to try again, and the answer must not depend on whether
  // this particular closure was the one that received the event.
  function parserFinished(): boolean {
    return document.readyState !== 'loading';
  }

  function register(cssText: string, group: number): void {
    sheets.forEach((s) => {
      s.registerExisting(cssText, group);
    });
  }

  /**
   * Apply a rule the document is NOT yet carrying. `insert` resolves the
   * group's anchor and appends to its own sheet — the same call a runtime
   * `StyleSheet.create` makes, so the two dedup against each other through
   * one shared selector map instead of racing to insert twice.
   */
  function apply(cssText: string, group: number): void {
    sheets.forEach((s) => {
      s.insert(cssText, group);
    });
  }

  /**
   * Current format: the rules travel in the payload, so nothing is looked
   * up in the DOM at all.
   *
   * The text is the server's, not the browser's normalised `cssText`. That
   * is fine and is what makes this cheap: `registerExisting` dedups on the
   * selector, which both spellings agree on, and the recorded text is only
   * ever re-read to mirror the sheet into a new root.
   *
   * No `processed` guard is needed. Every path into this — a replayed
   * script, a queue drained twice, boot-time hydration having already read
   * the same rule out of the anchor's `cssRules` — ends at the selector
   * dedup, which is the same check a duplicate runtime insert hits.
   */
  function ingestRules(entry: DeltaRules): boolean {
    const group = Number(entry.g);
    const rules = entry.r;
    // Malformed entries are consumed rather than retained: a payload that
    // can never be applied would otherwise be retried on every drain for
    // the life of the page.
    if (!isFinite(group) || !Array.isArray(rules)) return true;

    // A pending entry carries rules nothing has applied yet, so it must
    // WAIT for its anchor rather than take any other placement. Returning
    // false keeps it queued for the next drain.
    const pending = entry.p != null && entry.p !== false;
    if (
      pending &&
      !parserFinished() &&
      hasGroupAnchor != null &&
      !hasGroupAnchor(group)
    ) {
      return false;
    }

    for (let i = 0; i < rules.length; i++) {
      const cssText = rules[i];
      if (typeof cssText === 'string' && cssText !== '') {
        if (pending) {
          apply(cssText, group);
        } else {
          register(cssText, group);
        }
      }
    }
    return true;
  }

  /**
   * Legacy format: a `<style data-rnw-delta="N">` element the server put in
   * the document. Read out of the CSSOM because the element's text may have
   * been normalised by the parser.
   */
  function ingestElement(id: string | number): boolean {
    const key = String(id);
    if (processed.has(key)) return true;
    processed.add(key);

    const element = document.querySelector(
      `style[data-rnw-delta="${cssEscape(key)}"]`
    );
    if (element == null) return true;
    // $FlowFixMe — HTMLStyleElement.sheet is incorrectly typed
    const cssSheet: ?CSSStyleSheet = element.sheet;
    if (cssSheet == null) return true;

    const rules = slice.call(cssSheet.cssRules);

    // Grouped format: the element carries its own group, so every rule in
    // it belongs to that group and there is nothing to scan for.
    const attrGroup = readGroupAttr(element);
    if (attrGroup != null) {
      rules.forEach((cssRule) => {
        const cssText = cssRule.cssText;
        if (cssText.indexOf('stylesheet-group') > -1) return;
        register(cssText, attrGroup);
      });
      return true;
    }

    // Oldest format: groups are delimited by `[stylesheet-group="N"]{}`
    // marker rules inside the delta's own text.
    let currentGroup: ?number = null;
    rules.forEach((cssRule) => {
      const cssText = cssRule.cssText;
      if (cssText.indexOf('stylesheet-group') > -1) {
        currentGroup = decodeGroupRule(cssRule);
      } else if (currentGroup != null) {
        // Copy to a const: Flow drops the null-refinement of the outer `let`
        // once it crosses into the callback.
        register(cssText, currentGroup);
      }
    });
    return true;
  }

  /** True if the entry is finished with; false to keep it queued. */
  function ingestOne(entry: DeltaEntry): boolean {
    if (typeof entry === 'object') {
      return ingestRules(entry);
    }
    return ingestElement(entry);
  }

  /**
   * Consume the queue, putting back anything that still has no anchor.
   *
   * `splice` rather than repeated `shift` so the queue is emptied in one
   * step: `ingestRules` can call back into `insert`, and an entry must not
   * be visible to a re-entrant drain while it is being applied.
   *
   * Retained entries go back through `Array.prototype.push` rather than
   * `queue.push`, because requeueing is not a delta arriving. The queue is
   * a plain array the server's inline script creates, and a consumer that
   * has wrapped `push` to observe chunks (the e2e harness does exactly
   * this) should not see one chunk twice.
   */
  function drain(): void {
    const queue = window[QUEUE_KEY];
    if (!Array.isArray(queue)) return;
    const entries = queue.splice(0, queue.length);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry == null) continue;
      if (!ingestOne(entry)) Array.prototype.push.call(queue, entry);
    }
  }

  if (typeof window[HOOK_KEY] !== 'function') {
    // $FlowFixMe — augmenting window with our internal hook
    window[HOOK_KEY] = drain;
  }
  if (!parserFinished()) {
    document.addEventListener('DOMContentLoaded', drain, { once: true });
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
