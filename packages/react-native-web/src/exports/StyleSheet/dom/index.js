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
  findGroupStyleElement,
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
//
// RNW no longer *emits* this format — a node React did not render skews
// `hydrateRoot(document, …)`, so `takeDeltaHTML` writes into the anchors'
// CSSOM instead — but a client bundle can be newer than the server that
// rendered the page it boots into, so the reading side stays.
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
    const message =
      'react-native-web: the document contains both per-group ' +
      `<style ${groupAttr}> elements and a <style id="${id}"> element. ` +
      'Their relative cascade order is undefined, so this is never safe. ' +
      'Emit either StyleSheet.takeShellHTML() or ' +
      'AppRegistry.getApplication().getStyleElement(), not both.';
    // Reported *and* thrown. The throw is the behaviour — guessing an order
    // is worse than stopping — but this runs inside `createSheet()`, which
    // runs at module scope of `exports/StyleSheet/index.js`, before any
    // React root exists. So the exception is a module-evaluation failure,
    // and whoever is loading the bundle decides what happens to it: a
    // dynamic `import()` behind `React.lazy` turns it into a boundary's
    // generic "failed to load", and some dev servers report only the
    // request that failed. The console line is the half that cannot be
    // swallowed, and it is the half that names the cause.
    console.error(message);
    throw new Error(message);
  }
  if (hasGrouped) return 'grouped';
  if (hasLegacy) return 'legacy';
  return 'grouped';
}

/**
 * The `[group, CSSStyleSheet]` pairs to hydrate the bookkeeping from.
 *
 * Load-bearing: this reads each element's live `sheet`, not its text. A
 * streamed chunk that landed before RNW booted put its rules into the
 * anchor's CSSOM with `insertRule`, which never writes back to the
 * element's text — so `cssRules` is the only place those rules can be
 * seen, and reading it is what makes the delta queue an optimisation
 * rather than a correctness requirement at boot.
 */
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

// Legacy only. Grouped mode gets these through `collectGroupSheets`, and
// the current wire format emits no `<style data-rnw-delta>` at all; this
// covers a document from an older server that also used upstream's single
// `<style id>` sheet.
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
      // Install the global ingest hook so any delta that streams into the
      // document AFTER this point — when suspense boundaries resolve and
      // React commits their chunk — also gets registered into the
      // bookkeeping. The hook also drains anything that arrived in
      // window.__RNW_DELTA__ before RNW booted, though those rules were
      // already picked up from the anchors' cssRules just above; the
      // queue is what covers the chunks that come later.
      //
      // The predicate is how a chunk that ran before its anchor existed —
      // possible once the app renders `<head>` through React with a
      // Suspense boundary in it — gets applied at the right moment instead
      // of conjuring a `<style>` React never rendered. It asks for a SHELL
      // anchor specifically: an anchor RNW created for itself a moment ago
      // sits wherever `<head>` happened to allow, which is not the cascade
      // bucket the chunk's rules belong in. In legacy mode there is one
      // sheet and it always exists, so the question is moot.
      installDeltaIngest(
        sheets,
        isGroupedMode && docNode != null
          ? (group) => findGroupStyleElement(group, docNode, true) != null
          : null
      );
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
