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
// implements — no `@layer`, no specificity tricks. A streamed chunk does not
// slot a node in between them: it writes straight into the anchor's own
// CSSOM with `insertRule`, so its rules take the anchor's position in the
// cascade and leave no element behind to be relocated or hydrated against.
// Only the case where the anchor has not arrived yet needs the runtime.
// ---------------------------------------------------------------------------

export const groupAttr = 'data-rnw-group';
export const deltaAttr = 'data-rnw-delta';
// Marks an anchor this library created at runtime, as opposed to one the
// server emitted (the "shell" anchors) — which on a React-rendered `<head>`
// means one React rendered and owns.
//
// The distinction is not cosmetic. RNW's sheet boots when the client bundle
// evaluates, which on a streaming `<head>` is BEFORE the shell anchors have
// arrived: React flushes `<head>` with a `<!--$?-->` placeholder where the
// boundary will go and streams its contents later, on both 18 and 19. So the
// runtime creates anchors of its own, and moments later the server's turn up
// beside them. Three things then have to prefer the server's:
//
//   - `<StyleSheet.Anchors>` on the client, which mirrors the document back to
//     React and must mirror exactly what the server sent, not what RNW added;
//   - `sheetForGroup`, because the shell anchors are the ones whose DOM
//     position defines the cascade;
//   - a streamed delta, for the same reason.
//
// The runtime anchors then hold only rules the shell already carries (they
// are compiled from the same modules), so they change no outcome; they are
// simply where the rules lived before the shell landed.
export const runtimeAttr = 'data-rnw-runtime';

// Anchors are the non-delta elements: the ones a streamed delta writes into.
const anchorSelector = `style[${groupAttr}]:not([${deltaAttr}])`;
// The subset the server emitted.
const shellAnchorSelector = `style[${groupAttr}]:not([${deltaAttr}]):not([${runtimeAttr}])`;

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
  return queryGroupElements(
    rootNode,
    includeDeltas ? `style[${groupAttr}]` : anchorSelector
  );
}

/**
 * Only the anchors the server emitted, ascending. What
 * `<StyleSheet.Anchors>` reproduces on the client: hydration compares the
 * element's `innerHTML`, so the set has to be exactly the server's.
 */
export function findShellAnchors(
  rootNode: Document | ShadowRoot
): Array<[number, HTMLElement]> {
  return queryGroupElements(rootNode, shellAnchorSelector);
}

function queryGroupElements(
  rootNode: Document | ShadowRoot,
  selector: string
): Array<[number, HTMLElement]> {
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
 * The anchor element for `group`, or null. Never creates.
 *
 * Split out from `createGroupStyleElement` because the streaming-delta
 * queue needs to ask the question without answering it: a queued chunk
 * whose anchor is missing must WAIT for React to render that anchor, not
 * synthesise one. A `<style>` this library created, sitting between
 * `<style>` elements React rendered in `<head>`, is the one shape measured
 * to silently mis-bind `hydrateRoot(document, …)` — React matches
 * hydration candidates by tag, so a same-tag intruder is indistinguishable
 * from the node it expected and every later sibling shifts by one.
 */
export function findGroupStyleElement(
  group: number,
  rootNode: Document | ShadowRoot,
  shellOnly?: boolean
): ?HTMLElement {
  // The server's anchor wins over one this library created for the same
  // group: it is the one React rendered, and the one whose position in
  // `<head>` is the cascade bucket everything else is ordered against.
  // $FlowFixMe: querySelector types are imperfect for the Document/ShadowRoot union
  const shell = rootNode.querySelector(
    `style[${groupAttr}="${group}"]:not([${deltaAttr}]):not([${runtimeAttr}])`
  );
  if (shell != null || shellOnly === true) return shell;
  // $FlowFixMe: querySelector types are imperfect for the Document/ShadowRoot union
  return rootNode.querySelector(
    `style[${groupAttr}="${group}"]:not([${deltaAttr}])`
  );
}

/**
 * Find, or create in ascending position, the anchor element for `group`.
 * Creating on demand is what makes a client-only render work without a
 * server-emitted shell: whichever group is compiled first, the element
 * still lands in the right place relative to the others.
 *
 * ## Why this creates where a streamed delta refuses to
 *
 * A delta whose anchor is missing queues its rules rather than synthesising
 * a `<style>`, because that node is the one shape measured to mis-bind
 * `hydrateRoot(document, …)` (see `findGroupStyleElement`). This function
 * creates the same node in the same place, and the difference is not that
 * the hazard is smaller here — it is that the alternatives are not the same.
 *
 * A delta that declines to place its rules loses nothing: the payload stays
 * in `window.__RNW_DELTA__` and somebody else — a later chunk, RNW's boot,
 * `<StyleSheet.Anchors>`'s commit — applies it once an anchor exists. This
 * function is that somebody else. It is called from `sheetForGroup`, and
 * `groupedInsert` treats a null sheet as "the rule was rejected" and
 * un-records it, so declining here does not defer a rule, it drops one
 * permanently. There is also nowhere to defer *to*: the rules arriving
 * through this path are the ones the app is compiling right now, for markup
 * it is rendering right now.
 *
 * So the node is created, and the cost is paid where it can be seen: when
 * the anchors turn out to be React's after all, `<StyleSheet.Anchors>`'s
 * commit reports it (development only, React 18 only, which is the major
 * where the skew is harmful). The arrangements that avoid the window
 * altogether — anchors above the `<head>` boundary, or a client bundle that
 * loads after `<head>` has streamed — are named there.
 */
export function createGroupStyleElement(
  group: number,
  rootNode: Document | ShadowRoot,
  textContent?: ?string
): ?HTMLElement {
  const existing = findGroupStyleElement(group, rootNode);
  if (existing != null) return existing;

  const element = document.createElement('style');
  element.setAttribute(groupAttr, String(group));
  element.setAttribute(runtimeAttr, '');
  if (typeof textContent === 'string' && textContent !== '') {
    element.appendChild(document.createTextNode(textContent));
  }

  // Anchors only ever live in one place, and the new one has to go there
  // too. Deciding the parent from a neighbour instead would let a stray
  // element decide it: a delta whose group has no anchor deliberately
  // stays in <body> rather than relocating, and adopting *its* parent
  // would create the anchor in the body, where the whole ascending-order
  // scheme no longer applies.
  const container =
    rootNode instanceof ShadowRoot ? rootNode : (rootNode: any).head;
  if (container == null) return null;

  // Within the container, deltas count for placement just as anchors do. A
  // relocated delta sits after its group's anchor and carries that group's
  // rules with the full weight of DOM order, so a new higher-numbered
  // group dropped "after the last anchor" would land *before* that
  // anchor's deltas and lose the cascade to a lower group — the exact
  // inversion ascending element order exists to prevent. Elements outside
  // the container are ignored for the same reason they cannot supply the
  // parent: their position says nothing about where the anchors run.
  const elements = findGroupElements(rootNode, true).filter(
    ([, el]) => el.parentNode === container
  );
  // `>=` rather than `>`: an anchor for `group` cannot exist (checked
  // above), but its deltas can if the document streamed them without a
  // shell. Going in front of them reproduces the shape a shell would have
  // produced — anchor first, its deltas after it — so runtime rules keep
  // yielding to the server's within the group, as they do everywhere else.
  let next = null;
  for (let i = 0; i < elements.length; i++) {
    if (elements[i][0] >= group) {
      next = elements[i][1];
      break;
    }
  }

  if (next != null) {
    container.insertBefore(element, next);
  } else if (elements.length > 0) {
    const last = elements[elements.length - 1][1];
    container.insertBefore(element, last.nextSibling);
  } else {
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
