'use strict';

/**
 * Spec 2 — no flash of unstyled content.
 *
 * This is the product claim the whole streaming-CSS design exists to make,
 * and until now nothing tested it: jsdom does not paint.
 *
 * WHY THIS IS A MEASUREMENT AND NOT A RACE
 *
 * A flash is, by definition, a painted frame. An unstyled state that is
 * never painted is not a flash; it is an implementation detail nobody can
 * see. So the test only has to observe every painted frame.
 *
 * The sampler in helpers.js runs from `requestAnimationFrame`, installed by
 * an init script before any page script. In the HTML event loop, animation
 * frame callbacks are the first step of "update the rendering"; style,
 * layout and paint follow in the same turn, and the HTML parser does not
 * get to insert nodes in between. Therefore:
 *
 *   - the DOM and computed styles the callback sees are exactly the ones
 *     that frame paints;
 *   - a frame that painted an element cannot have been missed, because the
 *     callback for that frame ran before it.
 *
 * That turns "was there ever a flash?" into an exhaustive check over a
 * finite list, instead of a poll that might land in the wrong place. The
 * assertion is: for every frame in which a probe had layout boxes, its
 * computed background and padding already equalled the values the server
 * said they should be. A single bad frame fails the test and the failure
 * message names it.
 *
 * Vacuity guards, because an exhaustive check over an empty list passes:
 *   - the shell probe must have been sampled over many frames;
 *   - the late probe must have been sampled painted at least once;
 *   - the late probe must first appear well after the shell did, so the
 *     boundary really did arrive as a separate chunk.
 *
 * The scenario is repeated a few times: the delta <style> for a boundary is
 * written immediately after React's reveal script for the same boundary, so
 * whether a paint can slip between them depends on how the bytes were
 * chunked. One pass could get lucky.
 */

const { expect, test } = require('@playwright/test');
const {
  installFrameSampler,
  installSabotage,
  reactMajor,
  readFrames,
  watchForProblems
} = require('./helpers');

const DELAY_MS = 700;
const RUNS = 3;

function describeFrame(id, index, frame) {
  const probe = frame.probes[id];
  return (
    `frame ${index} (t=${Math.round(frame.t)}ms) painted #${id} as ` +
    `${JSON.stringify(probe.actual)} but the server said it should be ` +
    `${JSON.stringify(probe.expected)}`
  );
}

function auditProbe(id, frames) {
  const bad = [];
  let paintedFrames = 0;
  let firstPaintedIndex = -1;
  frames.forEach((frame, index) => {
    const probe = frame.probes[id];
    if (probe == null || !probe.painted) return;
    paintedFrames += 1;
    if (firstPaintedIndex === -1) firstPaintedIndex = index;
    const { actual, expected } = probe;
    if (
      actual.bg !== expected.bg ||
      actual.pt !== expected.pt ||
      actual.pl !== expected.pl
    ) {
      bad.push(describeFrame(id, index, frame));
    }
  });
  return { bad, firstPaintedIndex, paintedFrames };
}

for (let run = 1; run <= RUNS; run++) {
  test(`shell and late chunk are styled in every painted frame (run ${run})`, async ({
    page
  }) => {
    const problems = watchForProblems(page);
    await installFrameSampler(page);

    // 'commit' returns as soon as the response starts, so sampling begins
    // with the very first frame of the document rather than after load.
    await page.goto(`/?delay=${DELAY_MS}`, { waitUntil: 'commit' });
    await page.waitForSelector('#late-probe', { state: 'visible' });
    // Let a few more frames go by after the reveal.
    await page.waitForTimeout(250);

    const frames = await readFrames(page);
    const shell = auditProbe('shell-probe', frames);
    const late = auditProbe('late-probe', frames);

    // --- vacuity guards -------------------------------------------------
    expect(
      frames.length,
      'the rAF sampler never ran; the rest of this test proves nothing'
    ).toBeGreaterThan(10);
    expect(
      shell.paintedFrames,
      'the shell probe was never painted while sampling'
    ).toBeGreaterThan(5);
    // Soundness does not depend on the frame rate — the audit is
    // exhaustive over whatever frames happened — but a sampler that got
    // suspended for a long stretch would have been unable to see anything
    // in it, so a big hole is treated as a broken measurement.
    let maxGap = 0;
    for (let i = 1; i < frames.length; i++) {
      maxGap = Math.max(maxGap, frames[i].t - frames[i - 1].t);
    }
    expect(maxGap, 'the frame sampler stalled').toBeLessThan(250);
    expect(
      late.paintedFrames,
      'the late probe was never painted while sampling'
    ).toBeGreaterThan(0);
    // A frame-count guard would be wrong here: headless Chromium does not
    // necessarily produce 60 frames a second while a document is still
    // streaming, and the audit above does not care how many frames there
    // were — it is exhaustive over the ones that happened. What has to be
    // true is that the two probes painted in genuinely different parts of
    // the response.
    const shellFirstT = frames[shell.firstPaintedIndex].t;
    const lateFirstT = frames[late.firstPaintedIndex].t;
    expect(
      lateFirstT - shellFirstT,
      'the late boundary was revealed too soon after the shell for this to ' +
        'be testing a streamed chunk at all'
    ).toBeGreaterThan(DELAY_MS / 2);

    // --- the actual claim ------------------------------------------------
    expect(
      shell.bad,
      'the shell painted unstyled or mis-styled frames'
    ).toEqual([]);
    expect(
      late.bad,
      'the late Suspense boundary painted before its delta CSS applied — ' +
        'this is the FOUC the streamed-CSS design exists to prevent'
    ).toEqual([]);

    expect(problems.pageErrors).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// The same audit on the routes where React owns <head>.
//
// `/document` has never been frame-audited: every other assertion about it is
// structural (fiber bindings, head shape), which says nothing about whether a
// frame was ever painted unstyled. `/streaming-head` is newer still and adds
// the case that matters most — `<head>` is not even complete when the body
// starts painting, so "the shell stylesheet precedes the markup it styles" is
// no longer true by construction and has to be measured.
//
// One route per test rather than a loop with a shared page, so a failure names
// the route it happened on.
// ---------------------------------------------------------------------------

const DOCUMENT_ROUTES = [
  ['/document', `/document?delay=${DELAY_MS}`],
  [
    '/streaming-head (anchors in the shell)',
    `/streaming-head?delay=${DELAY_MS}&headDelay=120&anchors=shell`
  ]
];

for (const [name, url] of DOCUMENT_ROUTES) {
  test(`${name} is styled in every painted frame`, async ({ page }) => {
    const problems = watchForProblems(page);
    await installFrameSampler(page);

    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForSelector('#late-probe', { state: 'visible' });
    await page.waitForTimeout(250);

    const frames = await readFrames(page);
    const shell = auditProbe('shell-probe', frames);
    const late = auditProbe('late-probe', frames);

    expect(frames.length).toBeGreaterThan(10);
    expect(shell.paintedFrames).toBeGreaterThan(5);
    expect(late.paintedFrames).toBeGreaterThan(0);
    let maxGap = 0;
    for (let i = 1; i < frames.length; i++) {
      maxGap = Math.max(maxGap, frames[i].t - frames[i - 1].t);
    }
    expect(maxGap, 'the frame sampler stalled').toBeLessThan(250);
    expect(
      frames[late.firstPaintedIndex].t - frames[shell.firstPaintedIndex].t,
      'the late boundary was revealed too soon after the shell for this to ' +
        'be testing a streamed chunk at all'
    ).toBeGreaterThan(DELAY_MS / 2);

    expect(
      shell.bad,
      'the shell painted unstyled or mis-styled frames'
    ).toEqual([]);
    expect(
      late.bad,
      'the late Suspense boundary painted before its delta CSS applied'
    ).toEqual([]);
    expect(problems.pageErrors).toEqual([]);
  });

  test(`the frame sampler catches a deliberate flash on ${name}`, async ({
    page
  }) => {
    // These routes' `<head>` is React's, so the server cannot splice a
    // sabotage script into it the way it does for `/` — that splice is
    // precisely what they exist to prove nobody does. The control is
    // installed from the spec instead; see `installSabotage`.
    await installFrameSampler(page);
    await installSabotage(page, 400);

    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForSelector('#late-probe', { state: 'visible' });
    await page.waitForTimeout(500);

    const shell = auditProbe('shell-probe', await readFrames(page));
    expect(
      shell.bad.length,
      'the sampler did not notice a 400ms flash, so the no-FOUC assertions ' +
        `for ${name} prove nothing`
    ).toBeGreaterThan(0);
  });
}

test('/streaming-head with the anchors inside the boundary flashes, and only before they land (React 19+)', async ({
  baseURL,
  page,
  request
}) => {
  // A MAJOR question, deliberately left as one. This route puts the boundary
  // INSIDE `<head>`, which neither major withholds for, so Fizz's
  // Suspense-aware preamble (React >= 19.1) is not involved. What differs by
  // major is whether hydration skips the runtime anchors RNW creates while
  // the boundary is still streaming. Measured to pass on 19.0.0.
  test.skip(
    (await reactMajor(request, baseURL)) < 19,
    'React 18 falls back to client rendering on this shape; see ' +
      'streamingHead.spec.js'
  );

  // THE ONE SHAPE THAT DOES FLASH, AND WHY IT IS NOT A BUG TO FIX.
  //
  // Everything else in this file asserts zero bad frames because the shell
  // stylesheet precedes the markup it styles in the byte stream. Put the
  // anchors inside a Suspense boundary in `<head>` and that stops being true
  // by construction: React flushes `<head>` immediately with a `<!--$?-->`
  // placeholder, the body shell follows in the same flush, and the CSS is
  // still behind the boundary. The browser paints what it has. No delivery
  // mechanism can fix that — the stylesheet does not exist yet — so the
  // honest test is not "there is no flash" but "the flash is exactly the
  // window before the anchors arrive, and nothing after it".
  //
  // Pinned rather than tolerated: if a future React withholds the body until
  // `<head>` completes, or the shape stops flashing for any other reason,
  // this fails and the guide's recommendation gets revisited.
  await installFrameSampler(page);
  await page.goto(`/streaming-head?delay=${DELAY_MS}&headDelay=120`, {
    waitUntil: 'commit'
  });
  await page.waitForSelector('#late-probe', { state: 'visible' });
  await page.waitForTimeout(250);

  const frames = await readFrames(page);
  const shell = auditProbe('shell-probe', frames);
  const late = auditProbe('late-probe', frames);

  expect(frames.length).toBeGreaterThan(10);
  expect(shell.paintedFrames).toBeGreaterThan(5);
  expect(late.paintedFrames).toBeGreaterThan(0);

  expect(
    shell.bad.length,
    'the anchors-in-the-boundary shape no longer flashes; if that is real, ' +
      'the recommendation to render <StyleSheet.Anchors> in the shell can be ' +
      'relaxed — check why before deleting this assertion'
  ).toBeGreaterThan(0);

  // Every bad frame is one where <head> held no shell anchor at all. Once
  // they land, every remaining frame is styled — including the late
  // boundary's, which never paints wrong because its CSS rides its own
  // chunk into the anchors that by then exist.
  const badAfterAnchors = frames.filter(
    (frame) =>
      frame.anchors > 0 &&
      frame.probes['shell-probe'].painted &&
      (frame.probes['shell-probe'].actual.bg !==
        frame.probes['shell-probe'].expected.bg ||
        frame.probes['shell-probe'].actual.pt !==
          frame.probes['shell-probe'].expected.pt ||
        frame.probes['shell-probe'].actual.pl !==
          frame.probes['shell-probe'].expected.pl)
  );
  expect(
    badAfterAnchors.map((frame) => Math.round(frame.t)),
    'a frame painted unstyled AFTER the shell anchors were in <head>, which ' +
      'is a real delivery failure rather than the boundary cost'
  ).toEqual([]);
  expect(late.bad).toEqual([]);
});

/**
 * The detector's own negative control.
 *
 * Everything above is an assertion that a list of bad frames is empty,
 * which is only worth anything if the list can ever be non-empty. This
 * loads the same page with `?broken=N`, which makes the server append a
 * script that blanks the group-3 anchor — the one holding the shell
 * probe's background colour and height — for N milliseconds. Nothing in
 * the library does that; it is a synthetic flash of exactly the kind the
 * streamed-CSS design exists to prevent, and the sampler has to see it.
 */
test('the frame sampler catches a deliberately introduced flash', async ({
  page
}) => {
  await installFrameSampler(page);

  await page.goto('/?delay=200&broken=400', { waitUntil: 'commit' });
  await page.waitForSelector('#late-probe', { state: 'visible' });
  await page.waitForTimeout(500);

  const shell = auditProbe('shell-probe', await readFrames(page));
  expect(
    shell.bad.length,
    'the sampler did not notice a 400ms flash of the shell probe, so the ' +
      'no-FOUC assertions above prove nothing'
  ).toBeGreaterThan(0);
});
