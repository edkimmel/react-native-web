'use strict';

/**
 * Spec 3 — progressive hydration reads the SERVER snapshot.
 *
 * The server renders at 1024x768 / dark; Chromium runs at 1280x720 / light.
 * That divergence is the measurement: without it, "the boundary rendered
 * the server's values" and "the boundary rendered the live ones" would be
 * the same string and every assertion here would pass vacuously.
 *
 * `?gate=1` makes the late boundary refuse to hydrate until the spec
 * releases it, so by then the root has long since hydrated and the live
 * Dimensions/Appearance values (which on the client are simply
 * `window.innerWidth` and `matchMedia`) already disagree with the markup.
 * If `useWindowDimensions` / `useColorScheme` handed React the live value
 * at that point, React would find "1280x720:light" against server markup
 * saying "1024x768:dark" and log a text mismatch plus "There was an error
 * while hydrating this Suspense boundary. Switched to client rendering."
 *
 * The load-bearing assertion is on render-phase instrumentation inside
 * Details.js: the boundary's FIRST client render must report the server's
 * values. That is the only place `getServerSnapshot` is observable — by
 * the time any effect could run, useSyncExternalStore has reconciled.
 */

const { expect, test } = require('@playwright/test');
const {
  SERVER_LATE_TEXT,
  browserValues,
  watchForProblems
} = require('./helpers');

function liveDeviceState(page) {
  return page.evaluate(() => {
    const { Appearance, Dimensions } = window.__RNW__;
    const w = Dimensions.get('window');
    return {
      colorScheme: Appearance.getColorScheme(),
      height: w.height,
      width: w.width
    };
  });
}

test('a late boundary hydrates against the server snapshot, then reconciles', async ({
  page
}) => {
  const problems = watchForProblems(page);

  await page.goto('/?delay=200&gate=1');
  const expectedLate = await browserValues(page, 'late');
  expect(expectedLate).not.toBe(SERVER_LATE_TEXT);

  // The boundary's markup has been revealed, and the root has hydrated.
  await page.waitForSelector('#late-probe', { state: 'visible' });
  await page.waitForFunction(() => window.__APP_MOUNTED__ >= 1);

  // The LIVE device state already disagrees with the markup on screen.
  const live = await liveDeviceState(page);
  expect(live.width).not.toBe(1024);
  expect(live.colorScheme).toBe('light');
  await expect(page.locator('#late-hooks')).toHaveText(SERVER_LATE_TEXT);
  expect(await page.evaluate(() => window.__DETAIL_RENDERS__)).toBeUndefined();

  // Hydrate the boundary now, long after the live values moved.
  await page.evaluate(() => window.__RELEASE_DETAILS__());
  await expect(page.locator('#late-hooks')).toHaveText(expectedLate);

  const renders = await page.evaluate(() => window.__DETAIL_RENDERS__);
  expect(
    renders[0],
    "the late boundary's first client render must see the values the " +
      'server rendered with (getServerSnapshot), not the live ones'
  ).toBe(SERVER_LATE_TEXT);
  expect(renders[renders.length - 1]).toBe(expectedLate);

  expect(problems.consoleErrors, 'hydration was not clean').toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});

test('an ungated streamed boundary hydrates cleanly', async ({ page }) => {
  const problems = watchForProblems(page);

  await page.goto('/?delay=250');
  const expectedLate = await browserValues(page, 'late');

  await page.waitForSelector('#late-probe', { state: 'visible' });
  await expect(page.locator('#late-hooks')).toHaveText(expectedLate);

  const renders = await page.evaluate(() => window.__DETAIL_RENDERS__);
  expect(renders[0]).toBe(SERVER_LATE_TEXT);

  expect(problems.consoleErrors, 'hydration was not clean').toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});
