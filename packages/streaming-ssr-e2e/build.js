'use strict';

/**
 * Two esbuild bundles, both built at server start so nothing can go stale.
 *
 *   - the node bundle keeps react, react-dom and the library external, so
 *     the server resolves `@edkimmel/react-native-web` through Node's own
 *     resolution: package.json `main` -> dist/cjs/index.js;
 *   - the browser bundle is `platform: 'browser'`, so esbuild applies the
 *     `browser` field map and swaps modules/asyncContext and
 *     modules/styleInjection for their browser builds. If that mapping ever
 *     broke, this build would fail loudly on an unresolvable `node:stream`
 *     rather than shipping something subtly wrong.
 *
 * Set `E2E_REACT_DIR` to a directory containing `react`, `react-dom` and
 * `scheduler` to run the whole harness against a different React. Both
 * bundles are then resolved through an esbuild alias, and the node bundle
 * stops externalising react/react-dom/the library so that the server, the
 * app and the library all end up on the same copy.
 */

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
// `dist`, not something dot-prefixed: the repo's prettier and eslint
// configs already ignore `packages/*/dist`, and `npm run clean` at the
// root removes it.
const OUT = path.join(ROOT, 'dist');

const CLIENT_BUNDLE = path.join(OUT, 'client.js');
const CLIENT_METAFILE = path.join(OUT, 'client.meta.json');
const NODE_BUNDLE = path.join(OUT, 'app.node.js');

const REACT_DIR = process.env.E2E_REACT_DIR || null;

const reactAlias =
  REACT_DIR == null
    ? undefined
    : {
        react: path.join(REACT_DIR, 'react'),
        'react-dom': path.join(REACT_DIR, 'react-dom'),
        scheduler: path.join(REACT_DIR, 'scheduler')
      };

const nodeExternals =
  REACT_DIR == null
    ? [
        '@edkimmel/react-native-web',
        // Externalised separately: an esbuild `external` entry without a
        // wildcard matches the import path exactly, so the subpath would
        // otherwise be bundled and the server would run against two copies of
        // the library — two request scopes, two stylesheets.
        '@edkimmel/react-native-web/server',
        'react',
        'react-dom',
        'react-dom/client',
        'react-dom/server'
      ]
    : [];

async function build() {
  await esbuild.build({
    alias: reactAlias,
    bundle: true,
    entryPoints: [path.join(ROOT, 'app', 'serverEntry.js')],
    external: nodeExternals,
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    logLevel: 'warning',
    outfile: NODE_BUNDLE,
    platform: 'node',
    sourcemap: false,
    target: 'node18'
  });

  const client = await esbuild.build({
    alias: reactAlias,
    bundle: true,
    // Development React, so hydration mismatches are actually reported.
    // The specs fail on any console error, which is only meaningful if the
    // warnings exist.
    define: { 'process.env.NODE_ENV': '"development"' },
    entryPoints: [path.join(ROOT, 'app', 'client.js')],
    format: 'iife',
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    logLevel: 'warning',
    metafile: true,
    outfile: CLIENT_BUNDLE,
    platform: 'browser',
    sourcemap: false,
    target: 'chrome110'
  });

  // The metafile lists every module that made it into the browser bundle.
  // The "no Node builtins" spec reads it, which is a stronger check than
  // grepping the output: the browser builds mention `node:stream` in their
  // own error text.
  fs.writeFileSync(CLIENT_METAFILE, JSON.stringify(client.metafile, null, 2));

  return { clientBundle: CLIENT_BUNDLE, nodeBundle: NODE_BUNDLE };
}

module.exports = {
  CLIENT_BUNDLE,
  CLIENT_METAFILE,
  NODE_BUNDLE,
  REACT_DIR,
  build
};
