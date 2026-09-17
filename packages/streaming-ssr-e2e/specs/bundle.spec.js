'use strict';

/**
 * Spec 5 — the browser bundle contains no Node builtins.
 *
 * `modules/asyncContext` imports `node:async_hooks` and
 * `modules/styleInjection` imports `node:stream`, both statically. What
 * keeps them out of an app bundle is the `browser` field map in the
 * package's package.json, which esbuild honours because build.js sets
 * `platform: 'browser'`.
 *
 * The check is on esbuild's metafile — the exact list of modules that went
 * into the bundle — rather than on a grep of the output, because the
 * browser builds legitimately mention `node:stream` in their own error
 * text and a grep cannot tell that apart from an import.
 */

const fs = require('node:fs');
const { expect, test } = require('@playwright/test');
const { CLIENT_BUNDLE, CLIENT_METAFILE } = require('../build.js');

test('no Node builtins survive into the client bundle', () => {
  const metafile = JSON.parse(fs.readFileSync(CLIENT_METAFILE, 'utf8'));
  const inputs = Object.keys(metafile.inputs);

  const nodeish = inputs.filter((input) =>
    /(^|[/(])node:|(^|\/)(stream|async_hooks|fs|path)$/.test(input)
  );
  expect(nodeish, 'Node builtins reached the browser bundle').toEqual([]);

  const rnw = inputs.filter((input) =>
    input.includes('react-native-web/dist/')
  );
  expect(
    rnw.length,
    'the built package was not bundled at all'
  ).toBeGreaterThan(0);

  // The `browser` field map picked the browser build of both server-only
  // modules, and left the Node build out entirely.
  const has = (suffix) => inputs.some((input) => input.endsWith(suffix));
  expect(has('modules/asyncContext/index.browser.js')).toBe(true);
  expect(has('modules/styleInjection/index.browser.js')).toBe(true);
  expect(has('modules/asyncContext/index.js')).toBe(false);
  expect(has('modules/styleInjection/index.js')).toBe(false);

  // Belt and braces on the emitted source: no import or require of either
  // builtin under any spelling esbuild would produce.
  const source = fs.readFileSync(CLIENT_BUNDLE, 'utf8');
  for (const specifier of [
    'require("node:stream")',
    "require('node:stream')",
    'require("node:async_hooks")',
    "require('node:async_hooks')",
    'require("stream")',
    'require("async_hooks")',
    'from"node:stream"',
    'from"node:async_hooks"'
  ]) {
    expect(
      source.includes(specifier),
      `client bundle references ${specifier}`
    ).toBe(false);
  }
});

test('the browser build of the streaming adapter refuses to run', async ({
  page
}) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__E2E_CLIENT_STARTED__ === true);

  const outcome = await page.evaluate(() => {
    try {
      window.__RNW_STREAMING_ADAPTER__({});
      return { threw: false };
    } catch (error) {
      return { message: String(error.message), threw: true };
    }
  });

  expect(outcome.threw).toBe(true);
  expect(outcome.message).toMatch(/react-native-web/);
});
