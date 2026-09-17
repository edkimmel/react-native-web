'use strict';

/**
 * Spec 1 — the cascade, read out of a real CSSOM.
 *
 * The shell carries a group-3 longhand (`padding-top: 40px`). The late
 * Suspense boundary compiles a group-2 shorthand (`padding: Npx`) for the
 * same element, which reaches the browser in a post-shell chunk, i.e. in
 * <body>, i.e. after the whole of <head>. A `<style>` left where it lands
 * would win on document order. Instead the chunk's inline script inserts
 * the rules into the group-2 anchor's *own* sheet — above the group-3
 * anchor — and the longhand wins again.
 *
 * That is a stronger guarantee than the relocation this format replaced:
 * the rules do not sit next to the right anchor, they sit inside it, so
 * their cascade bucket cannot drift no matter what else is in <head>.
 *
 * jsdom could only ever check this by re-parsing the serialised HTML and
 * reasoning about order. Here it is `getComputedStyle`.
 */

const { expect, test } = require('@playwright/test');
const { readDeltas, recordDeltas, watchForProblems } = require('./helpers');

const EXPECTED_ANCHORS = ['0', '1', '2', '2.1', '2.2', '3'];

test('the shell longhand still beats a shorthand that arrived later', async ({
  page
}) => {
  const problems = watchForProblems(page);
  await recordDeltas(page);

  await page.goto('/?delay=150');
  await page.waitForSelector('#late-probe', { state: 'visible' });

  // Guard against a vacuous pass. If the group-2 rule had already been
  // compiled by an earlier request it would arrive in this request's SHELL
  // instead, the anchors alone would order it correctly, and the chunk
  // path would not be under test at all.
  const deltas = await readDeltas(page);
  const deltaGroups = deltas.map((bucket) => String(bucket.g));
  expect(deltaGroups).toContain('2');
  expect(deltaGroups).toContain('3');

  const probe = await page.$eval('#late-probe', (el) => {
    const cs = getComputedStyle(el);
    return {
      actualBg: cs.backgroundColor,
      actualPl: cs.paddingLeft,
      actualPt: cs.paddingTop,
      expectedBg: el.dataset.expectBg,
      expectedPl: el.dataset.expectPl,
      expectedPt: el.dataset.expectPt
    };
  });

  // The shorthand did apply...
  expect(probe.actualPl).toBe(probe.expectedPl);
  expect(probe.actualBg).toBe(probe.expectedBg);
  // ...and the shell's longhand still overrode it.
  expect(probe.actualPt).toBe('40px');
  expect(probe.expectedPt).toBe('40px');

  expect(problems.pageErrors).toEqual([]);
});

test('every streamed rule ends up inside its own group anchor', async ({
  page
}) => {
  await recordDeltas(page);

  const response = await page.goto('/?delay=150');
  await page.waitForSelector('#late-probe', { state: 'visible' });

  const deltas = await readDeltas(page);
  expect(deltas.length).toBeGreaterThan(0);

  const dom = await page.evaluate(() => {
    const head = Array.from(document.head.children);
    const anchors = [];
    head.forEach((el, index) => {
      if (el.tagName === 'STYLE' && el.hasAttribute('data-rnw-group')) {
        anchors.push({
          group: el.getAttribute('data-rnw-group'),
          index,
          // Chromium blanks the nonce *content* attribute once parsed;
          // the value survives on the IDL property.
          nonce: el.nonce || el.getAttribute('nonce'),
          // The rules the browser is actually applying from this element,
          // which is the only place an `insertRule`d rule can be seen —
          // it never writes back to the element's text.
          selectors: Array.from(el.sheet.cssRules).map(
            (rule) => rule.selectorText
          )
        });
      }
    });
    return {
      anchors,
      bodyStyles: document.body.querySelectorAll('style').length,
      deltaNodes: document.querySelectorAll('[data-rnw-delta]').length
    };
  });

  // Six anchors, ascending, empty groups included — and nothing else. The
  // chunks added no element of their own and left no script behind.
  expect(dom.anchors.map((a) => a.group)).toEqual(EXPECTED_ANCHORS);
  expect(dom.anchors.map((a) => a.index)).toEqual(
    dom.anchors
      .map((a) => a.index)
      .slice()
      .sort((a, b) => a - b)
  );
  expect(dom.deltaNodes).toBe(0);
  expect(dom.bodyStyles).toBe(0);

  // The nonce passed to createStyleInjectionTransform reached the shell.
  for (const anchor of dom.anchors) {
    expect(anchor.nonce).toMatch(/^e2e-nonce-/);
  }

  // Every rule a chunk carried is in that chunk's own group anchor, and
  // in no other. This is the cascade guarantee stated directly: the
  // bucket a streamed rule lands in is the bucket its anchor occupies.
  const byGroup = new Map(dom.anchors.map((a) => [a.group, a.selectors]));
  for (const bucket of deltas) {
    for (const rule of bucket.r) {
      const selector = rule.split('{')[0].trim();
      expect(byGroup.get(String(bucket.g))).toContain(selector);
      for (const [group, selectors] of byGroup) {
        if (group !== String(bucket.g)) {
          expect(selectors).not.toContain(selector);
        }
      }
    }
  }

  // The chunk scripts carried the nonce too. Read off the wire, because
  // by the time the page has settled they have deleted themselves.
  const html = await response.text();
  expect(html).toContain('<script nonce="e2e-nonce-');
  expect(html).not.toContain('data-rnw-delta="');
});
