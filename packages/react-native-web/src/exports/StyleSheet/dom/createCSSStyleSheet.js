/**
 * Copyright (c) Nicolas Gallagher.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 */
import canUseDOM from '../../../modules/canUseDom';

// $FlowFixMe: HTMLStyleElement is incorrectly typed - https://github.com/facebook/flow/issues/2696
export default function createCSSStyleSheet(
  id: string,
  rootNode?: Document | ShadowRoot,
  textContent?: string
): ?CSSStyleSheet {
  if (canUseDOM) {
    const root = rootNode != null ? rootNode : document;
    let element = root.getElementById(id);
    if (element == null) {
      element = document.createElement('style');
      element.setAttribute('id', id);
      if (typeof textContent === 'string') {
        element.appendChild(document.createTextNode(textContent));
      }
      if (root instanceof ShadowRoot) {
        root.insertBefore(element, root.firstChild);
      } else {
        const head = root.head;
        if (head) {
          head.insertBefore(element, head.firstChild);
        }
      }
    }
    // $FlowFixMe: HTMLElement is incorrectly typed
    return element.sheet;
  } else {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Grouped mode
//
// One `<style data-rnw-group="G">` per group, ordered ascending in the DOM.
// Cascade priority then comes from element order, which every browser
// implements and which a streamed chunk can slot into with a two-line
// `insertBefore` — no `@layer`, no specificity tricks, no runtime required.
// ---------------------------------------------------------------------------

export const groupAttr = 'data-rnw-group';
export const deltaAttr = 'data-rnw-delta';

// Anchors are the non-delta elements: the ones a streamed delta inserts
// itself after.
const anchorSelector = `style[${groupAttr}]:not([${deltaAttr}])`;

function readGroup(element: HTMLElement): ?number {
  const raw = element.getAttribute(groupAttr);
  if (raw == null || raw === '') return null;
  const group = Number(raw);
  return isFinite(group) ? group : null;
}

/**
 * Every `<style data-rnw-group>` in `rootNode` as `[group, element]`,
 * ascending by group. `includeDeltas` also picks up streamed delta
 * elements, which carry rules the document is already applying and so
 * must be hydrated into the bookkeeping.
 */
export function findGroupElements(
  rootNode: Document | ShadowRoot,
  includeDeltas?: boolean
): Array<[number, HTMLElement]> {
  const selector = includeDeltas ? `style[${groupAttr}]` : anchorSelector;
  // $FlowFixMe: querySelectorAll types are imperfect for the Document/ShadowRoot union
  const elements = rootNode.querySelectorAll(selector);
  const result = [];
  for (let i = 0; i < elements.length; i++) {
    const group = readGroup(elements[i]);
    if (group != null) result.push([group, elements[i]]);
  }
  result.sort((a, b) => a[0] - b[0]);
  return result;
}

/**
 * Find, or create in ascending position, the anchor element for `group`.
 * Creating on demand is what makes a client-only render work without a
 * server-emitted shell: whichever group is compiled first, the element
 * still lands in the right place relative to the others.
 */
export function createGroupStyleElement(
  group: number,
  rootNode: Document | ShadowRoot,
  textContent?: ?string
): ?HTMLElement {
  // $FlowFixMe: querySelector types are imperfect for the Document/ShadowRoot union
  const existing = rootNode.querySelector(
    `style[${groupAttr}="${group}"]:not([${deltaAttr}])`
  );
  if (existing != null) return existing;

  const element = document.createElement('style');
  element.setAttribute(groupAttr, String(group));
  if (typeof textContent === 'string' && textContent !== '') {
    element.appendChild(document.createTextNode(textContent));
  }

  const anchors = findGroupElements(rootNode);
  let next = null;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i][0] > group) {
      next = anchors[i][1];
      break;
    }
  }

  if (next != null && next.parentNode != null) {
    next.parentNode.insertBefore(element, next);
  } else if (anchors.length > 0) {
    const last = anchors[anchors.length - 1][1];
    if (last.parentNode == null) return null;
    last.parentNode.insertBefore(element, last.nextSibling);
  } else {
    const container =
      rootNode instanceof ShadowRoot ? rootNode : (rootNode: any).head;
    if (container == null) return null;
    container.insertBefore(element, container.firstChild);
  }

  return element;
}

/**
 * The `sheetForGroup` resolver handed to `createOrderedCSSStyleSheet` in
 * grouped mode.
 */
export function createGroupSheetResolver(
  rootNode: Document | ShadowRoot
): (group: number) => ?CSSStyleSheet {
  return (group) => {
    const element = createGroupStyleElement(group, rootNode);
    // $FlowFixMe: HTMLElement is incorrectly typed
    return element != null ? element.sheet : null;
  };
}
