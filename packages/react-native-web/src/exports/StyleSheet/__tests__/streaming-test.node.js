/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * End-to-end test of the streaming CSS format: the server's own
 * `takeShellHTML()` / `takeDeltaHTML()` output, parsed by a real browser
 * engine, with the inline relocation script executing at parse time.
 *
 * The case that matters is cross-chunk cascade order. RNW compiles CSS at
 * runtime, so a shorthand (`margin`, group 2) can be discovered in a later
 * chunk than a longhand (`marginTop`, group 3) that must override it.
 * Whichever chunk they arrive in, the longhand has to win.
 *
 * TRAP: jsdom caches computed styles and does not invalidate them when a
 * `<style>` is moved by script. A live `getComputedStyle` read after
 * relocation returns the *stale* value. Every assertion here goes through a
 * re-parse of `dom.serialize()`, which is ground truth.
 */

const { JSDOM } = require('jsdom');

import StyleSheet from '..';
import { runInRequestScope } from '../../../modules/asyncContext';

// The process-wide sheet dedups by selector, so every test needs distinct
// values or its "new" rule silently never reaches the delta.
let px = 100;
const uniq = () => px++;

const parse = (html) => new JSDOM(html, { runScripts: 'dangerously' });

// Ground truth: jsdom's computed styles go stale after a script-driven
// stylesheet move, so read them from a fresh parse of the serialized DOM.
const computed = (dom, property) => {
  const reparsed = new JSDOM(dom.serialize());
  return reparsed.window.getComputedStyle(
    reparsed.window.document.getElementById('probe')
  )[property];
};

const documentHTML = (head, body) =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const headGroups = (dom) =>
  Array.prototype.slice
    .call(dom.window.document.head.querySelectorAll('style[data-rnw-group]'))
    .map(
      (el) =>
        el.getAttribute('data-rnw-group') +
        (el.hasAttribute('data-rnw-delta') ? ':delta' : '')
    );

/**
 * Render a shell containing `shellStyle`, then a single later chunk
 * containing `lateStyle`, and return the emitted HTML plus the class names
 * for a probe element carrying both.
 */
function renderStreamed(shellStyle, lateStyle) {
  return runInRequestScope(() => {
    const shell = StyleSheet.create({ s: shellStyle });
    const [shellClass] = StyleSheet([shell.s]);
    const shellHTML = StyleSheet.takeShellHTML();

    const late = StyleSheet.create({ l: lateStyle });
    const [lateClass] = StyleSheet([late.l]);
    const deltaHTML = StyleSheet.takeDeltaHTML();

    return { deltaHTML, lateClass, shellClass, shellHTML };
  });
}

describe('StyleSheet streaming format', () => {
  test('a shorthand streamed after a longhand still loses to it', () => {
    const top = uniq();
    const all = uniq();
    const { deltaHTML, lateClass, shellClass, shellHTML } = renderStreamed(
      { marginTop: top }, // group 3
      { margin: all } // group 2
    );

    const probe = `<div id="probe" class="${shellClass} ${lateClass}"></div>`;
    const dom = parse(documentHTML(shellHTML, probe + deltaHTML));

    expect(computed(dom, 'marginTop')).toBe(`${top}px`);
  });

  test('without the relocation script the same markup resolves wrong', () => {
    const top = uniq();
    const all = uniq();
    const { deltaHTML, lateClass, shellClass, shellHTML } = renderStreamed(
      { marginTop: top },
      { margin: all }
    );

    // Strip the inline script: the delta then stays in <body>, after
    // everything in <head>, and wins every tie. This is the documented
    // no-JS degradation — a wrong margin in a narrow case, not a blank page.
    const noScript = deltaHTML.replace(/<script[\s\S]*?<\/script>/, '');
    const probe = `<div id="probe" class="${shellClass} ${lateClass}"></div>`;
    const dom = parse(documentHTML(shellHTML, probe + noScript));

    expect(computed(dom, 'marginTop')).toBe(`${all}px`);
  });

  test('the shell emits every group ascending, including empty ones', () => {
    const shellHTML = runInRequestScope(() => StyleSheet.takeShellHTML());
    const dom = parse(documentHTML(shellHTML, ''));

    const groups = headGroups(dom);
    expect(groups).toEqual(['0', '1', '2', '2.1', '2.2', '3']);

    // Empty anchors are the point: they are what a later chunk inserts
    // against. Without them a delta for an unseen group lands at the end of
    // <head> and outranks everything above it.
    const empty = Array.prototype.slice
      .call(dom.window.document.head.querySelectorAll('style[data-rnw-group]'))
      .filter((el) => el.textContent === '')
      .map((el) => el.getAttribute('data-rnw-group'));
    expect(empty).toContain('2.1');
    expect(empty).toContain('2.2');
  });

  test('chunks arriving in descending group order still land ascending', () => {
    const { chunks, shellHTML } = runInRequestScope(() => {
      const shellHTML = StyleSheet.takeShellHTML();
      const chunks = [];
      // Emit group 3, then 2, then 1 — the reverse of head order.
      [
        { marginTop: uniq() },
        { margin: uniq() },
        { position: 'absolute', top: uniq() }
      ].forEach((style, i) => {
        StyleSheet.create({ [`c${i}`]: style });
        chunks.push(StyleSheet.takeDeltaHTML());
      });
      return { chunks, shellHTML };
    });

    const dom = parse(documentHTML(shellHTML, chunks.join('')));

    // Every delta sits directly after its own group's anchor, so the head
    // stays sorted no matter what order the chunks arrived in.
    const groups = headGroups(dom).map((g) => Number(g.split(':')[0]));
    const sorted = groups.slice().sort((a, b) => a - b);
    expect(groups).toEqual(sorted);
    expect(dom.window.document.body.querySelectorAll('style').length).toBe(0);
  });

  test('re-running the relocation script is a no-op', () => {
    const { deltaHTML, shellHTML } = renderStreamed(
      { marginTop: uniq() },
      { margin: uniq() }
    );

    // Every chunk carries the same script, so it runs once per chunk for
    // the life of the page. Running it again must change nothing.
    const dom = parse(documentHTML(shellHTML, deltaHTML));
    const before = headGroups(dom);

    const script = deltaHTML.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
    dom.window.eval(script);
    dom.window.eval(script);

    expect(headGroups(dom)).toEqual(before);
    expect(dom.window.document.body.querySelectorAll('style').length).toBe(0);
  });

  test('a delta whose group has no anchor stays in body rather than moving', () => {
    const { deltaHTML } = renderStreamed(
      { marginTop: uniq() },
      { margin: uniq() }
    );

    // A shell that never declared group 2 (this should not happen, but the
    // failure mode has to be "does not move" and not "lands in the wrong
    // bucket", which would silently invert the cascade).
    const partialShell =
      '<style data-rnw-group="0"></style><style data-rnw-group="3"></style>';
    const dom = parse(documentHTML(partialShell, deltaHTML));

    expect(headGroups(dom)).toEqual(['0', '3']);
    expect(dom.window.document.body.querySelectorAll('style').length).toBe(1);
  });

  test('nonce is applied to both the style elements and the script', () => {
    const { deltaHTML, shellHTML } = runInRequestScope(() => {
      const shellHTML = StyleSheet.takeShellHTML({ nonce: 'abc123' });
      StyleSheet.create({ n: { marginTop: uniq() } });
      return {
        deltaHTML: StyleSheet.takeDeltaHTML({ nonce: 'abc123' }),
        shellHTML
      };
    });

    expect(shellHTML).toContain('nonce="abc123"');
    expect(deltaHTML).toContain('<style data-rnw-group=');
    expect(deltaHTML).toContain('nonce="abc123"');
    expect(deltaHTML).toMatch(/<script nonce="abc123">/);
  });

  test('takeDeltaHTML returns "" when nothing changed', () => {
    runInRequestScope(() => {
      StyleSheet.takeShellHTML();
      expect(StyleSheet.takeDeltaHTML()).toBe('');
    });
  });
});
