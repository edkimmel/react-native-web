/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

type Groups = { [key: number]: { rules: Array<string> } };
type Selectors = { [key: string]: boolean };

export type InsertResult = {|
  // True iff the user rule passed the selectors dedup check and was appended
  // to the group's rule list. False if the selector was already known or the
  // rule was rejected by the CSSOM.
  ruleAdded: boolean,
  // True iff this insert created a brand-new group (the layer was introduced
  // for the first time).
  groupCreated: boolean
|};

export type OrderedCSSStyleSheet = {|
  getTextContent: () => string,
  insert: (cssText: string, groupValue: number) => InsertResult,
  // Update the bookkeeping (groups + selectors) as if the rule had been
  // inserted, but skip the CSSOM `insertRule` call. Used to tell the runtime
  // sheet about rules that already exist in a separate `<style>` element
  // (e.g. a streaming SSR delta tag) so it does not re-insert them at runtime.
  registerExisting: (cssText: string, groupValue: number) => InsertResult
|};

const slice = Array.prototype.slice;

/**
 * Order-based insertion of CSS using CSS Cascade Layers.
 *
 * Each rule is associated with a numerically defined group. Each group maps
 * to a named CSS layer `rnw-<group>` (with `.` substituted to `-` so the
 * name is a valid CSS identifier). Layer cascade priority is governed by
 * the order layers are declared, which `getTextContent` and runtime inserts
 * keep in ascending numerical order — higher group number wins.
 *
 * Cascade by layer is enforced by the browser regardless of stylesheet or
 * DOM position, so cross-sheet conflicts (between server-emitted delta
 * `<style>` elements and the primary runtime sheet) resolve correctly
 * without needing to physically transfer rules between sheets or pre-place
 * the primary at the end of `<head>`.
 *
 * Layer declarations are idempotent: re-declaring a layer in a later
 * stylesheet has no effect on the established order. Each emit includes a
 * declaration covering every group it knows about so consumers can read
 * the full priority order from any single stylesheet without ambiguity.
 */
export default function createOrderedCSSStyleSheet(
  sheet: ?CSSStyleSheet,
  additionalSheets?: ?$ReadOnlyArray<CSSStyleSheet>
): OrderedCSSStyleSheet {
  const groups: Groups = {};
  const selectors: Selectors = {};

  /**
   * Hydrate records from rules in a CSSStyleSheet. Walks `@layer rnw-N { … }`
   * blocks (CSSLayerBlockRules), extracts the group from the layer name, and
   * registers each inner rule in the bookkeeping.
   */
  function hydrate(source: CSSStyleSheet) {
    slice.call(source.cssRules).forEach((cssRule) => {
      const group = decodeLayerBlockGroup(cssRule);
      if (group == null) return;
      // CSSLayerBlockRule extends CSSGroupingRule which has `.cssRules`.
      const innerRules = cssRule.cssRules;
      if (innerRules == null) return;
      if (groups[group] == null) {
        groups[group] = { rules: [] };
      }
      slice.call(innerRules).forEach((innerRule) => {
        const innerText = innerRule.cssText;
        const selectorText = getSelectorText(innerText);
        if (selectorText != null && selectors[selectorText] == null) {
          selectors[selectorText] = true;
          groups[group].rules.push(innerText);
        }
      });
    });
  }

  if (sheet != null) {
    hydrate(sheet);
  }
  if (additionalSheets != null) {
    additionalSheets.forEach((s) => {
      if (s != null) hydrate(s);
    });
  }

  function sheetInsert(sheet, group, cssText): boolean {
    // Wrap the rule in its layer block. Position within the stylesheet is
    // irrelevant for cascade — the layer determines priority — so we just
    // append at the end.
    const layered = `@layer ${layerNameForGroup(group)} { ${cssText} }`;
    return insertRuleAt(sheet, layered, sheet.cssRules.length);
  }

  const OrderedCSSStyleSheet = {
    /**
     * Serialize the sheet as CSS text. Emits a `@layer name1, name2, …;`
     * declaration at the top in ascending group order, then a per-group
     * `@layer name { rules }` block for each non-empty group.
     */
    getTextContent(): string {
      const orderedGroups = getOrderedGroups(groups);
      if (orderedGroups.length === 0) return '';
      const layerNames = orderedGroups.map(layerNameForGroup);
      const declaration = `@layer ${layerNames.join(', ')};`;
      const blocks = orderedGroups.map((group) => {
        // Sort within group for deterministic output (matches the prior
        // build-time-extraction semantics).
        const rules = groups[group].rules.slice().sort();
        return `@layer ${layerNameForGroup(group)} {\n${rules.join('\n')}\n}`;
      });
      return [declaration, ...blocks].join('\n');
    },

    /**
     * Insert a rule into the style sheet under its group's layer. Returns
     * details about whether the group and/or rule were actually added so
     * callers can mirror genuine mutations into a side channel (e.g. an
     * ALS per-request delta buffer) without re-implementing the dedup
     * logic.
     */
    insert(cssText: string, groupValue: number): InsertResult {
      const group = Number(groupValue);
      let groupCreated = false;
      let ruleAdded = false;

      if (groups[group] == null) {
        groups[group] = { rules: [] };
        groupCreated = true;
      }

      const selectorText = getSelectorText(cssText);
      if (selectorText != null && selectors[selectorText] == null) {
        selectors[selectorText] = true;
        groups[group].rules.push(cssText);
        ruleAdded = true;
        if (sheet != null) {
          const isInserted = sheetInsert(sheet, group, cssText);
          if (!isInserted) {
            // Revert internal record change if a rule was rejected (e.g.,
            // unrecognized pseudo-selector).
            groups[group].rules.pop();
            delete selectors[selectorText];
            ruleAdded = false;
          }
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

      if (groups[group] == null) {
        groups[group] = { rules: [] };
        groupCreated = true;
      }

      const selectorText = getSelectorText(cssText);
      if (selectorText != null && selectors[selectorText] == null) {
        selectors[selectorText] = true;
        groups[group].rules.push(cssText);
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

// Encode a group number as a CSS layer name. CSS identifiers can't contain
// `.`; substitute with `-`. Supports at most one decimal point per group
// number (matches RNW's compiler output).
function layerNameForGroup(group: number): string {
  return `rnw-${String(group).replace('.', '-')}`;
}

// Decode `rnw-X` or `rnw-X-Y` → X or X.Y. Returns null on malformed input.
function groupForLayerName(name: ?string): ?number {
  if (name == null || name.indexOf('rnw-') !== 0) return null;
  const rest = name.slice(4);
  if (rest === '') return null;
  // Substitute `-` back to `.` then parse. Only the first `-` is meaningful
  // (RNW group numbers have at most one decimal place); additional dashes
  // would produce NaN here and the rule is skipped.
  const n = Number(rest.replace(/-/g, '.'));
  return isFinite(n) ? n : null;
}

// Extract the group number from a `@layer rnw-N { … }` CSSLayerBlockRule.
// Returns null for any rule that isn't a layer block we own.
function decodeLayerBlockGroup(cssRule: {
  cssText: string,
  name?: string
}): ?number {
  // Prefer the structured `.name` property when available (CSSLayerBlockRule).
  if (typeof cssRule.name === 'string') {
    return groupForLayerName(cssRule.name);
  }
  // Fallback for environments that don't expose `.name`: regex the cssText.
  const cssText = cssRule.cssText;
  if (cssText == null || cssText.indexOf('@layer ') !== 0) return null;
  const match = cssText.match(/^@layer\s+([\w-]+)\s*\{/);
  if (match == null) return null;
  return groupForLayerName(match[1]);
}

function getOrderedGroups(obj: { [key: number]: any }): Array<number> {
  return Object.keys(obj)
    .map(Number)
    .sort((a, b) => (a > b ? 1 : -1));
}

const selectorPattern = /\s*([,])\s*/g;
function getSelectorText(cssText: string): ?string {
  const selector = cssText.split('{')[0].trim();
  return selector !== '' ? selector.replace(selectorPattern, '$1') : null;
}

function insertRuleAt(root, cssText: string, position: number): boolean {
  try {
    // $FlowFixMe: Flow is missing CSSOM types needed to type 'root'.
    root.insertRule(cssText, position);
    return true;
  } catch (e) {
    // Ignore errors from attempting to insert vendor-prefixed selectors or
    // unsupported at-rules.
    return false;
  }
}
