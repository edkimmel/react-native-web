#!/usr/bin/env node
'use strict';

// Companion to run-probe.js. That script proves out-of-band DOM mutation
// (script -> createElement -> insertBefore, executed while the parser is
// still working through <body>) skews hydration for same-tag nodes.
//
// This script isolates the OTHER injection path named in the brief:
// content spliced directly into the raw HTML *response bytes*, before the
// browser's HTML parser ever sees them - modeling Next's own
// `createHeadInsertionTransformStream`, which splices text into the Fizz
// byte stream ahead of `</head>`.
//
// IMPORTANT METHODOLOGY NOTE (see FINDINGS.md "byte-splice harness
// gotcha"): the obvious way to do this is a Playwright
// `page.route(url, route => route.fetch().then(...).then(route.fulfill))`
// intercept. That was tried first and discarded: fulfilling the TOP-LEVEL
// document navigation via CDP (`route.fulfill`) reproducibly breaks this
// app's hydration in `next dev` (Turbopack) even when the refulfilled body
// is BYTE-IDENTICAL to the original - _next/static chunks still download
// and finish, but the client bundle never evaluates
// (`window.__PROBE.bundleEvalAt` never gets set). This reproduces with a
// plain Node `http.get` swapped in for `route.fetch()` too, so it is not
// about Playwright's fetch implementation specifically - it is specific to
// answering the *document* navigation via `route.fulfill`. Confirmed NOT
// to be about gzip/content-encoding (fixed separately, see git history of
// this file) - a byte-identical passthrough via fetch+fulfill *also* hangs
// hydration, while a bare `route.continue()` on the same URL does not.
//
// So instead: a real, tiny, standalone HTTP proxy (this file, "the
// splicer") sits in front of the real Next server. Playwright navigates
// directly to the proxy's origin. The browser only ever sees one, ordinary,
// real HTTP response for the document - never a CDP-fulfilled one - so
// whatever Turbopack-dev-specific expectation `route.fulfill` was violating
// no longer applies. This is arguably a MORE faithful model of Next's own
// mechanism anyway: `createHeadInsertionTransformStream` is exactly this -
// a byte-level transform sitting between the real server and the socket
// the browser reads from - our proxy just does the same transform one hop
// further out.
//
// The app is driven with scenario=none (see app/_shared/scenario.js): no
// script-driven insertion happens at all; every foreign node in this file
// comes from the network-level splice.
//
// Usage:
//   node scripts/run-byte-splice-probe.js
//   node scripts/run-byte-splice-probe.js --mode=dev
//   node scripts/run-byte-splice-probe.js --json out.json

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

const DEV_PORT = 3321;
const PROD_PORT = 3322;
const DEV_PROXY_PORT = 3323;
const PROD_PROXY_PORT = 3324;

// Exact serialized markup Next/React emit for the anchors (verified by
// curling the dev server - see FINDINGS.md). Byte-splicing is regex'd
// against this literal text, not against a live DOM, precisely because the
// whole point is to mutate the bytes before any DOM exists.
const HEAD_ANCHOR_1 = '<style data-probe-anchor="1"></style>';
const HEAD_CLOSE = '</head>';
const BODY_ANCHOR_B1 = '<div data-probe-anchor="b1">body probe 1</div>';
const BODY_CLOSE = '</body>';

function foreignHtml(tag, label) {
  if (tag === 'style') {
    return `<style data-probe-foreign="${label}"></style>`;
  }
  if (tag === 'script') {
    return `<script data-probe-foreign="${label}">window.__PROBE=window.__PROBE||{};window.__PROBE.log=window.__PROBE.log||[];window.__PROBE.log.push("foreign-script-ran:${label}");</script>`;
  }
  if (tag === 'meta') {
    return `<meta data-probe-foreign="${label}" name="probe-foreign-${label}" content="x">`;
  }
  if (tag === 'link') {
    return `<link data-probe-foreign="${label}" rel="prefetch" href="/probe-foreign-${label}.txt">`;
  }
  throw new Error('unknown tag ' + tag);
}

const SCENARIOS = [
  {
    id: 'g-style-head-between',
    label: 'G: byte-spliced <style> in <head>, BETWEEN anchors',
    container: 'head',
    tag: 'style',
    position: 'between'
  },
  {
    id: 'g-style-head-after',
    label: 'G: byte-spliced <style> in <head>, AFTER last anchor',
    container: 'head',
    tag: 'style',
    position: 'after'
  },
  {
    id: 'g-script-head-between',
    label: 'G: byte-spliced <script> in <head>, BETWEEN anchors',
    container: 'head',
    tag: 'script',
    position: 'between'
  },
  {
    id: 'g-meta-head-between',
    label: 'G: byte-spliced <meta> in <head>, BETWEEN anchors',
    container: 'head',
    tag: 'meta',
    position: 'between'
  },
  {
    id: 'g-link-head-between',
    label: 'G: byte-spliced <link> in <head>, BETWEEN anchors',
    container: 'head',
    tag: 'link',
    position: 'between'
  },
  {
    id: 'g-style-body-between',
    label: 'G: byte-spliced <style> in <body>, BETWEEN siblings',
    container: 'body',
    tag: 'style',
    position: 'between'
  },
  {
    id: 'g-script-body-between',
    label:
      'G: byte-spliced <script> in <body>, BETWEEN siblings (mimics flight push, but byte-spliced not appended)',
    container: 'body',
    tag: 'script',
    position: 'between'
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

// The splicer: a real forward proxy the browser talks to directly, so the
// only thing Playwright ever intercepts is a plain static-asset delay - the
// document response itself is a completely ordinary network response as
// far as the browser/Next-dev-client is concerned.
function startSplicerProxy({ proxyPort, targetPort, targetPathAndQuery, container, tag, position }) {
  const label = `${container}-byte-${tag}`;
  const inserted = foreignHtml(tag, label);

  const server = http.createServer((clientReq, clientRes) => {
    const isTarget =
      clientReq.method === 'GET' && clientReq.url === targetPathAndQuery;

    const upstreamHeaders = { ...clientReq.headers };
    upstreamHeaders.host = `localhost:${targetPort}`;
    if (isTarget) {
      // Force an uncompressed response so we can splice plain text - avoids
      // ever having to decode content-encoding ourselves.
      upstreamHeaders['accept-encoding'] = 'identity';
    }

    const upstreamReq = http.request(
      {
        host: 'localhost',
        port: targetPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: upstreamHeaders
      },
      (upstreamRes) => {
        if (!isTarget) {
          clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          upstreamRes.pipe(clientRes);
          return;
        }
        const chunks = [];
        upstreamRes.on('data', (d) => chunks.push(d));
        upstreamRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let spliced;
          if (container === 'head') {
            spliced =
              position === 'between'
                ? body.replace(HEAD_ANCHOR_1, HEAD_ANCHOR_1 + inserted)
                : body.replace(HEAD_CLOSE, inserted + HEAD_CLOSE);
          } else {
            spliced =
              position === 'between'
                ? body.replace(BODY_ANCHOR_B1, BODY_ANCHOR_B1 + inserted)
                : body.replace(BODY_CLOSE, inserted + BODY_CLOSE);
          }
          const applied = spliced !== body;
          const headers = { ...upstreamRes.headers };
          delete headers['content-length'];
          delete headers['content-encoding'];
          headers['x-probe-splice-applied'] = String(applied);
          clientRes.writeHead(upstreamRes.statusCode, headers);
          clientRes.end(spliced);
        });
      }
    );
    upstreamReq.on('error', (e) => {
      clientRes.writeHead(502);
      clientRes.end('proxy upstream error: ' + e.message);
    });
    clientReq.pipe(upstreamReq);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(proxyPort, () => resolve(server));
  });
}

function stopHttpServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function runScenario(browser, proxyBaseUrl, mode, s) {
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', (msg) =>
    consoleMessages.push({ type: msg.type(), text: msg.text() })
  );
  page.on('pageerror', (err) =>
    pageErrors.push(String(err && err.stack ? err.stack : err))
  );

  const url = `${proxyBaseUrl}/?scenario=none&position=${s.position}`;
  const label = `${s.container}-byte-${s.tag}`;

  // Still hold the client bundle back - not to establish ordering (the
  // byte splice already guarantees the foreign node predates any script by
  // construction, since it's spliced by a proxy the real browser socket
  // reads from) but so hydration timing is directly comparable to
  // run-probe.js's methodology. This is a plain Playwright route on a
  // STATIC ASSET, not the document - confirmed safe (does not reproduce
  // the fulfill-breaks-hydration issue).
  const CHUNK_DELAY_MS = 600;
  await page.route('**/_next/static/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
    await route.continue();
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  let hydrationTimedOut = false;
  try {
    await page.waitForFunction(
      () => window.__PROBE && window.__PROBE.hydrated === true,
      { timeout: 15000 }
    );
  } catch (e) {
    hydrationTimedOut = true;
  }
  await page.waitForTimeout(300);

  const data = await page.evaluate(
    ({ containerSel, foreignLabel }) => {
      function fiberKeyOf(el) {
        return Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      }
      function describe(el) {
        const key = fiberKeyOf(el);
        const fiber = key ? el[key] : null;
        const domAttr =
          el.getAttribute('data-probe-anchor') ||
          el.getAttribute('data-probe-foreign') ||
          null;
        let fiberProp = null;
        let fiberTypeName = null;
        if (fiber) {
          const props = fiber.memoizedProps || {};
          fiberProp = props['data-probe-anchor'] || null;
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
          fiberTypeName
        };
      }
      const container =
        containerSel === 'head' ? document.head : document.body;
      const foreignNode = container.querySelector(
        '[data-probe-foreign="' + foreignLabel + '"]'
      );
      return {
        headChildren: Array.from(document.head.children).map(describe),
        bodyChildren: Array.from(document.body.children).map(describe),
        foreignNodePresentPreEvaluate: !!foreignNode,
        foreignNodeDescribed: foreignNode ? describe(foreignNode) : null,
        probe: window.__PROBE
          ? {
              config: window.__PROBE.config,
              hydrated: window.__PROBE.hydrated,
              log: window.__PROBE.log
            }
          : null
      };
    },
    { containerSel: s.container, foreignLabel: label }
  );

  await context.close();

  const anchorNodes = [...data.headChildren, ...data.bodyChildren].filter(
    (n) => n.domAttr && /^(\d+|b\d+)$/.test(n.domAttr)
  );
  const skewed = anchorNodes.filter(
    (n) => !n.hasFiber || n.fiberProp !== n.domAttr
  );

  return {
    mode,
    id: s.id,
    label: s.label,
    container: s.container,
    tag: s.tag,
    position: s.position,
    url,
    hydrationTimedOut,
    consoleMessages,
    pageErrors,
    anchorNodes,
    skewed,
    foreignNodePresentPreEvaluate: data.foreignNodePresentPreEvaluate,
    foreignNodeDescribed: data.foreignNodeDescribed,
    foreignLog: data.probe ? data.probe.log : null,
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
      console.error('[byte-splice] building production bundle...');
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

    console.error(`[byte-splice] starting ${mode} server...`);
    const { child, port } = startServer(mode);
    const proxyPort = mode === 'dev' ? DEV_PROXY_PORT : PROD_PROXY_PORT;
    try {
      await waitForServer(port, 60000);
      await new Promise((resolve) => {
        http.get(
          { host: 'localhost', port, path: '/?scenario=none&position=between' },
          (res) => {
            res.resume();
            res.on('end', resolve);
          }
        );
      });

      const browser = await chromium.launch();
      try {
        for (const s of SCENARIOS) {
          console.error(`[byte-splice] ${mode} :: ${s.label}`);
          const proxy = await startSplicerProxy({
            proxyPort,
            targetPort: port,
            targetPathAndQuery: `/?scenario=none&position=${s.position}`,
            container: s.container,
            tag: s.tag,
            position: s.position
          });
          try {
            const result = await runScenario(
              browser,
              `http://localhost:${proxyPort}`,
              mode,
              s
            );
            allResults.push(result);
          } finally {
            await stopHttpServer(proxy);
          }
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

  console.log('\n=== BYTE-SPLICE SUMMARY ===');
  for (const r of allResults) {
    const skewStr = r.skewed.length
      ? `SKEWED (${r.skewed
          .map((s) => `${s.domAttr}->${s.fiberProp || 'unowned'}`)
          .join(', ')})`
      : 'clean';
    const errStr =
      r.consoleMessages.filter((m) => m.type === 'error').length ||
      r.pageErrors.length
        ? 'HAS ERRORS'
        : 'no errors';
    console.log(
      `[${r.mode}] ${r.label} => ${skewStr} | ${errStr} | hydrationTimedOut=${r.hydrationTimedOut} | foreignPresent=${r.foreignNodePresentPreEvaluate}`
    );
  }

  return allResults;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
