'use strict';

/**
 * Spec 9 — `renderToStreamingResponse`, in a real browser.
 *
 * The adapter is a composition of pieces every other spec here already
 * covers, so this does not re-prove the CSS format, the cascade or the
 * reveal path. What it proves is that the composition is right as shipped:
 * the one call produces a document whose late boundary arrives styled and
 * hydrates against the server's device state, from the built package,
 * through the same client entry route 1 uses.
 *
 * Route: `/one-call`, which is route 1's page rendered through the adapter.
 * The server declares 1024x768 / dark while Chromium runs 1280x720 / light,
 * and that divergence is what makes the hydration assertion mean anything.
 */

const { expect, test } = require('@playwright/test');
const {
  SERVER_LATE_TEXT,
  browserValues,
  readDeltas,
  recordDeltas,
  watchForProblems
} = require('./helpers');

test('the one-call adapter streams a styled, correctly hydrating document', async ({
  page
}) => {
  const problems = watchForProblems(page);
  await recordDeltas(page);

  await page.goto('/one-call?delay=150');

  // The document the adapter assembled: its own skeleton, the caller's head
  // markup, and the app in the root div the client entry looks for.
  expect(await page.title()).toBe('RNW streaming SSR e2e — one call');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#root')).toHaveCount(1);

  // Exactly one shell — two anchor sets per group is the cascade inversion
  // the shell rules exist to prevent — and all of it in <head>.
  const anchors = await page.evaluate(() => ({
    group0InHead: document.head.querySelectorAll('style[data-rnw-group="0"]')
      .length,
    group0InBody: document.body.querySelectorAll('style[data-rnw-group="0"]')
      .length
  }));
  expect(anchors).toEqual({ group0InHead: 1, group0InBody: 0 });

  // The boundary resolved after <head> was on the wire, so its rules can
  // only have come through the delta channel — which is inert outside a
  // request scope. A non-empty queue is therefore also the proof that the
  // adapter opened one.
  await page.waitForSelector('#late-probe', { state: 'visible' });
  const deltas = await readDeltas(page);
  expect(deltas.length).toBeGreaterThan(0);

  // And they landed: the late probe paints what the server said it should,
  // read out of the real CSSOM rather than inferred from document order.
  const late = await page.evaluate(() => {
    const el = document.getElementById('late-probe');
    const cs = getComputedStyle(el);
    return {
      actual: {
        bg: cs.backgroundColor,
        pl: cs.paddingLeft,
        pt: cs.paddingTop
      },
      expected: {
        bg: el.dataset.expectBg,
        pl: el.dataset.expectPl,
        pt: el.dataset.expectPt
      }
    };
  });
  expect(late.actual).toEqual(late.expected);

  // The hydration snapshot the adapter emitted is the one the boundary's
  // first client render read — not the live browser values, which differ.
  await page.waitForFunction(() => window.__APP_MOUNTED__ >= 1);
  const firstRender = await page.evaluate(
    () => (window.__DETAIL_RENDERS__ || [])[0]
  );
  expect(firstRender).toBe(SERVER_LATE_TEXT);
  expect(await browserValues(page, 'late')).not.toBe(SERVER_LATE_TEXT);

  expect(problems.pageErrors).toEqual([]);
  expect(problems.consoleErrors).toEqual([]);
});
