/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `createSheet` supports two stylesheet formats and infers which one it is
 * in from the DOM — never from a flag, because a flag can disagree with the
 * document. Two modes means two things that can rot, so both are covered
 * here explicitly rather than one inheriting the other's coverage.
 *
 * Each test uses jest.isolateModules so dom/index.js's module-scope `sheets`
 * array and cached mode start fresh.
 */

const addStyle = (attrs, textContent = '') => {
  const el = document.createElement('style');
  Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
  el.appendChild(document.createTextNode(textContent));
  document.head.appendChild(el);
  return el;
};

const groupElements = () =>
  Array.prototype.slice
    .call(document.head.querySelectorAll('style[data-rnw-group]'))
    .map((el) => el.getAttribute('data-rnw-group'));

afterEach(() => {
  document.querySelectorAll('style').forEach((el) => el.remove());
});

describe('createSheet mode detection', () => {
  test('nothing in the document -> grouped (the default)', () => {
    jest.isolateModules(() => {
      const { createSheet } = require('../dom');
      const sheet = createSheet();
      sheet.insert('.mode-default { margin-top: 4px }', 3);

      expect(groupElements()).toContain('3');
      expect(document.getElementById('react-native-stylesheet')).toBe(null);
    });
  });

  test('per-group anchors present -> grouped, and they are adopted', () => {
    jest.isolateModules(() => {
      addStyle({ 'data-rnw-group': '0' });
      addStyle({ 'data-rnw-group': '2' }, '.ssr-shorthand { margin: 8px }');
      addStyle({ 'data-rnw-group': '3' });

      const { createSheet } = require('../dom');
      const sheet = createSheet();

      // Adopted, not re-inserted: the SSR rule is already in the document.
      expect(sheet.insert('.ssr-shorthand { margin: 8px }', 2).ruleAdded).toBe(
        false
      );
      expect(sheet.getTextContent()).toContain('.ssr-shorthand');

      // A runtime insert appends to its own group's element.
      sheet.insert('.runtime-longhand { margin-top: 4px }', 3);
      const group3 = document.querySelector(
        'style[data-rnw-group="3"]:not([data-rnw-delta])'
      );
      expect(group3.sheet.cssRules.length).toBe(1);
      expect(group3.sheet.cssRules[0].cssText).toContain('.runtime-longhand');
    });
  });

  test('a new group is created in ascending position, not appended', () => {
    jest.isolateModules(() => {
      addStyle({ 'data-rnw-group': '3' });

      const { createSheet } = require('../dom');
      const sheet = createSheet();
      // Group 0 comes from initialRules, then 2 below. Both must land
      // before the pre-existing group-3 anchor or the cascade inverts.
      sheet.insert('.late-group { margin: 8px }', 2);

      expect(groupElements()).toEqual(['0', '2', '3']);
    });
  });

  test('#react-native-stylesheet present -> legacy, upstream behavior', () => {
    jest.isolateModules(() => {
      const legacy = addStyle(
        { id: 'react-native-stylesheet' },
        '[stylesheet-group="2"]{}\n.legacy-shorthand { margin: 8px }'
      );

      const { createSheet } = require('../dom');
      const sheet = createSheet();

      // Adopted from the marker-delimited single sheet.
      expect(
        sheet.insert('.legacy-shorthand { margin: 8px }', 2).ruleAdded
      ).toBe(false);

      // Runtime inserts go into that same element, positioned by the
      // marker rules — no per-group elements are created.
      sheet.insert('.legacy-longhand { margin-top: 4px }', 3);
      expect(groupElements()).toEqual([]);
      const text = Array.prototype.slice
        .call(legacy.sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n');
      expect(text).toContain('.legacy-longhand');
      expect(text).toContain('stylesheet-group');
    });
  });

  test('boots against a post-relocation head and dedups every rule', () => {
    jest.isolateModules(() => {
      // The head shape a streamed page has by the time RNW's bundle runs:
      // per-group anchors, each followed by the deltas relocated into it.
      addStyle({ 'data-rnw-group': '0' });
      addStyle({ 'data-rnw-group': '1' });
      addStyle({ 'data-rnw-group': '2' }, '.shell-shorthand { margin: 8px }');
      addStyle(
        { 'data-rnw-group': '2', 'data-rnw-delta': '1' },
        '.chunk-shorthand { margin: 12px }'
      );
      addStyle(
        { 'data-rnw-group': '3' },
        '.shell-longhand { margin-top: 4px }'
      );
      addStyle(
        { 'data-rnw-group': '3', 'data-rnw-delta': '2' },
        '.chunk-longhand { margin-top: 6px }'
      );

      const { createSheet } = require('../dom');
      const sheet = createSheet();

      // Rules from anchors and from relocated deltas alike are already in
      // the document, so none of them may be re-inserted at runtime.
      [
        ['.shell-shorthand { margin: 8px }', 2],
        ['.chunk-shorthand { margin: 12px }', 2],
        ['.shell-longhand { margin-top: 4px }', 3],
        ['.chunk-longhand { margin-top: 6px }', 3]
      ].forEach(([cssText, group]) => {
        expect(sheet.insert(cssText, group).ruleAdded).toBe(false);
      });

      // A genuinely new rule goes into its group's *anchor*, never into a
      // delta element — deltas are inert once relocated.
      sheet.insert('.runtime-shorthand { margin: 16px }', 2);
      const anchor = document.querySelector(
        'style[data-rnw-group="2"]:not([data-rnw-delta])'
      );
      const delta = document.querySelector('style[data-rnw-delta="1"]');
      expect(anchor.sheet.cssRules.length).toBe(2);
      expect(delta.sheet.cssRules.length).toBe(1);

      // No new anchors were invented for groups that already had one.
      expect(groupElements()).toEqual(['0', '1', '2', '2', '3', '3']);
    });
  });

  test('both formats present -> throws in development', () => {
    jest.isolateModules(() => {
      addStyle({ 'data-rnw-group': '0' });
      addStyle({ id: 'react-native-stylesheet' }, '[stylesheet-group="0"]{}');

      const { createSheet } = require('../dom');
      // Relative order between an anchor set and a monolithic sheet is
      // undefined, so guessing would be worse than failing.
      expect(() => createSheet()).toThrow(/both/);
    });
  });
});
