'use strict';

/**
 * Spec 3b — the same claim, but with the device hooks ABOVE the boundary
 * as well (`?shellHooks=1`).
 *
 * STREAMING-SSR.md's claim is unconditional: "a frozen device-state
 * snapshot every boundary hydrates against however late it hydrates", and
 * its own end-to-end example puts `useColorScheme` / `useWindowDimensions`
 * in the root component, above the `<Suspense>`. So this is the documented
 * shape, not an exotic one.
 */

const { expect, test } = require('@playwright/test');
const {
  SERVER_LATE_TEXT,
  SERVER_SHELL_TEXT,
  browserValues,
  watchForProblems
} = require('./helpers');

test('device hooks above the boundary do not break the boundary hydrating', async ({
  page
}) => {
  const problems = watchForProblems(page);

  await page.goto('/?delay=250&shellHooks=1');
  const expectedShell = await browserValues(page, 'shell');
  const expectedLate = await browserValues(page, 'late');
  expect(expectedShell).not.toBe(SERVER_SHELL_TEXT);

  await page.waitForSelector('#late-probe', { state: 'visible' });
  await expect(page.locator('#shell-hooks')).toHaveText(expectedShell);
  await expect(page.locator('#late-hooks')).toHaveText(expectedLate);

  const renders = await page.evaluate(() => window.__DETAIL_RENDERS__);
  expect(
    renders[0],
    'the late boundary was hydrated against the server snapshot'
  ).toBe(SERVER_LATE_TEXT);

  expect(problems.consoleErrors, 'hydration was not clean').toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});
