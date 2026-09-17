#!/usr/bin/env node
'use strict';

// Drives the nextjs-head-hydration repro app in Chromium (via the
// @playwright/test / Chromium install that already lives at the repo root)
// across every scenario x position x {dev,prod} combination, and reports:
//   - the __reactFiber$ back-pointer mapping for every probe node
//   - every console.error / pageerror, verbatim
//   - whether React discarded and recreated any probe node
//   - proof that the out-of-band injection ran before hydration committed
//
// Usage:
//   node scripts/run-probe.js                 # runs dev AND prod, all scenarios
//   node scripts/run-probe.js --mode=dev       # just dev
//   node scripts/run-probe.js --mode=prod      # just prod
//   node scripts/run-probe.js --json out.json  # also dump raw JSON

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const APP_ROOT = path.resolve(__dirname, '..');

const { chromium } = require(path.join(
  REPO_ROOT,
  'node_modules',
  '@playwright',
  'test'
));

const DEV_PORT = 3311;
const PROD_PORT = 3312;

const SCENARIOS = [
  {
    scenario: 'a',
    position: 'between',
    label: 'A: <style> in <head>, BETWEEN anchors (our exact bug)'
  },
  {
    scenario: 'a',
    position: 'after',
    label: 'A: <style> in <head>, AFTER last anchor'
  },
  {
    scenario: 'b',
    position: 'between',
    label: 'B: <script> in <body>, BETWEEN siblings (mimics flight push)'
  },
  {
    scenario: 'b',
    position: 'after',
    label: 'B: <script> in <body>, AFTER last sibling (mimics flight push)'
  },
  {
    scenario: 'c',
    position: 'between',
    label: 'C: <style> in <body>, BETWEEN siblings'
  },
  {
    scenario: 'c',
    position: 'after',
    label: 'C: <style> in <body>, AFTER last sibling'
  },
  {
    scenario: 'd',
    position: 'between',
    label: 'D: <script> in <head>, BETWEEN anchors'
  },
  {
    scenario: 'd',
    position: 'after',
    label: 'D: <script> in <head>, AFTER last anchor'
  },
  {
    scenario: 'e',
    position: 'between',
    label: 'E: control - useServerInsertedHTML (React-owned)'
  },
  {
    scenario: 'f',
    position: 'between',
    label: 'F: control - React 19 <style precedence> (React-hoisted)'
  }
];

function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const req = http.get(
        { host: 'localhost', port, path: '/', timeout: 2000 },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on('error', () => {
        if (Date.now() > deadline)
          reject(new Error(`server on ${port} never came up`));
        else setTimeout(attempt, 300);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() > deadline)
          reject(new Error(`server on ${port} never came up`));
        else setTimeout(attempt, 300);
      });
    }
    attempt();
  });
}

function startServer(mode) {
  const port = mode === 'dev' ? DEV_PORT : PROD_PORT;
  const args =
    mode === 'dev'
      ? ['run', 'dev', '--', '-p', String(port)]
      : ['run', 'start', '--', '-p', String(port)];
  const child = spawn('npm', args, {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      NODE_ENV: mode === 'dev' ? 'development' : 'production'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));
  child.getLog = () => out;
  return { child, port };
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        /* already dead */
      }
    }, 4000);
  });
}

async function runScenario(
  browser,
  baseUrl,
  mode,
  { scenario, position, label }
) {
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleMessages = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    pageErrors.push(String(err && err.stack ? err.stack : err));
  });

  // Deliberately hold back the client JS bundle so the out-of-band DOM
  // mutation (which runs synchronously, inline, during HTML parsing) is
  // separated from hydration by a large, unambiguous margin - proving the
  // ordering the whole premise depends on, instead of assuming it.
  const CHUNK_DELAY_MS = 600;
  await page.route('**/_next/static/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
    await route.continue();
  });

  const url = `${baseUrl}/?scenario=${scenario}&position=${position}`;
  const navStart = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Wait for hydration to actually commit (HydrationMarker's useEffect).
  let hydrationTimedOut = false;
  try {
    await page.waitForFunction(
      () => window.__PROBE && window.__PROBE.hydrated === true,
      { timeout: 15000 }
    );
  } catch (e) {
    hydrationTimedOut = true;
  }
  // Give React a beat to finish logging any async dev warnings.
  await page.waitForTimeout(300);

  const data = await page.evaluate(() => {
    function fiberKeyOf(el) {
      return Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    }

    function describe(el) {
      const key = fiberKeyOf(el);
      const fiber = key ? el[key] : null;
      const domAttr =
        el.getAttribute('data-probe-anchor') ||
        el.getAttribute('data-probe-foreign') ||
        el.getAttribute('data-probe-serverinserted') ||
        el.getAttribute('data-probe-precedence') ||
        el.getAttribute('data-probe-instrumentation') ||
        null;
      let fiberProp = null;
      let fiberTypeName = null;
      if (fiber) {
        const props = fiber.memoizedProps || {};
        fiberProp =
          props['data-probe-anchor'] ||
          props['data-probe-serverinserted'] ||
          props['data-probe-precedence'] ||
          null;
        const t = fiber.elementType || fiber.type;
        fiberTypeName =
          typeof t === 'string'
            ? t
            : t && t.name
            ? t.name
            : t
            ? String(t)
            : null;
      }
      return {
        tag: el.tagName.toLowerCase(),
        domAttr,
        hasFiber: !!fiber,
        fiberProp,
        fiberTypeName,
        identityPreservedFromPreHydration:
          window.__PROBE && window.__PROBE.preHydrationSet
            ? window.__PROBE.preHydrationSet.has(el)
            : null
      };
    }

    const headChildren = Array.from(document.head.children).map(describe);
    const bodyChildren = Array.from(document.body.children).map(describe);

    return {
      headChildren,
      bodyChildren,
      probe: window.__PROBE
        ? {
            config: window.__PROBE.config,
            injectedAt: window.__PROBE.injectedAt,
            bundleEvalAt: window.__PROBE.bundleEvalAt,
            hydratedAt: window.__PROBE.hydratedAt,
            hydrated: window.__PROBE.hydrated,
            log: window.__PROBE.log
          }
        : null,
      // React strips unrecognized props (like our own data-probe-precedence
      // marker) off a <style precedence> resource and rewrites precedence/
      // href as data-precedence/data-href - so key off those instead.
      headHoistedPrecedenceStyle: !!document.head.querySelector(
        'style[data-href="probe-precedence-f"]'
      ),
      headHoistedPrecedenceStyleIndex: Array.from(
        document.head.children
      ).findIndex(
        (el) =>
          el.tagName === 'STYLE' &&
          el.getAttribute('data-href') === 'probe-precedence-f'
      )
    };
  });

  await context.close();

  // Skew detection: any head/body probe-anchor node whose fiber's own
  // recorded prop disagrees with the DOM node it is physically attached to,
  // or that has no fiber at all where one is expected.
  const anchorNodes = [...data.headChildren, ...data.bodyChildren].filter(
    (n) => n.domAttr && /^(\d+|b\d+)$/.test(n.domAttr)
  );
  const skewed = anchorNodes.filter(
    (n) => !n.hasFiber || n.fiberProp !== n.domAttr
  );
  const identityLost = anchorNodes.filter(
    (n) => n.identityPreservedFromPreHydration === false
  );

  const orderingHeld =
    data.probe &&
    typeof data.probe.injectedAt === 'number' &&
    typeof data.probe.bundleEvalAt === 'number' &&
    data.probe.injectedAt < data.probe.bundleEvalAt;

  return {
    mode,
    scenario,
    position,
    label,
    url,
    navMs: Date.now() - navStart,
    hydrationTimedOut,
    consoleMessages,
    pageErrors,
    anchorNodes,
    skewed,
    identityLost,
    orderingHeld,
    timestamps: data.probe
      ? {
          injectedAt: data.probe.injectedAt,
          bundleEvalAt: data.probe.bundleEvalAt,
          hydratedAt: data.probe.hydratedAt
        }
      : null,
    foreignLog: data.probe ? data.probe.log : null,
    headHoistedPrecedenceStyle: data.headHoistedPrecedenceStyle,
    headHoistedPrecedenceStyleIndex: data.headHoistedPrecedenceStyleIndex,
    headChildren: data.headChildren,
    bodyChildren: data.bodyChildren
  };
}

async function main() {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith('--mode='));
  const modes = modeArg ? [modeArg.split('=')[1]] : ['dev', 'prod'];
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

  const allResults = [];

  for (const mode of modes) {
    if (mode === 'prod') {
      console.error('[probe] building production bundle...');
      await new Promise((resolve, reject) => {
        const build = spawn('npm', ['run', 'build'], {
          cwd: APP_ROOT,
          stdio: 'inherit'
        });
        build.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error('next build failed'))
        );
      });
    }

    console.error(`[probe] starting ${mode} server...`);
    const { child, port } = startServer(mode);
    try {
      await waitForServer(port, 60000);
      // Warm the route once (dev compiles on first request).
      await new Promise((resolve) => {
        http.get(
          { host: 'localhost', port, path: '/?scenario=a&position=between' },
          (res) => {
            res.resume();
            res.on('end', resolve);
          }
        );
      });

      const browser = await chromium.launch();
      try {
        for (const s of SCENARIOS) {
          console.error(`[probe] ${mode} :: ${s.label}`);
          const result = await runScenario(
            browser,
            `http://localhost:${port}`,
            mode,
            s
          );
          allResults.push(result);
        }
      } finally {
        await browser.close();
      }
    } finally {
      await stopServer(child);
    }
  }

  if (jsonOut) {
    require('fs').writeFileSync(jsonOut, JSON.stringify(allResults, null, 2));
  }

  // Print a compact console summary.
  console.log('\n=== SUMMARY ===');
  for (const r of allResults) {
    const skewStr = r.skewed.length
      ? `SKEWED (${r.skewed
          .map((s) => `${s.domAttr}->${s.fiberProp || 'unowned'}`)
          .join(', ')})`
      : 'clean';
    const idStr = r.identityLost.length
      ? `IDENTITY LOST (${r.identityLost.map((n) => n.domAttr).join(', ')})`
      : 'ids preserved';
    const errStr =
      r.consoleMessages.filter((m) => m.type === 'error').length ||
      r.pageErrors.length
        ? 'HAS ERRORS'
        : 'no errors';
    console.log(
      `[${r.mode}] ${r.label} => ${skewStr} | ${idStr} | ${errStr} | orderingHeld=${r.orderingHeld}`
    );
  }

  return allResults;
}

main()
  .then((results) => {
    if (require.main === module && !process.argv.includes('--json')) {
      // no-op; summary already printed
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
