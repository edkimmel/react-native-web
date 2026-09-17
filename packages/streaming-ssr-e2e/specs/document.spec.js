'use strict';

/**
 * Spec 4 — `hydrateRoot(document, …)` over a <head> the streamed chunks
 * have written into.
 *
 * On this route React renders <html>, <head> and <body> itself, so React
 * owns the head it is about to hydrate — and the streamed chunks have
 * already put rules into the group anchors inside it.
 *
 * This is the configuration that killed the previous wire format. Chunks
 * used to stream a `<style data-rnw-group data-rnw-delta>` into <body> and
 * relocate it into <head> behind its anchor. React hydrates a parent's
 * children by walking DOM siblings in order, so those relocated elements —
 * which React never rendered — shifted every anchor past the first
 * insertion by one, and React bound its group-3 fiber to the element in
 * group 2.2's slot. React 18 logged a single dev warning and left the DOM
 * alone, so the page looked fine; the damage was latent, and the next
 * render of <head> would have written group-3 rules into a group-2.2
 * element. Production was silent about all of it.
 *
 * The current format inserts into the anchor's CSSOM and deletes its own
 * script, so once a chunk has run the DOM is byte-identical to React's
 * server output. There is nothing left to skew against, which is what the
 * second test measures — directly, off React's `__reactFiber$`
 * back-pointers, rather than inferring it from the absence of a warning.
 *
 * `boot` holds the client bundle back so the ordering under test — chunks
 * first, hydration second — is guaranteed rather than raced for.
 */

const { expect, test } = require('@playwright/test');
const {
  SERVER_LATE_TEXT,
  browserValues,
  readDeltas,
  recordDeltas,
  watchForProblems
} = require('./helpers');

const URL = '/document?delay=200&boot=900';

// <head> as a positional fingerprint: one entry per child, in order,
// naming the tag and (for anchors) the group. Comparing it before and
// after hydration is how a node React did not render — or one it evicted
// — shows up.
const readHeadShape = (page) =>
  page.evaluate(() =>
    Array.from(document.head.children).map(
      (el) =>
        el.tagName +
        (el.hasAttribute('data-rnw-group')
          ? '[' + el.getAttribute('data-rnw-group') + ']'
          : '')
    )
  );

async function loadStreamedDocument(page) {
  await recordDeltas(page);
  await page.goto(URL, { waitUntil: 'commit' });
  await page.waitForSelector('#late-probe', { state: 'visible' });

  const beforeHydration = await page.evaluate(() => ({
    clientStarted: window.__E2E_CLIENT_STARTED__ === true,
    deltaNodes: document.querySelectorAll('[data-rnw-delta]').length
  }));
  const headBefore = await readHeadShape(page);
  expect(
    beforeHydration.clientStarted,
    'the client bundle ran before the deltas landed; this test would not ' +
      'be exercising the ordering it exists for'
  ).toBe(false);

  // The chunks really did arrive, and really did leave no node behind.
  const deltas = await readDeltas(page);
  expect(deltas.length).toBeGreaterThan(0);
  expect(beforeHydration.deltaNodes).toBe(0);

  await page.waitForFunction(() => window.__APP_MOUNTED__ >= 1);
  return { ...beforeHydration, deltas, headBefore };
}

test('a React-rendered document survives hydration with streamed deltas', async ({
  page
}) => {
  const problems = watchForProblems(page);

  const beforeHydration = await loadStreamedDocument(page);
  const expectedLate = await browserValues(page, 'late');
  await expect(page.locator('#late-hooks')).toHaveText(expectedLate);

  // The boundary hydrated against the server snapshot, exactly as on the
  // root-rendered route.
  const renders = await page.evaluate(() => window.__DETAIL_RENDERS__);
  expect(renders[0]).toBe(SERVER_LATE_TEXT);

  // Hydration did not disturb <head>: same elements, same order, same
  // groups it had before React touched it.
  expect(await readHeadShape(page)).toEqual(beforeHydration.headBefore);

  // ...and the cascade the anchors exist for still holds.
  const probe = await page.$eval('#late-probe', (el) => {
    const cs = getComputedStyle(el);
    return {
      actualBg: cs.backgroundColor,
      actualPl: cs.paddingLeft,
      actualPt: cs.paddingTop,
      expectedBg: el.dataset.expectBg,
      expectedPl: el.dataset.expectPl
    };
  });
  expect(probe.actualPt).toBe('40px');
  expect(probe.actualPl).toBe(probe.expectedPl);
  expect(probe.actualBg).toBe(probe.expectedBg);

  // Nothing filtered. The head skew this route used to produce showed up
  // as a React `did not match` warning; there is no longer anything for
  // React to disagree about, so the bar is zero console output.
  expect(problems.consoleErrors).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});

/**
 * The guarantee, measured rather than inferred.
 *
 * React binds each fiber to the DOM node it finds in that child's
 * position. Reading `__reactFiber$` off every `<style>` in <head> and
 * comparing the group React thinks it rendered against the group actually
 * on the element is a direct read of that binding: if a streamed chunk had
 * added or moved so much as one node, every anchor after it would come
 * back bound to its neighbour's group.
 */
test('hydrateRoot(document) binds <head> anchors to the right DOM nodes', async ({
  page
}) => {
  await loadStreamedDocument(page);

  const binding = await page.evaluate(() =>
    Array.from(document.head.querySelectorAll('style')).map((el) => {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      const fiber = key == null ? null : el[key];
      return {
        dom: el.getAttribute('data-rnw-group'),
        react:
          fiber == null || fiber.memoizedProps == null
            ? null
            : String(fiber.memoizedProps['data-rnw-group'])
      };
    })
  );

  expect(binding.length).toBeGreaterThan(0);
  for (const entry of binding) {
    expect(
      entry.react,
      `React bound its group-${entry.react} fiber to the group-` +
        `${entry.dom} anchor`
    ).toBe(entry.dom);
  }
});
