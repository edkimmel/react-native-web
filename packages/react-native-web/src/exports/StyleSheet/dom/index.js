/**
 * Copyright (c) Nicolas Gallagher.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */

import type {
  InsertResult,
  OrderedCSSStyleSheet
} from './createOrderedCSSStyleSheet';
import canUseDOM from '../../../modules/canUseDom';
import createCSSStyleSheet, {
  createGroupSheetResolver,
  createGroupStyleElement,
  findGroupElements,
  groupAttr
} from './createCSSStyleSheet';
import createOrderedCSSStyleSheet from './createOrderedCSSStyleSheet';
import { installDeltaIngest } from './ingestDelta';

type Sheet = {
  ...OrderedCSSStyleSheet,
  id: string
};

export type { InsertResult } from './createOrderedCSSStyleSheet';

const defaultId = 'react-native-stylesheet';
// Attribute marking server-emitted streaming delta `<style>` elements.
// Initial hydration scans these so the dedup map / groups records reflect
// every rule that is already present in the document, regardless of which
// `<style>` element it physically lives in.
const deltaAttr = 'data-rnw-delta';
const roots = new WeakMap<Node, number>();
const sheets = [];
// The mode is decided once, when the first sheet boots, and every
// subsequent root (iframe, shadow root) follows it. Those roots are created
// by RNW itself and are always empty, so re-detecting per root would just
// return the default.
let isGroupedMode = false;

/**
 * Which stylesheet format this document is in. Inferred from the DOM, never
 * signalled: the DOM is ground truth, and a wire flag only adds a state
 * where the flag and the document disagree.
 *
 *   per-group anchors present -> 'grouped' (streaming format)
 *   #react-native-stylesheet  -> 'legacy'  (upstream's single sheet)
 *   neither                   -> 'grouped'
 *
 * Grouped is the default for client-only rendering too, so the streaming
 * path stays the well-trodden one rather than the under-tested one.
 */
function detectMode(
  rootNode: Document | ShadowRoot,
  id: string
): 'grouped' | 'legacy' {
  // $FlowFixMe: querySelector types are imperfect for the Document/ShadowRoot union
  const hasGrouped = rootNode.querySelector(`style[${groupAttr}]`) != null;
  const hasLegacy = rootNode.getElementById(id) != null;
  if (hasGrouped && hasLegacy && process.env.NODE_ENV !== 'production') {
    throw new Error(
      'react-native-web: the document contains both per-group ' +
        `<style ${groupAttr}> elements and a <style id="${id}"> element. ` +
        'Their relative cascade order is undefined, so this is never safe. ' +
        'Emit either StyleSheet.takeShellHTML() or ' +
        'AppRegistry.getApplication().getStyleElement(), not both.'
    );
  }
  if (hasGrouped) return 'grouped';
  if (hasLegacy) return 'legacy';
  return 'grouped';
}

function collectGroupSheets(
  rootNode: Document | ShadowRoot
): Array<[number, CSSStyleSheet]> {
  const result: Array<[number, CSSStyleSheet]> = [];
  findGroupElements(rootNode, true).forEach(([group, element]) => {
    // $FlowFixMe — HTMLStyleElement.sheet is incorrectly typed
    const s: ?CSSStyleSheet = element.sheet;
    if (s != null) result.push([group, s]);
  });
  return result;
}

function createGroupedSheet(
  rootNode: Document | ShadowRoot
): OrderedCSSStyleSheet {
  return createOrderedCSSStyleSheet(null, null, {
    hydrateFrom: collectGroupSheets(rootNode),
    sheetForGroup: createGroupSheetResolver(rootNode)
  });
}

function collectDeltaSheets(
  rootNode: Document | ShadowRoot
): Array<CSSStyleSheet> {
  // $FlowFixMe — querySelectorAll types are imperfect for Document/ShadowRoot union
  const elements = rootNode.querySelectorAll(`style[${deltaAttr}]`);
  const result: Array<CSSStyleSheet> = [];
  for (let i = 0; i < elements.length; i++) {
    // $FlowFixMe — HTMLStyleElement.sheet is incorrectly typed
    const s: ?CSSStyleSheet = elements[i].sheet;
    if (s != null) result.push(s);
  }
  return result;
}

const initialRules = [
  // minimal top-level reset
  'html{-ms-text-size-adjust:100%;-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:rgba(0,0,0,0);}',
  'body{margin:0;}',
  // minimal form pseudo-element reset
  'button::-moz-focus-inner,input::-moz-focus-inner{border:0;padding:0;}',
  'input::-webkit-search-cancel-button,input::-webkit-search-decoration,input::-webkit-search-results-button,input::-webkit-search-results-decoration{display:none;}'
];

export function createSheet(
  root?: HTMLElement,
  id?: string = defaultId
): Sheet {
  let sheet;

  if (canUseDOM) {
    const rootNode: Node = root != null ? root.getRootNode() : document;
    // Create the initial style sheet
    if (sheets.length === 0) {
      // Hydrate from whatever the document already carries. Browsers apply
      // CSS from server-emitted <style> elements directly (that is the
      // no-FOUC guarantee), but RNW's selectors/groups records must also
      // know about those rules so runtime StyleSheet.create calls don't
      // re-insert duplicates.
      const docNode: ?(Document | ShadowRoot) =
        rootNode instanceof Document || rootNode instanceof ShadowRoot
          ? rootNode
          : document;
      isGroupedMode = docNode != null && detectMode(docNode, id) === 'grouped';
      if (isGroupedMode && docNode != null) {
        sheet = createGroupedSheet(docNode);
      } else {
        // Legacy: upstream's single <style id="react-native-stylesheet">,
        // plus any <style data-rnw-delta> elements in the older format.
        const primary = createCSSStyleSheet(id);
        const deltas = docNode != null ? collectDeltaSheets(docNode) : [];
        sheet = createOrderedCSSStyleSheet(primary, deltas);
      }
      initialRules.forEach((rule) => {
        sheet.insert(rule, 0);
      });
      roots.set(rootNode, sheets.length);
      sheets.push(sheet);
      // Install the global ingest hook so any `<style data-rnw-delta>`
      // elements that stream into the document AFTER this point — when
      // suspense boundaries resolve and React commits their chunk —
      // also get registered into the bookkeeping. The hook also drains
      // any IDs that arrived in window.__RNW_DELTA__ before RNW booted.
      installDeltaIngest(sheets);
    } else {
      const index = roots.get(rootNode);
      if (index == null) {
        const initialSheet = sheets[0];
        // Cast rootNode to 'any' because Flow types for getRootNode are wrong
        const docNode: Document | ShadowRoot = (rootNode: any);
        if (isGroupedMode) {
          // Mirror the primary sheet into this root as N per-group elements,
          // preserving the ascending order the cascade depends on.
          const groupText =
            initialSheet != null ? initialSheet.getGroupTextContent() : [];
          groupText.forEach(([group, textContent]) => {
            createGroupStyleElement(group, docNode, textContent);
          });
          sheet = createGroupedSheet(docNode);
        } else {
          // If we're creating a new sheet, populate it with existing styles
          const textContent =
            initialSheet != null ? initialSheet.getTextContent() : '';
          sheet = createOrderedCSSStyleSheet(
            createCSSStyleSheet(id, docNode, textContent)
          );
        }
        roots.set(rootNode, sheets.length);
        sheets.push(sheet);
      } else {
        sheet = sheets[index];
      }
    }
  } else {
    // Create the initial style sheet
    if (sheets.length === 0) {
      sheet = createOrderedCSSStyleSheet(createCSSStyleSheet(id));
      initialRules.forEach((rule) => {
        sheet.insert(rule, 0);
      });
      sheets.push(sheet);
    } else {
      sheet = sheets[0];
    }
  }

  return {
    getGroupTextContent() {
      return sheet.getGroupTextContent();
    },
    // The revision clock and the log both come from the primary sheet.
    // Secondary sheets (iframe / shadow clones) mirror its content, so they
    // carry no information the primary does not already have.
    getRevision() {
      return sheets.length > 0 ? sheets[0].getRevision() : 0;
    },
    getRulesSince(revision: number): Array<[number, string]> {
      return sheets.length > 0 ? sheets[0].getRulesSince(revision) : [];
    },
    getTextContent() {
      return sheet.getTextContent();
    },
    id,
    insert(cssText: string, groupValue: number): InsertResult {
      // Forward the primary sheet's result. Secondary sheets (e.g. Shadow DOM
      // clones) inherit the same dedup state so the primary's signal is the
      // authoritative answer for whether new content was added.
      let result: InsertResult = { groupCreated: false, ruleAdded: false };
      sheets.forEach((s, index) => {
        const r = s.insert(cssText, groupValue);
        if (index === 0) {
          result = r;
        }
      });
      return result;
    },
    registerExisting(cssText: string, groupValue: number): InsertResult {
      let result: InsertResult = { groupCreated: false, ruleAdded: false };
      sheets.forEach((s, index) => {
        const r = s.registerExisting(cssText, groupValue);
        if (index === 0) {
          result = r;
        }
      });
      return result;
    }
  };
}
