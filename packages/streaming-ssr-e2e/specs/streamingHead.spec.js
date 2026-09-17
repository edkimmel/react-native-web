'use strict';

/**
 * Spec 5 — `<head>` inside the React render loop.
 *
 * `/document` proved React can own `<html>`/`<head>`/`<body>`, but only with a
 * *static* head: the anchors there come from a `StyleSheet.takeShellGroups()`
 * snapshot the server takes before the render and passes down as a prop. Put a
 * Suspense boundary in `<head>` and there is no "before the render" at which
 * that snapshot would be right, so the anchors have to be a component that
 * reads the sheet during its own render: `<StyleSheet.Anchors />`.
 *
 * WHAT THESE TESTS ARE MEASURING
 *
 * Two DOM shapes are in play and they are graded differently.
 *
 *   ANCHORS IN THE SHELL (`anchors=shell`). `<head>` contains a Suspense
 *   boundary, but `<StyleSheet.Anchors />` renders above it, so the anchors go
 *   out in React's first flush. RNW's client sheet boots — that happens when
 *   the client bundle evaluates, nothing waits for it — and finds them.
 *   Nothing creates anything. `<head>` is exactly what React rendered, and the
 *   bar here is zero foreign `<style>` of any kind.
 *
 *   ANCHORS IN THE BOUNDARY (default). Neither major withholds `<head>` for a
 *   boundary *inside* it: both flush it immediately with a `<!--$?-->`
 *   placeholder and stream the contents later, so the client bundle reliably
 *   boots first and RNW creates anchors of its own (marked
 *   `data-rnw-runtime`). React 19 skips those during hydration — a foreign
 *   node whose tag does not match what React expects is skipped, and its first
 *   expected `<head>` child is a `<meta>`. React 18 does not, and the document
 *   falls back to client rendering. So this shape is React 19 and later, which
 *   `reactMajor` gates rather than assumes.
 *
 * A boundary ABOVE `<head>` is a third shape and is the one React 19.1's
 * Suspense-aware preamble exists for: it withholds the whole response until
 * the boundary resolves, so `<head>` is complete before the first byte.
 *
 * That shape is the one place in this suite where **the major is the wrong
 * question**. The preamble shipped in React *19.1*, not 19.0, so this shape
 * gates on `hasSuspenseAwarePreamble` and the versions without it get their
 * own tests. They fail differently, and both shapes are pinned so a change
 * on either fails loudly:
 *
 *   - React 18.3.1 streams the resolved document — `<!doctype html><html>`
 *     and all — nested inside a `<div hidden>`, which the parser flattens
 *     into nonsense.
 *   - React 19.0.x emits no doctype and no `<html>`/`<head>` open tag at
 *     all. `renderState.htmlChunks`/`headChunks` are still null when
 *     `flushCompletedQueues` writes the root segment, so the preamble is
 *     never written; only the stray `</head>` and `<body>` from the
 *     resolved boundary come out.
 *
 * The technique for "did React bind the right fiber to the right node" is the
 * one from document.spec.js: read `__reactFiber$` off each `<style>` and
 * compare the group React believes it rendered against the group actually on
 * the element.
 */

const { expect, test } = require('@playwright/test');
const {
  SERVER_LATE_TEXT,
  SUSPENSE_AWARE_PREAMBLE,
  browserValues,
  hasSuspenseAwarePreamble,
  reactMajor,
  reactVersion,
  readDeltas,
  recordDeltas,
  watchForProblems
} = require('./helpers');

const SHELL_ANCHORS = '/streaming-head?delay=400&headDelay=120&anchors=shell';
const LATE_ANCHORS = '/streaming-head?delay=400&headDelay=120';
const ABOVE = '/streaming-head?delay=600&headDelay=200&above=1';

const EXPECTED_GROUPS = ['0', '1', '2', '2.1', '2.2', '3'];

/**
 * Every `<style>` in `<head>`, with the group the DOM says it is, the group
 * React's fiber says it is, and whether RNW created it at runtime.
 */
const readHeadStyles = (page) =>
  page.evaluate(() =>
    Array.from(document.head.querySelectorAll('style')).map((el) => {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      const fiber = key == null ? null : el[key];
      return {
        dom: el.getAttribute('data-rnw-group'),
        react:
          fiber == null || fiber.memoizedProps == null
            ? null
            : String(fiber.memoizedProps['data-rnw-group']),
        runtime: el.hasAttribute('data-rnw-runtime')
      };
    })
  );

const readProbe = (page) =>
  page.$eval('#late-probe', (el) => {
    const cs = getComputedStyle(el);
    return {
      actualBg: cs.backgroundColor,
      actualPl: cs.paddingLeft,
      actualPt: cs.paddingTop,
      expectedBg: el.dataset.expectBg,
      expectedPl: el.dataset.expectPl
    };
  });

/**
 * Load a streaming-head route and return everything the assertions need.
 *
 * `waitUntil: 'commit'` so the response body is still arriving while the
 * page boots, which is the only condition under which any of this is under
 * test: with the document already complete the anchors would trivially be
 * in place before anything looked for them.
 */
async function load(page, url) {
  await recordDeltas(page);
  const response = await page.goto(url, { waitUntil: 'commit' });
  await page.waitForSelector('#late-probe', { state: 'visible' });
  await page.waitForFunction(() => window.__APP_MOUNTED__ >= 1);
  return { html: await response.text(), response };
}

/**
 * The cross-chunk cascade, plus the guard that keeps it from passing for the
 * wrong reason. The late boundary's group-2 `padding` shorthand has to have
 * arrived as a delta — if an earlier request had already compiled it, it
 * would be in this request's shell and the anchors alone would order it.
 */
async function expectCascade(page) {
  const deltas = await readDeltas(page);
  const groups = deltas.map((bucket) => String(bucket.g));
  expect(
    groups,
    'the late rule was already in the shell, so nothing about the delta ' +
      'channel is under test here'
  ).toContain('2');
  expect(groups).toContain('3');

  const probe = await readProbe(page);
  // The shorthand applied...
  expect(probe.actualPl).toBe(probe.expectedPl);
  expect(probe.actualBg).toBe(probe.expectedBg);
  // ...and the shell's group-3 longhand still beat it, which is only true if
  // the delta's rules went into the group-2 anchor's own sheet.
  expect(probe.actualPt).toBe('40px');

  // Nothing is left waiting: every bucket found an anchor.
  expect(await page.evaluate(() => window.__RNW_DELTA__.length)).toBe(0);
}

// ---------------------------------------------------------------------------
// Shape 1: a Suspense boundary in <head>, anchors rendered above it.
// Supported on every React the package supports.
// ---------------------------------------------------------------------------

test('a Suspense boundary in <head> with the anchors in the shell', async ({
  page
}) => {
  const problems = watchForProblems(page);
  const { html } = await load(page, SHELL_ANCHORS);

  // Vacuity: `<head>` really did stream. React writes a pending boundary as
  // `<!--$?-->` and the head boundary's content arrives later, so its
  // presence in the bytes is proof the head was flushed incomplete.
  const headHTML = html.slice(0, html.indexOf('</head>'));
  expect(
    headHTML,
    'no pending boundary in <head>: this is the static-head case, which ' +
      '/document already covers'
  ).toContain('<!--$?-->');
  expect(
    await page.evaluate(
      () => document.querySelector('meta[name="rnw-late-head"]') != null
    ),
    'the head boundary never resolved'
  ).toBe(true);

  const styles = await readHeadStyles(page);

  // Every anchor React rendered, bound to itself. Zero skew.
  expect(styles.map((s) => s.dom)).toEqual(EXPECTED_GROUPS);
  for (const style of styles) {
    expect(
      style.react,
      `React bound its group-${style.react} fiber to the group-${style.dom} anchor`
    ).toBe(style.dom);
  }

  // And no <style> React did not render, of any kind — not a delta element,
  // not a runtime anchor. With the anchors in the shell there is no window
  // in which RNW's sheet could have needed one.
  expect(styles.filter((s) => s.runtime)).toEqual([]);
  expect(styles.filter((s) => s.react == null)).toEqual([]);
  expect(
    await page.evaluate(() => ({
      bodyStyles: document.body.querySelectorAll('style').length,
      deltaNodes: document.querySelectorAll('[data-rnw-delta]').length
    }))
  ).toEqual({ bodyStyles: 0, deltaNodes: 0 });

  await expectCascade(page);

  // The body boundary still hydrated against the server's device snapshot.
  const renders = await page.evaluate(() => window.__DETAIL_RENDERS__);
  expect(renders[0]).toBe(SERVER_LATE_TEXT);
  await expect(page.locator('#late-hooks')).toHaveText(
    await browserValues(page, 'late')
  );

  expect(problems.consoleErrors).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Shape 2: the anchors themselves inside the head boundary.
// ---------------------------------------------------------------------------

test('the anchors inside the head boundary (React 19+)', async ({
  baseURL,
  page,
  request
}) => {
  // Genuinely a MAJOR question, not a preamble one: what differs is whether
  // hydration skips a foreign node whose tag does not match what React
  // expects there, and that is a React 19 change. Measured to pass on
  // 19.0.0, which has no Suspense-aware preamble — so this gate stays
  // `reactMajor`.
  test.skip(
    (await reactMajor(request, baseURL)) < 19,
    'React 18 cannot hydrate past the <style> elements RNW creates while the ' +
      'boundary is still streaming; see the React 18 test below, which pins ' +
      'both the failure and its cause'
  );

  const problems = watchForProblems(page);
  await load(page, LATE_ANCHORS);

  const styles = await readHeadStyles(page);
  const shell = styles.filter((s) => !s.runtime);

  // The anchors the server sent are all present and all bound to their own
  // fiber, even though they arrived in a later segment of <head>.
  expect(shell.map((s) => s.dom)).toEqual(EXPECTED_GROUPS);
  for (const style of shell) {
    expect(
      style.react,
      `React bound its group-${style.react} fiber to the group-${style.dom} anchor`
    ).toBe(style.dom);
  }

  // The only `<style>` React did not render are RNW's own runtime anchors,
  // and they are labelled as such. They exist because the client bundle
  // boots before the head boundary resolves; React skips them because their
  // tag does not match the `<meta>` it expects in that position. Nothing
  // else may be in there.
  for (const style of styles) {
    if (style.react == null) {
      expect(
        style.runtime,
        'an unlabelled <style> React did not render is in <head>'
      ).toBe(true);
    }
  }
  expect(
    await page.evaluate(() => ({
      bodyStyles: document.body.querySelectorAll('style').length,
      deltaNodes: document.querySelectorAll('[data-rnw-delta]').length
    }))
  ).toEqual({ bodyStyles: 0, deltaNodes: 0 });

  await expectCascade(page);

  expect(problems.consoleErrors).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});

test('anchors inside the head boundary are clean on React 18 too, once RNW boots after them', async ({
  baseURL,
  page,
  request
}) => {
  // Complement of the gate above, and a major question for the same reason.
  test.skip(
    (await reactMajor(request, baseURL)) >= 19,
    'this pins the React 18 diagnosis; 19 has its own test above'
  );

  // `boot=400` holds the client bundle back past `headDelay=120`, so RNW's
  // sheet boots with the anchors already in the document and creates none of
  // its own. Everything else is identical to the run that fails. That is the
  // whole diagnosis: React 18's hydration cannot walk past a `<style>` where
  // it expected a `<meta>`, and the only such `<style>` is the one RNW has to
  // create when it boots into a `<head>` whose anchors have not arrived.
  const problems = watchForProblems(page);
  await load(page, '/streaming-head?delay=900&headDelay=120&boot=400');

  const styles = await readHeadStyles(page);
  expect(styles.map((s) => s.dom)).toEqual(EXPECTED_GROUPS);
  for (const style of styles) {
    expect(style.react).toBe(style.dom);
  }
  expect(styles.filter((s) => s.runtime)).toEqual([]);

  await expectCascade(page);
  expect(problems.consoleErrors).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// Shape 3: a Suspense boundary ABOVE <head>.
// ---------------------------------------------------------------------------

test(`a Suspense boundary above <head> (React >= ${SUSPENSE_AWARE_PREAMBLE})`, async ({
  baseURL,
  page,
  request
}) => {
  test.skip(
    !hasSuspenseAwarePreamble(await reactVersion(request, baseURL)),
    "this shape needs Fizz's Suspense-aware preamble, which shipped in " +
      'React 19.1 — not in 19.0.x, and not in 18. A `major >= 19` gate here ' +
      'ran this spec on 19.0.0, where the page never reaches the state ' +
      '`load()` waits for and the test times out at 60s. See the two tests ' +
      'below, which pin what each preamble-less React does instead'
  );

  const problems = watchForProblems(page);
  const started = Date.now();
  const { html } = await load(page, ABOVE);
  const elapsed = Date.now() - started;

  // React 19.1's Suspense-aware preamble withheld the whole response until
  // the boundary resolved: the document is complete from the first byte, so
  // `<head>` carries no pending-boundary marker at all.
  expect(elapsed).toBeGreaterThan(150);
  expect(html.slice(0, html.indexOf('</head>'))).not.toContain('<!--$?-->');
  expect(html.startsWith('<!DOCTYPE html>')).toBe(true);

  const styles = await readHeadStyles(page);
  expect(styles.map((s) => s.dom)).toEqual(EXPECTED_GROUPS);
  for (const style of styles) {
    expect(style.react).toBe(style.dom);
  }
  // Head was complete before the client bundle could run, so RNW created
  // nothing.
  expect(styles.filter((s) => s.runtime)).toEqual([]);

  await expectCascade(page);
  expect(problems.consoleErrors).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
});

test('React 18 does not support a Suspense boundary above <head>', async ({
  baseURL,
  page,
  request
}) => {
  test.skip(
    (await reactMajor(request, baseURL)) >= 19,
    'React 19.0.x has its own test below; 19.1+ supports this, see above'
  );

  // Measured, and recorded so it fails loudly if React 18 ever changes. With
  // no preamble machinery React 18 opens the response with the boundary
  // placeholder — no doctype, no <html> — and then streams the resolved
  // document, `<!doctype html><html>` and all, INSIDE a `<div hidden>`. The
  // parser drops the nested doctype and html tags and flattens the rest into
  // the document it already started, so the result is not the app.
  //
  // Nothing in this library can fix that: the bytes are wrong before RNW is
  // involved. It is the reason the shape is documented as React >= 19.1.
  const response = await page.goto(ABOVE, { waitUntil: 'commit' });
  const html = await response.text();
  expect(html.startsWith('<!DOCTYPE html>')).toBe(false);
  expect(html).toContain('<div hidden id="S:0"><!DOCTYPE html>');
});

test('React 19.0.x does not support a Suspense boundary above <head> either', async ({
  baseURL,
  page,
  request
}) => {
  const version = await reactVersion(request, baseURL);
  test.skip(
    (await reactMajor(request, baseURL)) < 19 ||
      hasSuspenseAwarePreamble(version),
    'this pins what the one React 19 line without the Suspense-aware ' +
      'preamble does; 18 and 19.1+ have their own tests'
  );

  // The failure mode that a `major >= 19` gate hid. 19.0.x breaks DIFFERENTLY
  // from 18: there is no nested document, because there is no document at
  // all. `<html>`/`<head>` are singletons whose open tags are buffered into
  // `renderState.htmlChunks`/`headChunks` when they render, and
  // `flushCompletedQueues` writes those only once, when it writes the
  // completed root segment. With the boundary above them the root segment
  // completes first, both are still null, and nothing is ever written for
  // them — so the response carries no doctype, no `<html>` and no `<head>`
  // open tag, but does carry the stray `</head>` and `<body>` that come out
  // when the boundary finally resolves.
  //
  // Verified directly off the bytes at `/streaming-head?…&above=1` under
  // react-dom@19.0.0, and against 19.0.0's own
  // `flushCompletedQueues` (`react-dom-server.node.development.js`).
  const response = await page.goto(ABOVE, { waitUntil: 'commit' });
  const html = await response.text();
  expect(html.startsWith('<!DOCTYPE html>')).toBe(false);
  expect(html).not.toContain('<!DOCTYPE');
  expect(html).not.toContain('<html');
  expect(html).not.toContain('<head');
  // ...yet the closing tags are there, which is what makes it unparseable
  // rather than merely a fragment.
  expect(html).toContain('</head>');
  expect(html).toContain('<body>');
});
