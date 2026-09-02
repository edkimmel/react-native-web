/**
 * Copyright (c) Nicolas Gallagher.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

type Groups = { [key: number]: { start: ?number, rules: Array<string> } };
type Selectors = { [key: string]: boolean };

export type InsertResult = {|
  // True iff the user rule passed the selectors dedup check and was appended
  // to the group's rule list. False if the selector was already known or the
  // rule was rejected by the CSSOM (vendor-prefix / unrecognized pseudo).
  ruleAdded: boolean,
  // True iff this insert created a brand-new group (the marker rule was added
  // for the first time).
  groupCreated: boolean
|};

export type GroupedOptions = {|
  // Resolve — creating on demand — the `<style>` sheet that owns `group`.
  // Grouped mode makes each group a physical stylesheet, so cascade order
  // is the DOM order of those elements rather than rule positions inside
  // one shared sheet.
  sheetForGroup: (group: number) => ?CSSStyleSheet,
  // `[group, sheet]` pairs to hydrate the bookkeeping from, in document
  // order. Includes both the per-group anchors and any streamed delta
  // elements, since both carry rules the document is already applying.
  hydrateFrom?: ?$ReadOnlyArray<[number, CSSStyleSheet]>
|};

export type OrderedCSSStyleSheet = {|
  getTextContent: () => string,
  // The same records as `getTextContent`, split per group and without the
  // marker rules, for emitting one `<style data-rnw-group>` per group.
  getGroupTextContent: () => Array<[number, string]>,
  insert: (cssText: string, groupValue: number) => InsertResult,
  // Update the bookkeeping (groups + selectors) as if the rule had been
  // inserted, but skip the CSSOM `insertRule` call. Used to tell the runtime
  // sheet about rules that already exist in a separate `<style>` element
  // (e.g. a streaming SSR delta tag emitted into <body>) so it does not
  // re-insert them into the primary sheet at runtime.
  registerExisting: (cssText: string, groupValue: number) => InsertResult
|};

const slice = Array.prototype.slice;

/**
 * Order-based insertion of CSS.
 *
 * Each rule is associated with a numerically defined group.
 * Groups are ordered within the style sheet according to their number, with the
 * lowest first.
 *
 * Groups are implemented using marker rules. The selector of the first rule of
 * each group is used only to encode the group number for hydration. An
 * alternative implementation could rely on CSSMediaRule, allowing groups to be
 * treated as a sub-sheet, but the Edge implementation of CSSMediaRule is
 * broken.
 * https://developer.mozilla.org/en-US/docs/Web/API/CSSMediaRule
 * https://gist.github.com/necolas/aa0c37846ad6bd3b05b727b959e82674
 */
export default function createOrderedCSSStyleSheet(
  sheet: ?CSSStyleSheet,
  additionalSheets?: ?$ReadOnlyArray<CSSStyleSheet>,
  grouped?: ?GroupedOptions
): OrderedCSSStyleSheet {
  const groups: Groups = {};
  const selectors: Selectors = {};
  const isGrouped = grouped != null;

  /**
   * Create the bookkeeping record for `group` if it is new. The marker rule
   * is always recorded, in both modes, so `getTextContent` keeps producing
   * upstream's format. In grouped mode it is bookkeeping only — never
   * written to the CSSOM — because the element's `data-rnw-group`
   * attribute carries the group instead.
   */
  function ensureGroup(group: number): boolean {
    if (groups[group] == null) {
      groups[group] = { start: null, rules: [encodeGroupRule(group)] };
      return true;
    }
    return false;
  }

  function recordRule(group: number, cssText: string): boolean {
    const selectorText = getSelectorText(cssText);
    if (selectorText == null || selectors[selectorText] != null) {
      return false;
    }
    selectors[selectorText] = true;
    groups[group].rules.push(cssText);
    return true;
  }

  /**
   * Hydrate the records from rules in a CSSStyleSheet. `isPrimary` controls
   * whether to record absolute rule indices in `groups[g].start` — only the
   * primary sheet's positions are meaningful for `sheetInsert`. For
   * additional (delta) sheets we just merge their rules into the bookkeeping
   * so the dedup map sees them; later runtime inserts will compute their own
   * positions in the primary sheet.
   */
  function hydrate(source: CSSStyleSheet, isPrimary: boolean) {
    let group;
    slice.call(source.cssRules).forEach((cssRule, i) => {
      const cssText = cssRule.cssText;
      if (cssText.indexOf('stylesheet-group') > -1) {
        group = decodeGroupRule(cssRule);
        // Don't overwrite an existing group record discovered in an earlier
        // source — both sheets may contain the marker for the same group.
        if (groups[group] == null) {
          groups[group] = {
            start: isPrimary ? i : null,
            rules: [cssText]
          };
        }
      } else {
        const selectorText = getSelectorText(cssText);
        if (
          selectorText != null &&
          group != null &&
          selectors[selectorText] == null
        ) {
          selectors[selectorText] = true;
          groups[group].rules.push(cssText);
        }
      }
    });
  }

  /**
   * Grouped-mode hydration. The group comes from the element's attribute
   * rather than from a marker rule, so every rule in `source` belongs to
   * `group` and no in-sheet scanning for markers is needed.
   */
  function hydrateGroup(source: CSSStyleSheet, group: number) {
    ensureGroup(group);
    slice.call(source.cssRules).forEach((cssRule) => {
      const cssText = cssRule.cssText;
      // Tolerate a stray marker from a document written in the other format.
      if (cssText.indexOf('stylesheet-group') > -1) return;
      recordRule(group, cssText);
    });
  }

  if (grouped != null) {
    const hydrateFrom = grouped.hydrateFrom;
    if (hydrateFrom != null) {
      hydrateFrom.forEach(([group, source]) => {
        if (source != null) hydrateGroup(source, group);
      });
    }
  } else {
    if (sheet != null) {
      hydrate(sheet, true);
    }
    if (additionalSheets != null) {
      additionalSheets.forEach((s) => {
        if (s != null) hydrate(s, false);
      });
    }
  }

  function sheetInsert(sheet, group, text) {
    const orderedGroups = getOrderedGroups(groups);
    const groupIndex = orderedGroups.indexOf(group);
    const nextGroupIndex = groupIndex + 1;
    const nextGroup = orderedGroups[nextGroupIndex];
    // Insert rule before the next group, or at the end of the stylesheet
    const position =
      nextGroup != null && groups[nextGroup].start != null
        ? groups[nextGroup].start
        : sheet.cssRules.length;
    const isInserted = insertRuleAt(sheet, text, position);

    if (isInserted) {
      // Set the starting index of the new group
      if (groups[group].start == null) {
        groups[group].start = position;
      }
      // Increment the starting index of all subsequent groups
      for (let i = nextGroupIndex; i < orderedGroups.length; i += 1) {
        const groupNumber = orderedGroups[i];
        const previousStart = groups[groupNumber].start || 0;
        groups[groupNumber].start = previousStart + 1;
      }
    }

    return isInserted;
  }

  /**
   * Grouped mode: a group *is* a stylesheet, so inserting is appending.
   * No position arithmetic, no shared index to keep in sync — which is why
   * an inline relocation script and RNW's runtime can both write without
   * corrupting each other's bookkeeping.
   */
  function groupedInsert(group: number, text: string): boolean {
    // $FlowFixMe[incompatible-use] guarded by isGrouped
    const target = grouped.sheetForGroup(group);
    if (target == null) return false;
    return insertRuleAt(target, text, target.cssRules.length);
  }

  const OrderedCSSStyleSheet = {
    /**
     * The textContent of the style sheet.
     */
    getTextContent(): string {
      return getOrderedGroups(groups)
        .map((group) => {
          const rules = groups[group].rules;
          // Sorting provides deterministic order of styles in group for
          // build-time extraction of the style sheet.
          const marker = rules.shift();
          rules.sort();
          rules.unshift(marker);
          return rules.join('\n');
        })
        .join('\n');
    },

    /**
     * The per-group text content, ascending, with the marker rules dropped.
     * Grouped mode puts the group number on the element instead, so the
     * marker would be dead weight in the emitted HTML.
     */
    getGroupTextContent(): Array<[number, string]> {
      return getOrderedGroups(groups).map((group) => {
        // Sorting provides deterministic order of styles in group for
        // build-time extraction of the style sheet.
        const rules = groups[group].rules.slice(1).sort();
        return [group, rules.join('\n')];
      });
    },

    /**
     * Insert a rule into the style sheet. Returns details about whether the
     * group and/or rule were actually added so callers can mirror genuine
     * mutations into a side channel (e.g. an ALS per-request delta buffer)
     * without re-implementing the dedup logic.
     */
    insert(cssText: string, groupValue: number): InsertResult {
      const group = Number(groupValue);
      let groupCreated = false;
      let ruleAdded = false;

      // Create a new group.
      if (ensureGroup(group)) {
        groupCreated = true;
        // Update CSSOM. Only legacy mode needs the marker in the sheet —
        // it is what encodes group position for hydration there.
        if (!isGrouped && sheet != null) {
          sheetInsert(sheet, group, groups[group].rules[0]);
        }
      }

      // selectorText is more reliable than cssText for insertion checks. The
      // browser excludes vendor-prefixed properties and rewrites certain values
      // making cssText more likely to be different from what was inserted.
      const selectorText = getSelectorText(cssText);
      if (selectorText != null && recordRule(group, cssText)) {
        ruleAdded = true;
        // Update CSSOM.
        let isInserted = null;
        if (isGrouped) {
          isInserted = groupedInsert(group, cssText);
        } else if (sheet != null) {
          isInserted = sheetInsert(sheet, group, cssText);
        }
        if (isInserted === false) {
          // Revert internal record change if a rule was rejected (e.g.,
          // unrecognized pseudo-selector)
          groups[group].rules.pop();
          delete selectors[selectorText];
          ruleAdded = false;
        }
      }

      return { groupCreated, ruleAdded };
    },

    /**
     * Like `insert`, but only updates the bookkeeping records — the rule is
     * NOT written into the primary CSSOM sheet. Used by the streaming-SSR
     * client ingest path: a `<style data-rnw-delta="N">` element already
     * carries the rule in the document, so the browser is already applying
     * it; we just need RNW to know about it so subsequent runtime inserts
     * dedup correctly.
     */
    registerExisting(cssText: string, groupValue: number): InsertResult {
      const group = Number(groupValue);
      let groupCreated = false;
      let ruleAdded = false;

      if (ensureGroup(group)) {
        groupCreated = true;
      }

      if (recordRule(group, cssText)) {
        ruleAdded = true;
      }

      return { groupCreated, ruleAdded };
    }
  };

  return OrderedCSSStyleSheet;
}

/**
 * Helper functions
 */

function encodeGroupRule(group) {
  return `[stylesheet-group="${group}"]{}`;
}

const groupPattern = /["']/g;
function decodeGroupRule(cssRule) {
  return Number(cssRule.selectorText.split(groupPattern)[1]);
}

function getOrderedGroups(obj: { [key: number]: any }) {
  return Object.keys(obj)
    .map(Number)
    .sort((a, b) => (a > b ? 1 : -1));
}

const selectorPattern = /\s*([,])\s*/g;
function getSelectorText(cssText) {
  const selector = cssText.split('{')[0].trim();
  return selector !== '' ? selector.replace(selectorPattern, '$1') : null;
}

function insertRuleAt(root, cssText: string, position: number): boolean {
  try {
    // $FlowFixMe: Flow is missing CSSOM types needed to type 'root'.
    root.insertRule(cssText, position);
    return true;
  } catch (e) {
    // JSDOM doesn't support `CSSSMediaRule#insertRule`.
    // Also ignore errors that occur from attempting to insert vendor-prefixed selectors.
    return false;
  }
}
