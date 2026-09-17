#!/usr/bin/env node

'use strict';

/**
 * React version matrix runner for the streaming-SSR Playwright harness.
 *
 * `build.js` already knows how to point the whole harness (server, app and
 * library) at an arbitrary React via `E2E_REACT_DIR` - a directory holding
 * `react`, `react-dom` and `scheduler`. What was missing was anything that
 * *produces* such a directory and runs the suite against it reproducibly:
 * the version installs behind the "tested on 18.3.1, 19.0.0, 19.1.1, 19.2.0
 * and 19.3.0" claims in STREAMING-SSR.md / REACT19-FINDINGS.md /
 * SUSPENSE-TODO.md were done ad hoc into `/private/tmp` in an earlier
 * session and no longer exist.
 *
 * This script is the reproduction: it installs one or more React versions
 * into a cache directory inside this package's own (gitignored) node_modules,
 * points the harness at each in turn via `E2E_REACT_DIR`, runs
 * `npm run e2e`, and prints a per-version passed/skipped/failed summary. If
 * the numbers a documentation claim cites don't come back from this script,
 * the claim is wrong, not the script.
 *
 * Usage
 *   node scripts/react-version-matrix.js 18.3.1 19.3.0
 *   node scripts/react-version-matrix.js --all
 *   npm run e2e:matrix -- 18.3.1 19.3.0
 *   npm run e2e:matrix:all
 *
 * Flags
 *   --all              run DEFAULT_VERSIONS - every version this repo's
 *                       docs have, at some point, claimed to validate.
 *   --cache-dir=DIR     where per-version React installs are cached.
 *                       Defaults to node_modules/.react-version-cache
 *                       inside this package, which the existing
 *                       `node_modules/` .gitignore entry already covers.
 *   --skip-lib-build    skip rebuilding packages/react-native-web first.
 *                       The harness bundles that package's dist; a stale
 *                       one produces failures that look like this script's
 *                       fault (or the harness's) and are actually just a
 *                       rebuild that didn't happen. Only pass this if you
 *                       already know the dist is current.
 *
 * A version whose install, build or run step throws is reported as such and
 * does not stop the rest of the matrix. Exit code is non-zero if any
 * requested version could not be run at all, or ran with genuine (non-skip)
 * failures.
 *
 * What "could not be run at all" covers, because a matrix runner's only job
 * is to be trustworthy and every one of these would otherwise be reported
 * as a pass:
 *
 *   - the cache directory holds the requested `react` but a mismatched
 *     `react-dom` or `scheduler` (`validateInstall`). Checking only
 *     `react`'s version, as this script used to, accepts a cache poisoned
 *     by an interrupted install or by a hand-edited directory;
 *   - the React that actually *ran* is not the one that was installed
 *     (`reactThatRan`). This is the invariant every number the script
 *     prints rests on, and it was the one thing unverified: the server
 *     announces its `React.version` on startup and Playwright pipes that
 *     into the run output, so it costs one regex to close the loop;
 *   - nothing ran. `0 passed, 24 skipped` exits 0 in Playwright and used to
 *     be reported green here, which is precisely the shape a broken version
 *     gate produces;
 *   - a test needed a retry (`flaky`). `playwright.config.js` pins
 *     `retries: 0` so no flaky line can appear today; parsing it means
 *     enabling retries cannot silently turn a flake into a pass.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HARNESS_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(HARNESS_DIR, '..', '..');

// Every version this repo's docs have, at one point, claimed to validate
// end-to-end. See STREAMING-SSR.md ("React version support"),
// REACT19-FINDINGS.md and SUSPENSE-TODO.md.
//
// 19.0.0 earns its place here for a specific reason: it is the only line in
// the set WITHOUT Fizz's Suspense-aware preamble (which shipped in 19.1.0 and
// is absent from every 19.0.x up to 19.0.8), so it is the only version that
// can catch a spec gating on `major >= 19` when it means ">= 19.1". It did:
// see `specs/helpers.js`'s `hasSuspenseAwarePreamble`.
const DEFAULT_VERSIONS = ['18.3.1', '19.0.0', '19.1.1', '19.2.0', '19.3.0'];

function log(...args) {
  console.log('[react-version-matrix]', ...args);
}

function parseArgs(argv) {
  const versions = [];
  let cacheDir = path.join(HARNESS_DIR, 'node_modules', '.react-version-cache');
  let skipLibBuild = false;
  let all = false;

  for (const arg of argv) {
    if (arg === '--all') {
      all = true;
    } else if (arg === '--skip-lib-build') {
      skipLibBuild = true;
    } else if (arg.startsWith('--cache-dir=')) {
      cacheDir = path.resolve(arg.slice('--cache-dir='.length));
    } else if (arg.startsWith('--')) {
      throw new Error(`unrecognised flag: ${arg}`);
    } else {
      versions.push(arg);
    }
  }

  if (all && versions.length > 0) {
    throw new Error('pass either explicit versions or --all, not both');
  }

  return {
    versions: all ? DEFAULT_VERSIONS : versions,
    cacheDir,
    skipLibBuild
  };
}

/**
 * Rebuild packages/react-native-web's dist. The e2e harness's own bundles
 * are always rebuilt fresh by build.js at server start (see its header
 * comment); the library's dist is not, and this matrix is the thing most
 * likely to be run right after someone has changed its src.
 */
function buildLibrary() {
  log(
    'building packages/react-native-web (npm run build --workspace=packages/react-native-web)'
  );
  const result = spawnSync(
    'npm',
    ['run', 'build', '--workspace=packages/react-native-web'],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  if (result.status !== 0) {
    throw new Error(`library build failed (exit ${result.status})`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The version in a package's own package.json, or null if it is not there.
 * Note this is the PUBLISHED version, which is not always `React.version`:
 * `react@experimental` publishes as `0.0.0-experimental-<sha>-<date>` while
 * reporting `19.3.0-experimental-<sha>-<date>` at runtime (measured).
 */
function packageVersion(nodeModules, name) {
  const file = path.join(nodeModules, name, 'package.json');
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file).version;
  } catch {
    return null;
  }
}

/**
 * `version` satisfies `range`, for the deliberately small subset of semver
 * React's own packages use: an exact pin (the experimental channel pins
 * `scheduler` and its `react` peer to the exact build) and `^`/`~` over a
 * plain `x.y.z` (`^0.23.2`, `^0.28.0`, `^19.3.0`).
 *
 * Anything it does not recognise is reported as NOT satisfied. This
 * function exists to make a poisoned cache loud, so the safe direction is
 * to complain: a false alarm is a one-line fix here, a missed mismatch is a
 * whole matrix of numbers that mean nothing.
 */
function satisfies(version, range) {
  const actual = String(version).trim();
  const wanted = String(range).trim();
  if (actual === wanted) return true;

  const bounds = /^([\^~])(\d+)\.(\d+)\.(\d+)$/.exec(wanted);
  const found = /^(\d+)\.(\d+)\.(\d+)$/.exec(actual);
  // A prerelease never satisfies a plain range — `^19.3.0` does not accept
  // `19.4.0-canary`, and npm agrees.
  if (bounds == null || found == null) return false;

  const floor = bounds.slice(2).map(Number);
  const version3 = found.slice(1).map(Number);
  // `^` allows changes that do not modify the left-most non-zero component,
  // which is why `^0.23.2` is a patch range and `^19.3.0` is not. `~`
  // allows patch changes only.
  const leftmost = floor.findIndex((part) => part > 0);
  const pinned =
    bounds[1] === '~' ? 2 : leftmost === -1 ? 3 : Math.min(leftmost + 1, 3);

  for (let i = 0; i < pinned; i++) {
    if (version3[i] !== floor[i]) return false;
  }
  for (let i = 0; i < 3; i++) {
    if (version3[i] !== floor[i]) return version3[i] > floor[i];
  }
  return true;
}

/**
 * Everything wrong with the install in `nodeModules`, as a list of
 * sentences. Empty means it is a coherent, complete trio at `version`.
 *
 * `react-dom` declares both of the couplings that matter — `peerDependencies
 * .react` and `dependencies.scheduler` — so they are checked against what
 * is actually on disk rather than re-derived here. React's cross-package
 * internals are private and version-locked: a `react@19.3.0` +
 * `react-dom@19.2.0` cache is not a slightly-off matrix row, it is a run
 * whose numbers describe nothing.
 */
function validateInstall(nodeModules, version) {
  const problems = [];
  const installed = {
    react: packageVersion(nodeModules, 'react'),
    'react-dom': packageVersion(nodeModules, 'react-dom'),
    scheduler: packageVersion(nodeModules, 'scheduler')
  };

  for (const pkg of ['react', 'react-dom', 'scheduler']) {
    if (installed[pkg] == null) {
      problems.push(`${pkg} is missing from ${nodeModules}`);
    }
  }
  if (problems.length > 0) return problems;

  for (const pkg of ['react', 'react-dom']) {
    if (installed[pkg] !== version) {
      problems.push(
        `${pkg}@${installed[pkg]} is installed where ${pkg}@${version} was asked for`
      );
    }
  }

  const reactDomPkg = readJson(
    path.join(nodeModules, 'react-dom', 'package.json')
  );
  const peer = (reactDomPkg.peerDependencies || {}).react;
  const schedulerRange = (reactDomPkg.dependencies || {}).scheduler;

  if (peer != null && !satisfies(installed.react, peer)) {
    problems.push(
      `react@${installed.react} does not satisfy react-dom@${installed['react-dom']}'s ` +
        `peer dependency on react@${peer}`
    );
  }
  if (
    schedulerRange != null &&
    !satisfies(installed.scheduler, schedulerRange)
  ) {
    problems.push(
      `scheduler@${installed.scheduler} does not satisfy react-dom@${installed['react-dom']}'s ` +
        `dependency on scheduler@${schedulerRange}`
    );
  }

  return problems;
}

/**
 * `React.version` of the install — what the harness will report at runtime,
 * and therefore what the post-run cross-check has to compare against. Not
 * the same string as the published version on the experimental channel.
 */
function runtimeReactVersion(nodeModules) {
  return String(require(path.join(nodeModules, 'react')).version);
}

/**
 * Install `react@version` + `react-dom@version` into
 * `<cacheDir>/<version>/node_modules`, reusing a prior install if it already
 * has the right version. react-dom depends on scheduler, and with nothing
 * else in this tiny, single-purpose tree to conflict with, npm hoists it to
 * the same top-level node_modules - exactly the flat `react` / `react-dom` /
 * `scheduler` layout `E2E_REACT_DIR` (see build.js) expects.
 *
 * Returns the node_modules directory to pass as `E2E_REACT_DIR`.
 */
function installReact(version, cacheDir) {
  const installDir = path.join(cacheDir, version);
  const nodeModules = path.join(installDir, 'node_modules');

  // The whole trio, not just `react`. A cache that holds the right `react`
  // beside the wrong `react-dom` is the one shape that reads as "already
  // cached" and runs anyway.
  const stale = validateInstall(nodeModules, version);
  const needsInstall = stale.length > 0;
  if (needsInstall && fs.existsSync(nodeModules)) {
    for (const problem of stale) {
      log(`cache at ${installDir} is stale: ${problem}`);
    }
  }

  if (needsInstall) {
    fs.mkdirSync(installDir, { recursive: true });
    log(`installing react@${version} + react-dom@${version} -> ${installDir}`);
    // No package.json needed in installDir: npm installs straight into
    // <installDir>/node_modules given --prefix.
    const result = spawnSync(
      'npm',
      [
        'install',
        '--prefix',
        installDir,
        '--no-audit',
        '--no-fund',
        '--no-save',
        '--no-package-lock',
        `react@${version}`,
        `react-dom@${version}`
      ],
      { stdio: 'inherit' }
    );
    if (result.status !== 0) {
      throw new Error(
        `npm install failed for react@${version} (exit ${result.status})`
      );
    }
  } else {
    log(`react@${version} already cached at ${installDir}`);
  }

  // Also run after a fresh install: npm can leave a partial tree behind
  // when it is interrupted, and every number this script prints assumes
  // this directory is what E2E_REACT_DIR is documented to be.
  const problems = validateInstall(nodeModules, version);
  if (problems.length > 0) {
    throw new Error(
      `the install at ${nodeModules} is not a usable react@${version}: ` +
        `${problems.join('; ')}`
    );
  }

  const runtimeVersion = runtimeReactVersion(nodeModules);
  log(
    `react@${version} ready (React.version ${runtimeVersion}, ` +
      `scheduler ${packageVersion(nodeModules, 'scheduler')})`
  );

  return { nodeModules, runtimeVersion };
}

/**
 * Playwright's `list` reporter (playwright.config.js pins it) ends the run
 * with summary lines shaped like:
 *
 *   19 failed
 *   3 skipped
 *   20 passed (19.6s)
 *
 * any subset of which may be absent (e.g. no "failed" line when nothing
 * failed). Anchoring to line-start/line-end keeps this from matching
 * anything in a stack trace.
 */
function parseSummary(output) {
  const passed = /^\s*(\d+) passed\b/m.exec(output);
  const failed = /^\s*(\d+) failed\s*$/m.exec(output);
  const flaky = /^\s*(\d+) flaky\s*$/m.exec(output);
  const skipped = /^\s*(\d+) skipped\s*$/m.exec(output);
  return {
    failed: failed ? Number(failed[1]) : 0,
    flaky: flaky ? Number(flaky[1]) : 0,
    passed: passed ? Number(passed[1]) : 0,
    skipped: skipped ? Number(skipped[1]) : 0
  };
}

/**
 * The React the run actually used, read back out of the run's own output.
 *
 * `server.js` announces `React.version` when it binds, and Playwright's
 * `webServer` is configured with `stdout: 'pipe'`, so the line arrives here
 * as `[WebServer] [e2e] listening on http://127.0.0.1:4321 (react 19.0.0)`.
 * That is the only end-to-end evidence available that `E2E_REACT_DIR` was
 * honoured — the alias happens inside esbuild, two processes away.
 *
 * Returns null if the line is absent, which is itself reported: an
 * unverifiable run is not a green one.
 */
function reactThatRan(output) {
  const matches = [
    ...output.matchAll(/\[e2e\] listening on \S+ \(react ([^)]+)\)/g)
  ];
  return matches.length === 0 ? null : matches[matches.length - 1][1].trim();
}

function runSuite(reactDir) {
  const result = spawnSync('npm', ['run', 'e2e'], {
    cwd: HARNESS_DIR,
    encoding: 'utf8',
    env: { ...process.env, E2E_REACT_DIR: reactDir },
    maxBuffer: 64 * 1024 * 1024
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(output);
  const summary = parseSummary(output);
  const ranAnything =
    summary.passed + summary.failed + summary.skipped + summary.flaky > 0;
  return {
    ...summary,
    exitCode: result.status,
    ranAnything,
    reactThatRan: reactThatRan(output)
  };
}

function main() {
  const { versions, cacheDir, skipLibBuild } = parseArgs(process.argv.slice(2));

  if (versions.length === 0) {
    console.error(
      'usage: node scripts/react-version-matrix.js <version> [<version> ...] | --all\n' +
        `  --all runs: ${DEFAULT_VERSIONS.join(', ')}`
    );
    process.exit(2);
  }

  if (!skipLibBuild) {
    buildLibrary();
  }

  const results = [];
  for (const version of versions) {
    log(`=== React ${version} ===`);
    try {
      const { nodeModules, runtimeVersion } = installReact(version, cacheDir);
      const run = runSuite(nodeModules);
      const { passed, failed, flaky, skipped, exitCode, ranAnything } = run;
      if (!ranAnything) {
        results.push({
          error: `the suite did not produce a result (npm run e2e exited ${exitCode} with no Playwright summary - see output above)`,
          version
        });
      } else if (run.reactThatRan == null) {
        results.push({
          error:
            'could not confirm which React ran: the server never announced ' +
            'a version (expected a "[e2e] listening on ... (react X)" line ' +
            'in the output above). The numbers below would be unattributable.',
          version
        });
      } else if (run.reactThatRan !== runtimeVersion) {
        results.push({
          error:
            `the suite ran against React ${run.reactThatRan}, not the ` +
            `React ${runtimeVersion} installed for it - E2E_REACT_DIR was ` +
            'not honoured, so this row would have described the wrong version',
          version
        });
      } else if (passed === 0) {
        // `0 passed, N skipped` exits 0. A version gate that classifies
        // this React into no branch at all produces exactly that, and it is
        // the failure this script is least able to afford reporting green.
        results.push({
          error: `nothing ran: 0 passed, ${skipped} skipped, ${failed} failed`,
          version
        });
      } else {
        results.push({
          failed,
          flaky,
          ok: exitCode === 0 && failed === 0 && flaky === 0,
          passed,
          reactThatRan: run.reactThatRan,
          skipped,
          version
        });
      }
    } catch (error) {
      results.push({ error: error.message, version });
    }
  }

  console.log('\n=== React version matrix summary ===');
  for (const result of results) {
    if (result.error) {
      console.log(`  React ${result.version}: FAILED TO RUN - ${result.error}`);
    } else {
      console.log(
        `  React ${result.version} (ran as ${result.reactThatRan}): ` +
          `${result.passed} passed, ${result.skipped} skipped, ` +
          `${result.failed} failed` +
          (result.flaky > 0 ? `, ${result.flaky} flaky` : '')
      );
    }
  }

  const allOk = results.every((result) => result.ok);
  process.exit(allOk ? 0 : 1);
}

// Guarded so the checks above can be required and asserted on directly —
// `specs/versionGates.spec.js` does exactly that. A trust anchor whose own
// arithmetic is untested is not one.
if (require.main === module) {
  main();
}

module.exports = {
  parseSummary,
  reactThatRan,
  satisfies,
  validateInstall
};
