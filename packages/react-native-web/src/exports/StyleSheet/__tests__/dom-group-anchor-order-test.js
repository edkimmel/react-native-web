/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Where a *newly created* group anchor lands.
 *
 * The whole grouped format rests on one invariant: everything belonging to
 * a lower group precedes everything belonging to a higher one, because DOM
 * order is the only cascade priority in play. Relocated deltas
 * (`<style data-rnw-group="G" data-rnw-delta="N">`) belong to their group
 * just as much as the anchor does, so a group created at runtime has to
 * clear a lower group's deltas, not merely its anchor.
 *
 * The createSheet test uses jest.isolateModules so dom/index.js's
 * module-scope `sheets` array and cached mode start fresh.
 */

const addStyle = (attrs, textContent = '', container = document.head) => {
  const el = document.createElement('style');
  Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
  el.appendChild(document.createTextNode(textContent));
  container.appendChild(el);
  return el;
};

// Every grouped element in DOM order, labelled `group` or `group:deltaN`,
// so an assertion reads as the head's shape rather than as node identity.
const shapeOf = (container) =>
  Array.prototype.slice
    .call(container.querySelectorAll('style[data-rnw-group]'))
    .map((el) => {
      const group = el.getAttribute('data-rnw-group');
      const delta = el.getAttribute('data-rnw-delta');
      return delta == null ? group : `${group}:delta${delta}`;
    });

afterEach(() => {
  document.querySelectorAll('style').forEach((el) => el.remove());
});

describe('createGroupStyleElement placement', () => {
  test('a new highest group lands after the last group’s deltas', () => {
    // The head a streamed page has once the relocation script has run, but
    // missing an anchor for the group about to be compiled.
    addStyle({ 'data-rnw-group': '0' });
    addStyle({ 'data-rnw-group': '1' });
    addStyle({ 'data-rnw-group': '2' }, '.shell-shorthand { margin: 8px }');
    addStyle(
      { 'data-rnw-group': '2', 'data-rnw-delta': '1' },
      '.chunk-shorthand { margin: 12px }'
    );

    const { createGroupStyleElement } = require('../dom/createCSSStyleSheet');
    const element = createGroupStyleElement(
      3,
      document,
      '.runtime-longhand { margin-top: 4px }'
    );

    // Group 3 must outrank every group-2 rule, including the ones the
    // relocated delta carries.
    expect(shapeOf(document.head)).toEqual(['0', '1', '2', '2:delta1', '3']);
    expect(
      element.compareDocumentPosition(
        document.querySelector('style[data-rnw-delta="1"]')
      ) & Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy();
  });

  test('a new group lands before a higher group and after a lower one’s deltas', () => {
    addStyle({ 'data-rnw-group': '1' });
    addStyle(
      { 'data-rnw-group': '1', 'data-rnw-delta': '7' },
      '.chunk-classic { color: red }'
    );
    addStyle({ 'data-rnw-group': '3' });
    addStyle(
      { 'data-rnw-group': '3', 'data-rnw-delta': '8' },
      '.chunk-longhand { margin-top: 4px }'
    );

    const { createGroupStyleElement } = require('../dom/createCSSStyleSheet');
    createGroupStyleElement(2, document, '.runtime-shorthand { margin: 8px }');

    expect(shapeOf(document.head)).toEqual([
      '1',
      '1:delta7',
      '2',
      '3',
      '3:delta8'
    ]);
  });

  test('a new group precedes its own already-streamed deltas', () => {
    // No shell was emitted, so the delta arrived without an anchor to be
    // relocated after. The anchor created later takes the position the
    // shell would have given it: ahead of its own deltas.
    addStyle({ 'data-rnw-group': '0' });
    addStyle(
      { 'data-rnw-group': '2', 'data-rnw-delta': '1' },
      '.chunk-shorthand { margin: 12px }'
    );

    const { createGroupStyleElement } = require('../dom/createCSSStyleSheet');
    createGroupStyleElement(2, document, '.runtime-shorthand { margin: 8px }');

    expect(shapeOf(document.head)).toEqual(['0', '2', '2:delta1']);
  });

  test('an empty head takes the element as its first child', () => {
    const other = document.createElement('meta');
    document.head.appendChild(other);

    const { createGroupStyleElement } = require('../dom/createCSSStyleSheet');
    const element = createGroupStyleElement(3, document);

    expect(document.head.firstChild).toBe(element);
    document.head.removeChild(other);
  });

  test('a ShadowRoot orders anchors around deltas the same way', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    addStyle({ 'data-rnw-group': '2' }, '', shadow);
    addStyle(
      { 'data-rnw-group': '2', 'data-rnw-delta': '1' },
      '.chunk-shorthand { margin: 12px }',
      shadow
    );

    const { createGroupStyleElement } = require('../dom/createCSSStyleSheet');
    createGroupStyleElement(3, shadow, '.runtime-longhand { margin-top: 4px }');

    expect(shapeOf(shadow)).toEqual(['2', '2:delta1', '3']);
    expect(shadow.lastChild.parentNode).toBe(shadow);
    document.body.removeChild(host);
  });

  // A delta whose group has no anchor stays in <body> by design (the
  // relocation script has nowhere to move it to). It is still a
  // `style[data-rnw-group]`, so the placement scan sees it — and must not
  // treat it as a neighbour to be inserted next to, since that would put
  // the anchor in the body, outside the ordering scheme entirely.
  test('a body-resident delta cannot drag a new anchor out of the head', () => {
    addStyle({ 'data-rnw-group': '0' });
    addStyle({ 'data-rnw-group': '1' });
    addStyle({ 'data-rnw-group': '2' });
    const stranded = addStyle(
      { 'data-rnw-group': '3', 'data-rnw-delta': '1' },
      '.stranded-longhand { margin-top: 4px }',
      document.body
    );

    const { createGroupStyleElement } = require('../dom/createCSSStyleSheet');
    const element = createGroupStyleElement(4, document, '.g4 { top: 0 }');

    expect(element.parentNode).toBe(document.head);
    expect(shapeOf(document.head)).toEqual(['0', '1', '2', '4']);
    // The stranded delta is left exactly where it was.
    expect(stranded.parentNode).toBe(document.body);
  });

  test('body-resident deltas do not become the container when the head is empty', () => {
    // `detectMode` reads this document as grouped — a delta carries
    // `data-rnw-group` too — so the very first anchor is created against a
    // head that has none, while the body does.
    addStyle(
      { 'data-rnw-group': '2', 'data-rnw-delta': '1' },
      '.stranded-shorthand { margin: 12px }',
      document.body
    );

    const { createGroupStyleElement } = require('../dom/createCSSStyleSheet');
    const element = createGroupStyleElement(0, document, '.g0 { margin: 0 }');

    expect(element.parentNode).toBe(document.head);
    expect(document.head.firstChild).toBe(element);
  });

  test('createSheet compiles a new group into the correct position', () => {
    jest.isolateModules(() => {
      addStyle({ 'data-rnw-group': '0' });
      addStyle({ 'data-rnw-group': '2' }, '.shell-shorthand { margin: 8px }');
      addStyle(
        { 'data-rnw-group': '2', 'data-rnw-delta': '1' },
        '.chunk-shorthand { margin: 12px }'
      );

      const { createSheet } = require('../dom');
      const sheet = createSheet();
      // Group 3 is longhands: they only override the group-2 shorthands if
      // their element outranks every group-2 element in the head.
      sheet.insert('.runtime-longhand { margin-top: 4px }', 3);

      expect(shapeOf(document.head)).toEqual(['0', '2', '2:delta1', '3']);
    });
  });
});
