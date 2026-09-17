/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * End-to-end test of the streaming CSS format: the server's own
 * `takeShellHTML()` / `takeDeltaHTML()` output, parsed by a real browser
 * engine, with the chunk's inline script executing at parse time.
 *
 * The case that matters is cross-chunk cascade order. RNW compiles CSS at
 * runtime, so a shorthand (`margin`, group 2) can be discovered in a later
 * chunk than a longhand (`marginTop`, group 3) that must override it.
 * Whichever chunk they arrive in, the longhand has to win.
 *
 * TRAP: a chunk's rules are added with `CSSStyleSheet.insertRule`, which
 * never writes back to the element's text. `dom.serialize()` therefore
 * shows every `<style>` exactly as it was sent and silently omits the whole
 * delta. Assertions here read the *live* CSSOM (`sheetRules`), and the
 * cascade ones re-parse a clone whose style elements have been rewritten
 * from their live `cssRules` (`computed`) — same content, same DOM
 * positions, which is all the cascade is.
 */

const { JSDOM } = require('jsdom');

import StyleSheet from '..';
import { runInRequestScope } from '../../../modules/asyncContext';

// The process-wide sheet dedups by selector, so every test needs distinct
// values or its "new" rule silently never reaches the delta.
let px = 100;
const uniq = () => px++;

const parse = (html) => new JSDOM(html, { runScripts: 'dangerously' });

/**
 * Ground truth for the cascade. `dom.serialize()` is not usable (see the
 * TRAP above), so each `<style>` is rebuilt from its live `cssRules` in a
 * clone and that clone is re-parsed in a virgin jsdom.
 */
const computed = (dom, property) => {
  const doc = dom.window.document;
  const clone = doc.documentElement.cloneNode(true);
  const live = doc.querySelectorAll('style');
  const copies = clone.querySelectorAll('style');
  for (let i = 0; i < live.length; i++) {
    const cssSheet = live[i].sheet;
    if (cssSheet == null) continue;
    copies[i].textContent = Array.prototype.slice
      .call(cssSheet.cssRules)
      .map((rule) => rule.cssText)
      .join('\n');
  }
  const reparsed = new JSDOM('<!doctype html>' + clone.outerHTML);
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

// The live rule text of one group's anchor. Everything a chunk delivered
// for that group has to be findable here and nowhere else.
const sheetRules = (dom, group) => {
  const el = dom.window.document.querySelector(
    `style[data-rnw-group="${group}"]:not([data-rnw-delta])`
  );
  if (el == null || el.sheet == null) return null;
  return Array.prototype.slice
    .call(el.sheet.cssRules)
    .map((rule) => rule.cssText);
};

const scriptSource = (html) =>
  html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

/**
 * Rewrite the rule payload inside an emitted chunk script.
 *
 * White-box on purpose: the CSSOM only rejects rules it cannot parse, and
 * the compiler has no way to produce one on demand, so the only way to
 * cover the `try`/`catch` is to hand the real emitted script a rule that is
 * genuinely garbage. The payload is valid JSON in a known position.
 */
const patchPayload = (html, fn) => {
  const match = html.match(/,p=(\[[\s\S]*?\]),i,j,b,/);
  const payload = JSON.parse(match[1]);
  return html.replace(match[1], JSON.stringify(fn(payload)));
};

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

    // The chunk's rule went into group 2's anchor, which sits above group
    // 3's, so the longhand keeps winning...
    expect(computed(dom, 'marginTop')).toBe(`${top}px`);
    // ...while the shorthand still applies where nothing overrides it,
    // which is what makes the assertion above about order rather than
    // about the shorthand having been dropped.
    expect(computed(dom, 'marginBottom')).toBe(`${all}px`);
  });

  test('the chunk leaves no node behind for hydration to trip over', () => {
    const { deltaHTML, shellHTML } = renderStreamed(
      { marginTop: uniq() },
      { margin: uniq() }
    );

    // The whole point of the format. A `<style>` streamed into the page —
    // or a `<script>` left sitting in it — is a DOM sibling React never
    // rendered, and `hydrateRoot(document, …)` walks siblings in order to
    // bind its `<head>` fibers. One extra node re-binds every anchor after
    // it. So: no new elements anywhere, and the script deletes itself.
    expect(deltaHTML).not.toContain('<style');

    const dom = parse(documentHTML(shellHTML, deltaHTML));
    const doc = dom.window.document;
    expect(doc.querySelectorAll('[data-rnw-delta]').length).toBe(0);
    expect(doc.body.querySelectorAll('style').length).toBe(0);
    expect(doc.body.querySelectorAll('script').length).toBe(0);
    expect(doc.body.childNodes.length).toBe(0);
    // ...and <head> is exactly the shell, element for element.
    expect(headGroups(dom)).toEqual(['0', '1', '2', '2.1', '2.2', '3']);
  });

  test('the rules land in their own group anchor and nowhere else', () => {
    const top = uniq();
    const all = uniq();
    const { deltaHTML, shellHTML } = renderStreamed(
      { marginTop: top },
      { margin: all }
    );

    const dom = parse(documentHTML(shellHTML, deltaHTML));
    expect(sheetRules(dom, 2).join('\n')).toContain(`margin: ${all}px`);
    expect(sheetRules(dom, 3).join('\n')).not.toContain(`margin: ${all}px`);
  });

  test('without the inline script the chunk simply never applies', () => {
    const top = uniq();
    const all = uniq();
    const { deltaHTML, lateClass, shellClass, shellHTML } = renderStreamed(
      { marginTop: top },
      { margin: all }
    );

    // The no-JS degradation, and it changed with this format: the old one
    // streamed a `<style>` that applied on its own (in the wrong cascade
    // bucket); this one carries the rules inside the script, so with the
    // script gone they are not in the document at all.
    //
    // That is sound because of *what* a delta can contain. A delta only
    // ever carries rules compiled after `takeShellHTML()`, which the
    // streaming transform calls at the first flush following
    // `onShellReady` — so by construction a delta only styles Suspense
    // boundary content, which React streams inside a `<div hidden>` that
    // nothing reveals without its own inline `$RC` script. A client that
    // will not run this script will not reveal the content it styles.
    // (Same argument for a CSP that blocks inline scripts: it blocks
    // React's too.)
    const noScript = deltaHTML.replace(/<script[\s\S]*?<\/script>/, '');
    expect(noScript).toBe('');

    const probe = `<div id="probe" class="${shellClass} ${lateClass}"></div>`;
    const dom = parse(documentHTML(shellHTML, probe + noScript));

    expect(computed(dom, 'marginTop')).toBe(`${top}px`);
    expect(computed(dom, 'marginBottom')).not.toBe(`${all}px`);
  });

  test('the shell emits every group ascending, including empty ones', () => {
    const shellHTML = runInRequestScope(() => StyleSheet.takeShellHTML());
    const dom = parse(documentHTML(shellHTML, ''));

    const groups = headGroups(dom);
    expect(groups).toEqual(['0', '1', '2', '2.1', '2.2', '3']);

    // Empty anchors are the point: they are the sheets a later chunk
    // inserts into. Without them a delta for an unseen group falls back to
    // synthesising an element, which is exactly the node the CSSOM path
    // exists to avoid.
    const empty = Array.prototype.slice
      .call(dom.window.document.head.querySelectorAll('style[data-rnw-group]'))
      .filter((el) => el.textContent === '')
      .map((el) => el.getAttribute('data-rnw-group'));
    expect(empty).toContain('2.1');
    expect(empty).toContain('2.2');
  });

  test('chunks arriving in descending group order still land ascending', () => {
    const values = [uniq(), uniq(), uniq()];
    const { chunks, shellHTML } = runInRequestScope(() => {
      const shellHTML = StyleSheet.takeShellHTML();
      const chunks = [];
      // Emit group 3, then 2, then 2.1 — the reverse of head order.
      [
        { marginTop: values[0] },
        { margin: values[1] },
        { marginInline: values[2] }
      ].forEach((style, i) => {
        StyleSheet.create({ [`c${i}`]: style });
        chunks.push(StyleSheet.takeDeltaHTML());
      });
      return { chunks, shellHTML };
    });

    const dom = parse(documentHTML(shellHTML, chunks.join('')));

    // Arrival order cannot reorder anything, because nothing moves: each
    // chunk writes into the anchor that was already in the right place.
    expect(headGroups(dom)).toEqual(['0', '1', '2', '2.1', '2.2', '3']);
    expect(dom.window.document.body.querySelectorAll('style').length).toBe(0);
    expect(sheetRules(dom, 3).join('\n')).toContain(
      `margin-top: ${values[0]}px`
    );
    expect(sheetRules(dom, 2).join('\n')).toContain(`margin: ${values[1]}px`);
    expect(sheetRules(dom, 2.1).join('\n')).toContain(`${values[2]}px`);
  });

  test('re-running a chunk script is a no-op', () => {
    const all = uniq();
    const { deltaHTML, shellHTML } = renderStreamed(
      { marginTop: uniq() },
      { margin: all }
    );

    // The script deletes itself, so the parser can never run it twice —
    // but a chunk's source can still be replayed by hand (a framework
    // re-executing inline scripts, a test, a bfcache restore). Each chunk
    // records its own sequence number in `__RNW_DELTA_SEEN__`, so a replay
    // inserts nothing a second time.
    const dom = parse(documentHTML(shellHTML, deltaHTML));
    const before = sheetRules(dom, 2);
    expect(before.join('\n')).toContain(`margin: ${all}px`);

    const script = scriptSource(deltaHTML);
    dom.window.eval(script);
    dom.window.eval(script);

    expect(sheetRules(dom, 2)).toEqual(before);
    expect(headGroups(dom)).toEqual(['0', '1', '2', '2.1', '2.2', '3']);
    expect(dom.window.document.body.querySelectorAll('style').length).toBe(0);
  });

  test('one rule the CSSOM rejects does not drop the rest of the chunk', () => {
    const all = uniq();
    const { deltaHTML, shellHTML } = renderStreamed(
      { marginTop: uniq() },
      { margin: all }
    );

    // Browsers throw from `insertRule` for anything they cannot parse —
    // vendor-prefixed selectors, unrecognised pseudo-elements. Without the
    // per-rule try/catch the first of those would abort the loop and every
    // later rule in the chunk would be silently missing.
    const patched = patchPayload(deltaHTML, (payload) =>
      payload.map((bucket) => ({
        ...bucket,
        r: ['@@@ not a rule @@@'].concat(bucket.r, '.trailing-marker{}')
      }))
    );

    const dom = parse(documentHTML(shellHTML, patched));
    const rules = sheetRules(dom, 2).join('\n');
    expect(rules).toContain(`margin: ${all}px`);
    expect(rules).toContain('.trailing-marker');
    expect(rules).not.toContain('not a rule');
  });

  test('a rule containing </script> and quotes cannot break out', () => {
    // The escaping moved from `</style` to JSON plus `<` -> \u003c. If it
    // regressed, the `</script>` in the rule would end the element early
    // and the rest of the payload would be parsed as HTML.
    const family = '"</script><img src=x onerror=\'boom\'>"';
    const { deltaHTML, lateClass, shellClass, shellHTML } = renderStreamed(
      { marginTop: uniq() },
      { fontFamily: family }
    );

    // Nothing that closes the script element, and no raw markup.
    expect(deltaHTML.match(/<\/script>/g).length).toBe(1);
    expect(deltaHTML).not.toContain('<img');
    expect(deltaHTML).toContain('\\u003c/script');

    const probe = `<div id="probe" class="${shellClass} ${lateClass}"></div>`;
    const dom = parse(documentHTML(shellHTML, probe + deltaHTML));
    const doc = dom.window.document;
    expect(doc.querySelector('img')).toBe(null);
    expect(doc.body.childNodes.length).toBe(1);
    // And the rule itself survived the round trip intact.
    expect(computed(dom, 'fontFamily')).toBe(family);
  });

  describe('missing group anchor', () => {
    // A chunk whose group has no anchor used to create the `<style>`
    // itself. That is the single DOM shape measured to silently mis-bind
    // `hydrateRoot(document, …)` — a `<style>` React did not render, sitting
    // between `<style>` elements it did — and it became reachable from the
    // documented flow the moment `<head>` itself could stream. So the chunk
    // now applies nothing, leaves the bucket in the queue flagged `p`, and
    // RNW's client runtime applies it once an anchor exists.
    const partialShell =
      '<style data-rnw-group="0"></style><style data-rnw-group="3"></style>';

    test('no element is created and the rules stay queued', () => {
      const all = uniq();
      const { deltaHTML, lateClass, shellClass } = renderStreamed(
        { marginTop: uniq() },
        { margin: all }
      );

      const probe = `<div id="probe" class="${shellClass} ${lateClass}"></div>`;
      const dom = parse(documentHTML(partialShell, probe + deltaHTML));

      // <head> is byte-identical to what it was served as.
      expect(headGroups(dom)).toEqual(['0', '3']);
      expect(dom.window.document.querySelectorAll('style').length).toBe(2);
      expect(dom.window.document.body.querySelectorAll('style').length).toBe(0);

      // Nothing was dropped: the bucket is in the queue, flagged pending so
      // the client knows it still has to be applied rather than merely
      // recorded.
      const queue = dom.window.__RNW_DELTA__;
      const bucket = queue.find((entry) => String(entry.g) === '2');
      expect(bucket).toBeDefined();
      expect(bucket.p).toBe(1);
      expect(bucket.r.join('\n')).toContain(`margin:${all}px`);
    });

    test('a group whose anchor IS present still takes the CSSOM path', () => {
      // Same chunk, both buckets: the missing one waits, the present one
      // is applied immediately. A pending bucket must not hold up its
      // neighbours — groups are physically separate sheets, so order
      // between them is DOM order, not arrival order.
      const top = uniq();
      const all = uniq();
      const { deltaHTML } = runInRequestScope(() => {
        StyleSheet.takeShellHTML();
        StyleSheet.create({ m: { margin: all, marginTop: top } });
        return { deltaHTML: StyleSheet.takeDeltaHTML() };
      });

      const dom = parse(documentHTML(partialShell, deltaHTML));
      expect(headGroups(dom)).toEqual(['0', '3']);
      expect(sheetRules(dom, 3).join('\n')).toContain(`margin-top: ${top}px`);

      const queued = dom.window.__RNW_DELTA__.map((entry) => [
        String(entry.g),
        entry.p
      ]);
      expect(queued).toContainEqual(['2', 1]);
      expect(queued).toContainEqual(['3', undefined]);
    });

    test('a later chunk for that group still finds nothing and waits too', () => {
      const { chunks } = runInRequestScope(() => {
        StyleSheet.takeShellHTML();
        const chunks = [];
        [{ margin: uniq() }, { margin: uniq() }].forEach((style, i) => {
          StyleSheet.create({ [`m${i}`]: style });
          chunks.push(StyleSheet.takeDeltaHTML());
        });
        return { chunks };
      });

      const dom = parse(documentHTML(partialShell, chunks.join('')));
      expect(headGroups(dom)).toEqual(['0', '3']);
      // Both chunks queued, in arrival order, so the runtime applies them
      // in the order the server compiled them.
      const queue = dom.window.__RNW_DELTA__.filter(
        (entry) => String(entry.g) === '2'
      );
      expect(queue.length).toBe(2);
      expect(queue.every((entry) => entry.p === 1)).toBe(true);
    });
  });

  test('nonce is applied to the chunk script', () => {
    const { deltaHTML, shellHTML } = runInRequestScope(() => {
      const shellHTML = StyleSheet.takeShellHTML({ nonce: 'abc123' });
      StyleSheet.create({ n: { marginTop: uniq() } });
      return {
        deltaHTML: StyleSheet.takeDeltaHTML({ nonce: 'abc123' }),
        shellHTML
      };
    });

    // Counted, not merely present: the shell is N elements and a nonce that
    // reaches only the first of them passes a `toContain` while a CSP still
    // blocks the other N-1.
    expect(shellHTML.match(/nonce="abc123"/g)).toHaveLength(
      (shellHTML.match(/<style /g) || []).length
    );
    expect(deltaHTML).toMatch(/^<script nonce="abc123">/);
  });

  test('an empty nonce emits no attribute at all', () => {
    // `nonce=""` is not "no nonce": a `script-src 'nonce-...'` policy
    // rejects it, so a caller that wires up an unset value must get markup
    // with no attribute rather than markup with an empty one.
    const { deltaHTML, shellHTML } = runInRequestScope(() => {
      const shellHTML = StyleSheet.takeShellHTML({ nonce: '' });
      StyleSheet.create({ emptyNonce: { marginTop: uniq() } });
      return { deltaHTML: StyleSheet.takeDeltaHTML({ nonce: '' }), shellHTML };
    });

    expect(shellHTML).not.toContain('nonce');
    expect(deltaHTML).toMatch(/^<script>/);
  });

  test('a nonce is escaped for an attribute, ampersands included', () => {
    // `&` first, or the escape of every other character is itself
    // re-escaped. A nonce is base64 and cannot contain one in practice,
    // which is exactly why the case needs a test rather than a witness.
    const { shellHTML } = runInRequestScope(() => ({
      shellHTML: StyleSheet.takeShellHTML({ nonce: 'a&b"><x' })
    }));

    expect(shellHTML).toContain('nonce="a&amp;b&quot;&gt;&lt;x"');
    expect(shellHTML).not.toContain('&amp;quot;');
  });

  test('the replay handle is unique across requests, not per request', () => {
    // The replay guard the handle feeds (`__RNW_DELTA_SEEN__`) is
    // page-scoped, and a page is not always one response: ESI, a
    // micro-frontend composition, anything that concatenates two render
    // streams puts two delta channels in front of one guard. Two chunks
    // claiming the same handle means the second inserts nothing AND never
    // queues — the runtime does not apply it either — so its rules are lost
    // outright, silently, in production.
    const handlesIn = (html) =>
      (html.match(/k\["[^"]+"\]/g) || []).map((m) => m.slice(3, -2));

    const chunk = () =>
      runInRequestScope(() => {
        StyleSheet.takeShellHTML();
        StyleSheet.create({ [`seq${uniq()}`]: { marginTop: uniq() } });
        return StyleSheet.takeDeltaHTML();
      });

    const a = handlesIn(chunk());
    const b = handlesIn(chunk());

    expect(a.length).toBeGreaterThan(0);
    expect(new Set(a).size).toBe(1);
    expect(a.some((handle) => b.indexOf(handle) > -1)).toBe(false);
  });

  test('takeDeltaHTML returns "" when nothing changed', () => {
    runInRequestScope(() => {
      StyleSheet.takeShellHTML();
      expect(StyleSheet.takeDeltaHTML()).toBe('');
    });
  });

  // A second shell is a verbatim copy of the first, so a document holding
  // both has two of every anchor — and a delta, whose rules go into the
  // FIRST anchor for its group, then sits ahead of the second copy of every
  // higher group. Warn rather than throw: re-emitting after an aborted
  // response, where the first shell never reached the wire, is legitimate.
  describe('duplicate shell emission', () => {
    let spy;
    beforeEach(() => {
      spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      spy.mockRestore();
    });

    test('warns on the second shell within one request', () => {
      runInRequestScope(() => {
        StyleSheet.takeShellHTML();
        expect(spy).not.toHaveBeenCalled();
        StyleSheet.takeShellHTML();
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain(
        'serialised the stylesheet shell more than once'
      );
    });

    test('the two shells really are duplicates, anchor for anchor', () => {
      const [first, second] = runInRequestScope(() => [
        StyleSheet.takeShellHTML(),
        StyleSheet.takeShellHTML()
      ]);
      expect(second).toBe(first);

      // Stated as DOM order, not as a count. `anchors(A + A) === anchors(A) * 2`
      // holds for any string at all and says nothing about the failure; what
      // the warning is about is that the concatenation is two ascending runs
      // rather than one, so the SECOND copy of the lowest group sits after
      // the FIRST copy of the highest — a group-2 shorthand physically after
      // a group-3 longhand, which is the cascade inversion the anchors exist
      // to prevent.
      const groupsIn = (html) =>
        (html.match(/data-rnw-group="[^"]+"/g) || []).map((attr) =>
          Number(attr.slice('data-rnw-group="'.length, -1))
        );
      const one = groupsIn(first);
      expect(one.length).toBeGreaterThan(1);
      expect(one).toEqual([...one].sort((a, b) => a - b));

      const both = groupsIn(first + second);
      expect(both).toEqual([...one, ...one]);

      const firstHighest = both.indexOf(Math.max(...one));
      const lowest = Math.min(...one);
      const secondLowest = both.indexOf(lowest, both.indexOf(lowest) + 1);
      expect(secondLowest).toBeGreaterThan(firstHighest);
    });

    test('a rule compiled between the two shells still reaches the client', () => {
      // "Two shells warns but is otherwise safe" was false. The second
      // `takeShellGroups()` used to move the watermark again, so a rule
      // compiled in between existed ONLY in the second — mis-cascading —
      // copy of its group, and no delta ever mentioned it. The watermark is
      // now pinned by the first shell, so the rule also travels down the
      // delta channel, where it lands in the FIRST anchor for its group,
      // which is the position the cascade was designed around. In both
      // places rather than only the wrong one; duplicates are inert.
      const value = uniq();
      const { delta, first, second } = runInRequestScope(() => {
        const first = StyleSheet.takeShellHTML();
        StyleSheet.create({ between: { marginTop: value } });
        const second = StyleSheet.takeShellHTML();
        return { delta: StyleSheet.takeDeltaHTML(), first, second };
      });

      expect(first).not.toContain(`margin-top:${value}px`);
      expect(second).toContain(`margin-top:${value}px`);
      expect(delta).toContain(`margin-top:${value}px`);
    });

    test('the duplicate is reported in production too', () => {
      // A second shell cannot be repaired, only made visible, and the
      // symptom — some rules silently outranked by others — is exactly the
      // class of bug nobody reproduces locally. A dev-only warning means
      // production is silent and mis-cascading.
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        runInRequestScope(() => {
          StyleSheet.takeShellHTML();
          StyleSheet.takeShellHTML();
        });
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        process.env.NODE_ENV = previous;
      }
    });

    test('a fresh request starts clean', () => {
      runInRequestScope(() => {
        StyleSheet.takeShellHTML();
      });
      runInRequestScope(() => {
        StyleSheet.takeShellHTML();
      });
      expect(spy).not.toHaveBeenCalled();
    });

    test('takeShellGroups shares the counter with takeShellHTML', () => {
      runInRequestScope(() => {
        StyleSheet.takeShellGroups();
        StyleSheet.takeShellHTML();
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
