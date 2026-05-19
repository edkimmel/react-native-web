/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import createOrderedCSSStyleSheet from '../dom/createOrderedCSSStyleSheet';

const insertStyleElement = () => {
  const element = document.createElement('style');
  const head = document.head;
  head.insertBefore(element, head.firstChild);
  return element;
};

const removeStyleElement = (element) => {
  document.head.removeChild(element);
};

describe('createOrderedCSSStyleSheet', () => {
  describe('#insert', () => {
    test('insertion order for same group', () => {
      const sheet = createOrderedCSSStyleSheet();

      expect(sheet.getTextContent()).toBe('');

      sheet.insert('.a {}', 0);
      expect(sheet.getTextContent()).toBe(
        '@layer rnw-0;\n@layer rnw-0 {\n.a {}\n}'
      );

      sheet.insert('.b {}', 0);
      expect(sheet.getTextContent()).toBe(
        '@layer rnw-0;\n@layer rnw-0 {\n.a {}\n.b {}\n}'
      );

      sheet.insert('.c {}', 0);
      expect(sheet.getTextContent()).toBe(
        '@layer rnw-0;\n@layer rnw-0 {\n.a {}\n.b {}\n.c {}\n}'
      );
    });

    test('deduplication for same group', () => {
      const sheet = createOrderedCSSStyleSheet();

      sheet.insert('.a {}', 0);
      sheet.insert('.a {}', 0);
      sheet.insert('.a {}', 0);

      expect(sheet.getTextContent()).toBe(
        '@layer rnw-0;\n@layer rnw-0 {\n.a {}\n}'
      );
    });

    test('order for same group', () => {
      const sheet = createOrderedCSSStyleSheet();

      sheet.insert('.c {}', 0);
      sheet.insert('.b {}', 0);
      sheet.insert('.a {}', 0);

      // Sort within group remains alphabetical for deterministic output.
      expect(sheet.getTextContent()).toBe(
        '@layer rnw-0;\n@layer rnw-0 {\n.a {}\n.b {}\n.c {}\n}'
      );
    });

    test('layer declaration lists every group in ascending order', () => {
      const sheet = createOrderedCSSStyleSheet();

      sheet.insert('.nine-1 {}', 9.9);
      sheet.insert('.three {}', 3);
      sheet.insert('.one {}', 1);
      sheet.insert('.two {}', 2.2);

      const text = sheet.getTextContent();
      // Declaration line establishes layer priority across the whole
      // document — ascending order so higher groups win cascade.
      expect(text).toMatch(/^@layer rnw-1, rnw-2-2, rnw-3, rnw-9-9;/);
      // Each group's rules live in its own block.
      expect(text).toContain('@layer rnw-1 {\n.one {}\n}');
      expect(text).toContain('@layer rnw-2-2 {\n.two {}\n}');
      expect(text).toContain('@layer rnw-3 {\n.three {}\n}');
      expect(text).toContain('@layer rnw-9-9 {\n.nine-1 {}\n}');
    });
  });

  describe('client-side hydration', () => {
    let element;

    beforeEach(() => {
      if (element != null) {
        removeStyleElement(element);
      }
      element = insertStyleElement();
    });

    test('from SSR CSS', () => {
      // Setup SSR CSS
      const serverSheet = createOrderedCSSStyleSheet();
      serverSheet.insert('.one { width: 10px; }', 1);
      serverSheet.insert('.two-1 { height: 20px; }', 2);
      serverSheet.insert('.two-2 { color: red; }', 2);
      const textContent = serverSheet.getTextContent();

      // Add SSR CSS to client style sheet
      element.appendChild(document.createTextNode(textContent));
      const clientSheet = createOrderedCSSStyleSheet(element.sheet);
      const text = clientSheet.getTextContent();
      // Cascade priority order at the top.
      expect(text).toMatch(/^@layer rnw-1, rnw-2;/);
      // Per-group blocks carry each group's rules.
      expect(text).toContain('@layer rnw-1 {');
      expect(text).toContain('.one {width: 10px;}');
      expect(text).toContain('@layer rnw-2 {');
      expect(text).toContain('.two-1 {height: 20px;}');
      expect(text).toContain('.two-2 {color: red;}');
    });

    test('hydrates from additional (streaming-delta) sheets', () => {
      // Primary sheet contains the shell head dump (group 0 + group 2).
      const primary = insertStyleElement();
      const primaryServer = createOrderedCSSStyleSheet();
      primaryServer.insert('.a { color: red }', 0);
      primaryServer.insert('.b { width: 10px }', 2);
      primary.appendChild(
        document.createTextNode(primaryServer.getTextContent())
      );

      // Two delta tags, as a streaming SSR pipeline would have emitted them.
      // Delta 1 carries group 1 rules; delta 2 carries group 3 rules. They
      // emit their rules wrapped in @layer rnw-N blocks so hydration knows
      // which group each rule belongs to.
      const delta1 = insertStyleElement();
      const deltaServer1 = createOrderedCSSStyleSheet();
      deltaServer1.insert('.c { padding: 8px }', 1);
      delta1.appendChild(
        document.createTextNode(deltaServer1.getTextContent())
      );

      const delta2 = insertStyleElement();
      const deltaServer2 = createOrderedCSSStyleSheet();
      deltaServer2.insert('.d { margin: 4px }', 3);
      delta2.appendChild(
        document.createTextNode(deltaServer2.getTextContent())
      );

      const clientSheet = createOrderedCSSStyleSheet(primary.sheet, [
        delta1.sheet,
        delta2.sheet
      ]);

      // The unified record sees every group from every source, in order.
      const text = clientSheet.getTextContent();
      expect(text).toMatch(/^@layer rnw-0, rnw-1, rnw-2, rnw-3;/);
      expect(text).toContain('.a {color: red;}');
      expect(text).toContain('.c {padding: 8px;}');
      expect(text).toContain('.b {width: 10px;}');
      expect(text).toContain('.d {margin: 4px;}');

      // Dedup is unified: a rule that already lives in a delta tag is a
      // no-op when inserted again at runtime.
      const repeatPaddingResult = clientSheet.insert('.c { padding: 8px }', 1);
      expect(repeatPaddingResult.ruleAdded).toBe(false);

      // A brand-new rule at runtime lands in the primary sheet's records.
      const newResult = clientSheet.insert('.e { gap: 12px }', 1);
      expect(newResult.ruleAdded).toBe(true);

      removeStyleElement(primary);
      removeStyleElement(delta1);
      removeStyleElement(delta2);
    });
  });
});
