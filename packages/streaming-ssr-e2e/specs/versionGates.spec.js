'use strict';

/**
 * Spec 8 — the version arithmetic the rest of the harness trusts.
 *
 * Two consumers, both of which decide what a run MEANS rather than what it
 * does, and neither of which had any coverage:
 *
 *   1. every other spec's `test.skip`. These gates pick between two
 *      mutually exclusive assertions — "React 18 streams the resolved
 *      document inside a `<div hidden>`" versus "React 19.1+ withholds the
 *      preamble and writes one well-formed document". Misclassify the
 *      build and a spec does not merely skip when it should run, it runs
 *      the *other* major's assertion and fails, which looks exactly like a
 *      library regression;
 *   2. `scripts/react-version-matrix.js`, whose entire purpose is that "if
 *      the numbers a documentation claim cites don't come back from this
 *      script, the claim is wrong, not the script". Its cache validation
 *      and its post-run cross-check are the two things standing between
 *      that promise and a matrix of numbers describing the wrong React.
 *
 * Both are pure: no browser, no server, no React install. That is what
 * makes it possible to cover builds this repo cannot afford to install and
 * cache poisonings it should never actually construct.
 *
 * There is deliberately no `__tests__` directory in this package (see
 * `helpers.js`), so this lives where Playwright will run it, alongside the
 * specs whose gates it protects.
 */

const { expect, test } = require('@playwright/test');

const {
  SUSPENSE_AWARE_PREAMBLE,
  atLeast,
  hasSuspenseAwarePreamble,
  isMainLine,
  majorOf
} = require('./helpers');
const {
  parseSummary,
  reactThatRan,
  satisfies
} = require('../scripts/react-version-matrix');

test.describe('React version classification', () => {
  test('every dist-tag React publishes lands on the right major', () => {
    // Left column: version strings React has actually published under a
    // dist-tag. Right column: the major the gates must read.
    const cases = [
      ['18.3.1', 18],
      ['18.0.0-rc.3', 18],
      ['19.0.0', 19],
      ['19.1.1', 19],
      ['19.2.0', 19],
      ['19.3.0', 19],
      ['19.0.0-beta-26f2496e-20240514', 19],
      ['19.0.0-rc.1', 19],
      ['19.3.0-canary-019019be-20260911', 19],
      // What `/env` actually reports on the experimental channel, measured:
      // `react@experimental` PUBLISHES as
      // `0.0.0-experimental-019019be-20260911` but its `React.version` is
      // `19.3.0-experimental-019019be-20260911`. The gates read
      // `React.version`, so they classify it correctly, and the full suite
      // is green against it (26 passed, 3 skipped).
      ['19.3.0-experimental-019019be-20260911', 19],
      // The published version is the other string, and it is the one a
      // human reads out of `npm view react dist-tags`, passes to
      // `scripts/react-version-matrix.js`, or writes into a workflow. Taken
      // as a number it is major 0 — below React 18 — so every `>= 19` gate
      // in this suite would run its React-18 branch against a build newer
      // than 19.3. There is only one honest reading of a build off main.
      ['0.0.0-experimental-019019be-20260911', Infinity],
      ['0.0.0-nightly-019019be-20260911', Infinity]
    ];

    expect(cases.map(([version]) => majorOf(version))).toEqual(
      cases.map(([, major]) => major)
    );
  });

  test('an unrecognisable version runs the specs rather than skipping them', () => {
    // Failing safe here means failing LOUD. A gate is `skip(major < 19)` or
    // `skip(major >= 19)`; NaN makes both false, so an unreadable `/env`
    // response can never quietly turn the suite into 0 passed, 24 skipped.
    for (const version of ['', '   ', 'garbage', undefined, null]) {
      expect(Number.isNaN(majorOf(version))).toBe(true);
    }
  });

  test('a build off main is newer than every release, not older than all of them', () => {
    const experimental = '0.0.0-experimental-019019be-20260911';
    // The runtime string, which is what the gates see. Both readings have
    // to land on "at least 19"; only one of them is a number.
    expect(majorOf('19.3.0-experimental-019019be-20260911')).toBe(19);

    expect(isMainLine(experimental)).toBe(true);
    expect(isMainLine('19.3.0-canary-019019be-20260911')).toBe(false);
    expect(isMainLine('18.3.1')).toBe(false);

    // `atLeast` is the other consumer of the classification, and it fed
    // `hasSuspenseAwarePreamble`: an experimental build has had Fizz's
    // Suspense-aware preamble since 19.1, so gating it out would skip the
    // preamble specs on a build that supports the feature.
    expect(atLeast(experimental, '19.1.0')).toBe(true);
    expect(atLeast(experimental, '99.0.0')).toBe(true);
    expect(hasSuspenseAwarePreamble(experimental)).toBe(true);
  });

  test('atLeast compares numerically, component by component', () => {
    // The comparisons a string sort gets wrong, and the prerelease policy:
    // a canary of the target release has the feature, so it compares equal.
    expect(atLeast('19.10.0', '19.1.0')).toBe(true);
    expect(atLeast('19.9.0', '19.10.0')).toBe(false);
    expect(atLeast('19.1', '19.1.0')).toBe(true);
    expect(atLeast('19.1.0-canary-abc-2026', '19.1.0')).toBe(true);
    expect(atLeast('19.0.8', '19.1.0')).toBe(false);
    expect(atLeast('18.3.1', '19.1.0')).toBe(false);
  });

  test('the preamble floor is the version it is documented to be', () => {
    // 19.0.8 is the last 19.0.x; `preparePreamble` appears from 19.1.0.
    expect(SUSPENSE_AWARE_PREAMBLE).toBe('19.1.0');
    expect(hasSuspenseAwarePreamble('19.0.8')).toBe(false);
    expect(hasSuspenseAwarePreamble('19.1.0')).toBe(true);
    expect(hasSuspenseAwarePreamble('18.3.1')).toBe(false);
  });
});

test.describe("the matrix runner's own checks", () => {
  test('a cache is only valid if the whole trio agrees', () => {
    // React's cross-package internals are private and version-locked, so
    // these are the couplings `react-dom` itself declares. The ranges are
    // real: 18.3.1 depends on `scheduler@^0.23.2`, 19.3.0 on `^0.28.0`, and
    // the experimental channel pins both its peer and its scheduler to the
    // exact build.
    expect(satisfies('0.23.2', '^0.23.2')).toBe(true);
    expect(satisfies('0.23.9', '^0.23.2')).toBe(true);
    // `^0.23.2` is a PATCH range: caret pins the left-most non-zero
    // component, so 0.24.0 is out. Getting this backwards is the classic
    // way a hand-rolled semver check waves a poisoned cache through.
    expect(satisfies('0.24.0', '^0.23.2')).toBe(false);
    expect(satisfies('0.23.1', '^0.23.2')).toBe(false);
    expect(satisfies('19.4.0', '^19.3.0')).toBe(true);
    expect(satisfies('20.0.0', '^19.3.0')).toBe(false);
    expect(satisfies('18.3.1', '^19.3.0')).toBe(false);
    // A prerelease never satisfies a plain range, and an exact pin means
    // exact — the experimental channel moves daily and two builds from the
    // same day are still two builds.
    expect(satisfies('19.4.0-canary-abc', '^19.3.0')).toBe(false);
    expect(
      satisfies(
        '0.0.0-experimental-019019be-20260911',
        '0.0.0-experimental-019019be-20260911'
      )
    ).toBe(true);
    expect(
      satisfies(
        '0.0.0-experimental-019019be-20260910',
        '0.0.0-experimental-019019be-20260911'
      )
    ).toBe(false);
    // An unrecognised range shape complains rather than assuming.
    expect(satisfies('19.3.0', '>=19.0.0 <20')).toBe(false);
  });

  test('the React that ran is read back out of the run output', () => {
    // The exact line, including Playwright's `[WebServer]` prefix, which is
    // what `stdout: 'pipe'` puts in front of the server's own logging.
    const output = [
      'Running 29 tests using 1 worker',
      '[WebServer] [e2e] listening on http://127.0.0.1:4321 (react 19.0.0)',
      '  26 passed (19.3s)'
    ].join('\n');
    expect(reactThatRan(output)).toBe('19.0.0');
    expect(
      reactThatRan(
        '[WebServer] [e2e] listening on http://127.0.0.1:4321 ' +
          '(react 19.3.0-experimental-019019be-20260911)'
      )
    ).toBe('19.3.0-experimental-019019be-20260911');
    // No line, no attribution: the run cannot be reported as any version.
    expect(reactThatRan('26 passed (19.3s)')).toBe(null);
  });

  test('the summary reader sees a flaky line', () => {
    // `playwright.config.js` pins `retries: 0`, so this cannot appear
    // today. It becomes the difference between a pass and a retry the
    // moment someone enables retries.
    expect(parseSummary('  1 flaky\n  3 skipped\n  20 passed (19.6s)')).toEqual(
      { failed: 0, flaky: 1, passed: 20, skipped: 3 }
    );
    expect(
      parseSummary('  19 failed\n  3 skipped\n  20 passed (19.6s)')
    ).toEqual({ failed: 19, flaky: 0, passed: 20, skipped: 3 });
    // A run that produced no summary at all is 0/0/0, which is what makes
    // `ranAnything` false and the row a FAILED TO RUN rather than a pass.
    expect(parseSummary('command not found')).toEqual({
      failed: 0,
      flaky: 0,
      passed: 0,
      skipped: 0
    });
  });
});
