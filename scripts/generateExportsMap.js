#!/usr/bin/env node
/**
 * Regenerates the `exports` map in packages/react-native-web/package.json.
 *
 * WHY THIS IS GENERATED. The map exists so `react-native-web/server` resolves
 * from a native ESM server (Node's ESM resolver does no directory or
 * main-field resolution for a bare-specifier subpath). But `exports` is
 * package-wide encapsulation: the moment it exists, every deep
 * `react-native-web/dist/…` path a consumer or the babel plugin imports has to
 * be named, or it stops resolving.
 *
 * Patterns cannot do that job on their own. A pattern's `*` matches across
 * slashes, so one key covers both `dist/exports/View` (a directory with an
 * index.js) and `dist/exports/Text/TextAncestorContext` (a file) — which need
 * different targets. A fallback array does not disambiguate them either:
 * Node advances to the next array entry only when a target is *invalid*, never
 * when the file is simply missing, and rspack behaves the same way. Verified,
 * not assumed — `@expo/html-elements` imports that TextAncestorContext path
 * extensionless and fails the build under every single-target arrangement.
 *
 * What does work is that an exact key outranks a pattern. So:
 *   - every directory holding an `index.js` gets an exact key
 *   - one `*` pattern per tree root maps everything else to `<path>.js`
 * Between them every real file is reachable, extensionless or not, at any
 * depth, with no ambiguity left to guess about.
 *
 * usage: node scripts/generateExportsMap.js [--check]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PKG_DIR = path.join(__dirname, '..', 'packages', 'react-native-web');
const PKG_JSON = path.join(PKG_DIR, 'package.json');
// Walk `src` only and mirror the result onto the compiled trees. `dist/` and
// `dist/cjs/` are `babel src --out-dir` of exactly this tree, so src is the
// source of truth — and deriving from it means `--check` works in CI, where
// nothing has been built yet.
const SRC = 'src';
const TREES = ['./src', './dist', './dist/cjs'];
const SKIP = new Set(['__tests__', '__mocks__', 'node_modules']);

// The hand-written head of the map. `.` and `./server` carry the same
// condition ladder on purpose: if one resolved to dist/ and the other to
// dist/cjs/, a bundle would hold two StyleSheet modules and the transform
// would read a different sheet registry than the components write to.
const ladder = (esm, cjs) => ({
  browser: { import: esm, require: cjs },
  module: esm,
  node: { import: cjs, require: cjs },
  import: esm,
  require: cjs,
  default: esm
});

function directoriesWithIndex(root) {
  const found = [];
  const walk = (rel) => {
    const abs = path.join(PKG_DIR, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'index.js')) {
      found.push(rel);
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name)) {
        walk(path.posix.join(rel, e.name));
      }
    }
  };
  walk(root);
  return found;
}

function buildExports() {
  const map = {};
  map['.'] = ladder('./dist/index.js', './dist/cjs/index.js');
  map['./server'] = ladder(
    './dist/server/index.js',
    './dist/cjs/server/index.js'
  );
  map['./package.json'] = './package.json';

  // Directories relative to src/, e.g. '' (src itself), 'exports/View'.
  const dirs = directoriesWithIndex(SRC)
    .map((d) => (d === SRC ? '' : d.slice(SRC.length + 1)))
    .sort();

  // An exact key per directory, on each tree. Exact keys outrank patterns,
  // which is what lets a directory and a nested file coexist under one prefix.
  for (const tree of TREES) {
    for (const dir of dirs) {
      const subpath = dir === '' ? tree : `${tree}/${dir}`;
      map[subpath] = `${subpath}/index.js`;
    }
  }

  // Everything that is not a directory-with-index: any file, any depth.
  for (const tree of TREES) {
    map[`${tree}/*.js`] = `${tree}/*.js`;
    map[`${tree}/*`] = `${tree}/*.js`;
  }
  return map;
}

module.exports = buildExports;

// Only act when run directly — the exports-map test requires this file to
// compare the committed map against a freshly generated one, and must not
// have it rewrite package.json as a side effect of being imported.
if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
  const next = buildExports();

  if (process.argv.includes('--check')) {
    if (JSON.stringify(pkg.exports) !== JSON.stringify(next)) {
      console.error(
        'exports map is stale — run `node scripts/generateExportsMap.js`'
      );
      process.exit(1);
    }
    console.log(`exports map is up to date (${Object.keys(next).length} keys)`);
  } else {
    pkg.exports = next;
    fs.writeFileSync(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n');
    const patterns = Object.keys(next).filter((k) => k.includes('*')).length;
    console.log(
      `wrote ${Object.keys(next).length} exports keys ` +
        `(${Object.keys(next).length - patterns} exact, ${patterns} patterns)`
    );
  }
}
