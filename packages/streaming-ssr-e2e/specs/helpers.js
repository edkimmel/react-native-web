'use strict';

/**
 * Shared spec plumbing. Not named `*.spec.js`, so Playwright does not try to
 * run it. (And there is deliberately no `__tests__` directory anywhere in
 * this package: the repo's jest configs use
 * `testMatch: ['**\/__tests__/**\/?(*-)+(spec|test).[jt]s?(x)']` rooted at
 * `packages/`, and would otherwise try to run these under jsdom.)
 */

/**
 * Collect everything the page complains about. Hydration mismatches, the
 * "switched to client rendering" recovery, and RNW's own development
 * warnings all arrive as `console.error`, so a spec that asserts "hydration
 * is clean" is really asserting that this list stays empty.
 */
function watchForProblems(page) {
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(String((error && error.stack) || error));
  });
  return { consoleErrors, pageErrors };
}

/**
 * Record what the streamed chunks delivered, before any page script runs.
 *
 * A chunk no longer leaves a `<style data-rnw-delta>` behind for a spec to
 * count — that node was the hydration hazard this format exists to remove —
 * so the only durable trace of "a delta really did arrive" is the payload
 * the chunk's script pushes onto `window.__RNW_DELTA__`. RNW drains that
 * queue as soon as it boots, so the queue itself is empty by the time a
 * spec looks at it.
 *
 * Seeding the queue with an array whose `push` also appends to a second,
 * never-drained list keeps the record. The library only ever calls
 * `Array.isArray`, `length` and `shift` on it, so a subclassed `push` is
 * invisible to it.
 *
 * Guarding against a vacuous pass is the point: the delta channel is
 * warmth-sensitive, and a spec that asserts "the late rule still lost to
 * the shell longhand" means nothing if the late rule was in the shell.
 */
const DELTA_RECORDER = `
(() => {
  window.__E2E_DELTAS__ = [];
  const queue = [];
  queue.push = function (...entries) {
    for (const entry of entries) window.__E2E_DELTAS__.push(entry);
    return Array.prototype.push.apply(this, entries);
  };
  window.__RNW_DELTA__ = queue;
})();
`;

async function recordDeltas(page) {
  await page.addInitScript({ content: DELTA_RECORDER });
}

/** Every `{ g, r }` bucket the page's chunks carried, in arrival order. */
function readDeltas(page) {
  return page.evaluate(() => window.__E2E_DELTAS__);
}

/**
 * A per-frame sampler, installed before any page script runs.
 *
 * Why `requestAnimationFrame` and not a MutationObserver or a timer: the
 * event loop runs animation-frame callbacks as the first step of "update
 * the rendering", before style, layout and paint, and the parser does not
 * get to append more nodes between that callback and the paint that
 * follows it. So the DOM and the computed styles this callback sees ARE
 * what that frame paints. One entry per rendered frame, and a frame that
 * paints an element cannot be missed.
 *
 * Each probe carries its own expected values as data-* attributes written
 * by the server, so the sampler needs no knowledge of the app.
 */
const FRAME_SAMPLER = `
(() => {
  const PROBES = ['shell-probe', 'late-probe'];
  window.__FRAMES__ = [];
  const tick = () => {
    // How many SHELL anchors <head> holds as of this frame. Runtime anchors
    // are excluded on purpose: the question this answers is "had the
    // server's stylesheet arrived yet", which is what decides whether an
    // unstyled frame is a bug or the documented cost of putting the anchors
    // behind a Suspense boundary.
    const frame = {
      anchors: document.head.querySelectorAll(
        'style[data-rnw-group]:not([data-rnw-runtime])'
      ).length,
      probes: {},
      t: performance.now()
    };
    for (const id of PROBES) {
      const el = document.getElementById(id);
      if (el == null) { frame.probes[id] = { present: false }; continue; }
      // An element still inside React's <div hidden> shell has no boxes, so
      // it is in the DOM but not on screen. Only painted frames count.
      if (el.getClientRects().length === 0) {
        frame.probes[id] = { present: true, painted: false };
        continue;
      }
      const cs = getComputedStyle(el);
      frame.probes[id] = {
        actual: {
          bg: cs.backgroundColor,
          pl: cs.paddingLeft,
          pt: cs.paddingTop
        },
        expected: {
          bg: el.dataset.expectBg,
          pl: el.dataset.expectPl,
          pt: el.dataset.expectPt
        },
        painted: true,
        present: true
      };
    }
    window.__FRAMES__.push(frame);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
`;

async function installFrameSampler(page) {
  await page.addInitScript({ content: FRAME_SAMPLER });
}

function readFrames(page) {
  return page.evaluate(() => window.__FRAMES__);
}

/**
 * The synthetic flash, as an init script.
 *
 * The `/` route can be sabotaged from the server, because its `<head>` is a
 * string the server assembles. The document routes cannot: `<head>` is
 * React's there, and a `<script>` spliced into it would be the very thing
 * those routes exist to prove nobody does.
 *
 * Blanking a shell anchor — what the server-side sabotage does — is also not
 * available, and for an instructive reason: on those routes React owns that
 * `<style>`, so hydration writes its `dangerouslySetInnerHTML` back and the
 * flash undoes itself before the sampler can see a full one. (Measured, not
 * assumed: with the anchor blanked at t=14ms the sampler still read the
 * correct background at t=57ms.)
 *
 * So the control overrides instead of removing: a `<style>` appended to
 * `<body>`, which every browser cascades after everything in `<head>`,
 * painting the shell probe the wrong colour and size until it is removed.
 * `<body>` rather than `<head>` because a foreign `<style>` among `<div>`
 * siblings in `<body>` is one of the placements measured NOT to disturb
 * hydration — the control has to produce a flash, not a second bug.
 */
const SABOTAGE = (ms) => `
(() => {
  const css = '#shell-probe{background-color:rgb(255,0,0)!important;height:auto!important}';
  const tick = () => {
    if (document.body == null) { requestAnimationFrame(tick); return; }
    const el = document.createElement('style');
    el.setAttribute('data-e2e-sabotage', '');
    el.appendChild(document.createTextNode(css));
    document.body.appendChild(el);
    setTimeout(() => { el.remove(); }, ${ms});
  };
  requestAnimationFrame(tick);
})();
`;

async function installSabotage(page, ms) {
  await page.addInitScript({ content: SABOTAGE(ms) });
}

/**
 * The full React version string the harness is running against — e.g.
 * `"19.1.1"`. See `/env` in server.js, which reports `React.version`.
 *
 * Prefer this over `reactMajor` for anything that is really a question
 * about a *feature*. React 19 is not one target: Fizz's Suspense-aware
 * preamble did not ship until 19.1, so a `major >= 19` gate runs
 * preamble-dependent specs against 19.0.x, where they cannot pass.
 */
async function reactVersion(request, baseURL) {
  const response = await request.get(`${baseURL}/env`);
  const body = await response.json();
  return String(body.react);
}

/**
 * A build published off `main` rather than off a release branch.
 *
 * React's `experimental` dist-tag carries a placeholder PUBLISHED version —
 * `0.0.0-experimental-<sha>-<date>`. The leading `0.0.0` is not a number to
 * compare against; it means "unreleased". Read literally it sorts the
 * newest React there is BELOW React 18, which is wrong in the dangerous
 * direction: a `>= 19` gate would run its React-18 branch — asserting a
 * nested `<div hidden id="S:0"><!DOCTYPE html>`, say — against a build that
 * behaves like 19.3, and the spec would fail rather than skip.
 *
 * MEASURED, and not what an earlier reading of this assumed: the two
 * version strings differ, and `/env` reports the harmless one.
 * `react@experimental` installs as package version
 * `0.0.0-experimental-019019be-20260911` while `React.version` — the string
 * `server.js` puts on `/env`, and therefore the only one these gates ever
 * see — is `19.3.0-experimental-019019be-20260911`. So every gate already
 * classifies the experimental channel correctly, and the full suite is
 * green against it (26 passed, 3 skipped, `E2E_REACT_DIR` pointed at an
 * `npm install react@experimental react-dom@experimental`).
 *
 * This stays because the OTHER string is the one a person handles: it is
 * what `npm view react dist-tags` prints, what
 * `scripts/react-version-matrix.js` takes as an argument, and what a
 * workflow pins. Any path that feeds a published version into these
 * helpers gets the one honest reading of a build off main — newer than
 * every release — rather than "older than React 18".
 */
const MAIN_LINE = /^0\.0\.0-/;

function isMainLine(version) {
  return MAIN_LINE.test(String(version));
}

/**
 * The React major of a version string, as the gates in these specs read it.
 * `Infinity` for a build off main (see `isMainLine`); `NaN` for anything
 * unparseable, which makes both `< 19` and `>= 19` false and is the reason
 * a garbage version can only ever run tests, never silently skip them.
 */
function majorOf(version) {
  if (isMainLine(version)) return Infinity;
  const head = String(version).split('.')[0].trim();
  return head === '' ? NaN : Number(head);
}

/** The React major the harness is running against. */
async function reactMajor(request, baseURL) {
  return majorOf(await reactVersion(request, baseURL));
}

/**
 * `version >= target`, numerically, component by component.
 *
 * Missing components read as 0, so `atLeast('19.1', '19.1.0')` is true. A
 * prerelease suffix is dropped rather than ordered, so a canary of the
 * target release compares equal to it — deliberate: what these gates ask
 * is "does this build have the feature", and a `19.1.0-canary` does. A
 * build off main (`0.0.0-experimental-…`) is newer than every release; see
 * `isMainLine`.
 */
function atLeast(version, target) {
  // A build off main is newer than every release, whatever its numerals
  // say. Without this `atLeast('0.0.0-experimental-…', '19.1.0')` is false
  // and `hasSuspenseAwarePreamble` skips the preamble specs on a build that
  // has had the preamble since 19.1.
  if (isMainLine(version)) return true;
  const parse = (value) =>
    String(value)
      .split('-')[0]
      .split('.')
      .map((part) => Number(part) || 0);
  const actual = parse(version);
  const wanted = parse(target);
  for (let i = 0; i < Math.max(actual.length, wanted.length); i++) {
    const a = actual[i] || 0;
    const b = wanted[i] || 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * The first React whose Fizz has a Suspense-aware preamble.
 *
 * VERIFIED against the installs `scripts/react-version-matrix.js` caches,
 * plus 19.0.8 and 19.1.0 installed for the purpose: `preparePreamble` and
 * `request.completedPreambleSegments` appear in
 * `react-dom/cjs/react-dom-server.node.development.js` from **19.1.0**
 * onwards and in no 19.0.x build, the latest of which is 19.0.8. The whole
 * word "preamble" is absent from 19.0.x's server build.
 *
 * What that gates: a Suspense boundary ABOVE `<html>`/`<head>`. With the
 * preamble, React withholds every byte until the boundary resolves and then
 * writes one well-formed document. Without it, `renderState.htmlChunks` /
 * `headChunks` are still null when `flushCompletedQueues` writes the root
 * segment, so the doctype and the `<html>`/`<head>` open tags are never
 * written at all (19.0.x), or the resolved document is streamed nested
 * inside a `<div hidden>` (18.3.1). Both are unusable.
 */
const SUSPENSE_AWARE_PREAMBLE = '19.1.0';

function hasSuspenseAwarePreamble(version) {
  return atLeast(version, SUSPENSE_AWARE_PREAMBLE);
}

/**
 * The values the *browser* reports, as the app formats them. Computed in
 * the page rather than hardcoded so the specs do not have to guess about
 * scrollbars or device pixel ratio.
 */
function browserValues(page, prefix) {
  return page.evaluate(
    (p) =>
      `${p}:${window.innerWidth}x${window.innerHeight}:` +
      (window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'),
    prefix
  );
}

// What the server declares. Kept in sync with server.js by assertion, not
// by import: these specs are meant to fail if that divergence disappears.
const SERVER_SHELL_TEXT = 'shell:1024x768:dark';
const SERVER_LATE_TEXT = 'late:1024x768:dark';

module.exports = {
  SERVER_LATE_TEXT,
  SERVER_SHELL_TEXT,
  SUSPENSE_AWARE_PREAMBLE,
  atLeast,
  browserValues,
  hasSuspenseAwarePreamble,
  installFrameSampler,
  installSabotage,
  isMainLine,
  majorOf,
  reactMajor,
  reactVersion,
  readDeltas,
  readFrames,
  recordDeltas,
  watchForProblems
};
