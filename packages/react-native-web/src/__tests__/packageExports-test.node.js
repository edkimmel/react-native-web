/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Guard for the package's `exports` map.
 *
 * WHY. `react-native-web/server` has to resolve from a native `"type":
 * "module"` server, and Node's ESM resolver does no directory resolution for
 * a bare-specifier subpath, so the checked-in `server/package.json` shim
 * failed with ERR_UNSUPPORTED_DIR_IMPORT there. An `exports` map is the only
 * mechanism that fixes it — and it comes with package-wide encapsulation:
 * once the map exists, a subpath it does not name is *blocked*.
 *
 * HOW THE MAP IS BUILT. It is generated, by
 * `node scripts/generateExportsMap.js`, from the `src/` tree (`dist/` and
 * `dist/cjs/` are `babel src --out-dir` of it, so src is the source of truth
 * and the generator works in CI, where nothing has been built). It emits an
 * exact, non-pattern key for every directory holding an `index.js`, on each
 * of the three trees, plus one `*` pair per tree root sending everything else
 * to `<path>.js`.
 *
 * WHY NOT PATTERNS ALONE. A pattern's `*` matches across slashes, so a single
 * `./dist/exports/*` key catches both `dist/exports/View` (a directory) and
 * `dist/exports/Text/TextAncestorContext` (a file), which need different
 * targets. A fallback array does not separate them: the next array entry is
 * tried only when a target is *invalid*, never when the file is merely
 * missing. That is true of Node and — measured, after assuming otherwise and
 * being wrong — of rspack too. And the shapes really are mixed at every
 * depth: `exports/StyleSheet` is a directory, `exports/StyleSheet/dom` is a
 * directory, `exports/StyleSheet/dom/ingestDelta` is a file.
 *
 * An earlier revision of this map used one pattern pair per directory and
 * accepted the resulting hole: ~207 extensionless nested subpaths across the
 * three trees resolved before the map and not after, including the two
 * `react-native-reanimated` 3.x needs on web, and the whole `vendor/` tree
 * could only ever serve its directories OR its files, never both. Exact keys
 * close all of it — verified against a packed tarball, not modelled.
 *
 * WHAT THIS TEST DOES. It walks the real directory tree, resolves each
 * subpath through a small model of Node's pattern matching, and fails here
 * rather than in a consumer's build. It does NOT run `import()` and does not
 * pack a tarball; that check is still worth doing by hand when the map
 * changes, and the guide says so.
 *
 * The staleness test is the important one: it re-runs the generator and
 * compares. Everything else is a property the generated map has to have, kept
 * so that a hand-edit or a generator change that breaks one is caught by name.
 */

const fs = require('fs');
const path = require('path');

const PKG_DIR = path.resolve(__dirname, '../..');
const pkg = require('../../package.json');
const exportsMap = pkg.exports;

/**
 * Top-level directories under `src/` that deliberately have no pattern pair,
 * with the reason. A new directory is not allowed to land in here silently —
 * that is the whole point — so adding one means writing down why nothing
 * imports it by specifier.
 */
const NOT_EXPORTED = {
  __tests__: 'not published at all — `files` excludes `**/__tests__`',
  server:
    'reached through the `./server` entry point, which names its targets ' +
    'literally; there is no extensionless deep-import shape for it',
  types: 'Flow type declarations; there is no runtime module to import',
  vendor:
    'vendored react-native internals. They ARE published and consumers do ' +
    'reach them, but they need no top-level pattern pair: the generated map ' +
    'gives every directory under them an exact key, and the tree-root `*` ' +
    'pattern serves the flat files (Animated/**). Both shapes resolve, which ' +
    'a single pattern pair could never do — see the docblock'
};

function dirsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function filesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

/** The directories the map enumerates, as `src/`-relative names. */
const ENUMERATED = ['exports', 'modules'];

/** `src/` prefixes the map is expected to cover identically. */
const TREES = ['./src', './dist', './dist/cjs'];

const distBuilt = fs.existsSync(path.join(PKG_DIR, 'dist'));

/**
 * The target `subpath` resolves to, as a model of Node's
 * PACKAGE_EXPORTS_RESOLVE for the shapes this map uses: exact keys, and keys
 * containing exactly one `*`.
 *
 * Two behaviours are modelled deliberately, because they are the two the map
 * is designed around:
 *
 *   - the most specific pattern wins. Node picks the key with the longest
 *     base (the part before `*`), which is what lets `./dist/exports/*` beat
 *     the catch-all `./dist/*`.
 *   - a fallback array is NOT a search path. Node walks it looking for a
 *     target that is *shaped* validly, not one that exists, so with every
 *     entry relative and well-formed the first one always wins.
 */
function resolveSubpath(subpath) {
  if (typeof exportsMap[subpath] === 'string') return exportsMap[subpath];

  let best = null;
  Object.keys(exportsMap).forEach((key) => {
    const star = key.indexOf('*');
    if (star === -1) return;
    const base = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(base) || !subpath.endsWith(suffix)) return;
    if (subpath.length < base.length + suffix.length) return;
    if (best != null && best.base.length >= base.length) return;
    best = { base, key, suffix };
  });
  if (best == null) return null;

  const wildcard = subpath.slice(
    best.base.length,
    subpath.length - best.suffix.length
  );
  let target = exportsMap[best.key];
  if (Array.isArray(target)) target = target[0];
  if (typeof target !== 'string') return null;
  return target.split('*').join(wildcard);
}

describe('the exports map covers the tree it is generated from', () => {
  /**
   * The invariant the per-directory patterns are built on. A bare `.js` file
   * directly under `src/exports` would resolve, through
   * the `./src/exports` directory pattern, to `Foo.js` + `/index.js`.
   */
  test('every entry under exports/ and modules/ is a directory with an index.js', () => {
    const problems = [];
    const roots = [path.join(PKG_DIR, 'src')];
    if (distBuilt) {
      roots.push(path.join(PKG_DIR, 'dist'), path.join(PKG_DIR, 'dist/cjs'));
    }

    roots.forEach((root) => {
      ENUMERATED.forEach((name) => {
        const dir = path.join(root, name);
        if (!fs.existsSync(dir)) return;
        filesIn(dir).forEach((file) => {
          problems.push(
            `${path.relative(
              PKG_DIR,
              path.join(dir, file)
            )} is a file, not a ` +
              `directory. The exports map assumes everything here is a ` +
              `directory with an index.js`
          );
        });
        dirsIn(dir).forEach((child) => {
          if (child === '__tests__') return;
          if (!fs.existsSync(path.join(dir, child, 'index.js'))) {
            problems.push(
              `${path.relative(PKG_DIR, path.join(dir, child))} has no ` +
                `index.js, so its extensionless subpath resolves to nothing`
            );
          }
        });
      });
    });

    expect(problems).toEqual([]);
  });

  /**
   * The trap, stated as the thing that actually breaks: a subpath a consumer
   * writes extensionless must resolve to the file that is there.
   */
  test('every importable directory resolves through the map to its index.js', () => {
    const problems = [];
    ENUMERATED.forEach((name) => {
      dirsIn(path.join(PKG_DIR, 'src', name)).forEach((child) => {
        if (child === '__tests__') return;
        TREES.forEach((tree) => {
          const subpath = `${tree}/${name}/${child}`;
          const resolved = resolveSubpath(subpath);
          const expected = `${subpath}/index.js`;
          if (resolved !== expected) {
            problems.push(
              `${subpath} resolves to ${resolved} — expected ${expected}`
            );
            return;
          }
          const onDisk = path.join(PKG_DIR, resolved);
          if (resolved.startsWith('./dist/') && !distBuilt) return;
          if (!fs.existsSync(onDisk)) {
            problems.push(
              `${subpath} resolves to ${resolved}, which is absent`
            );
          }
        });
      });
    });
    expect(problems).toEqual([]);
  });

  /**
   * And the other half: a top-level directory that has no pattern pair is
   * either listed as deliberately unexported, or it is the bug this file was
   * written for.
   */
  test('every top-level source directory is mapped or explicitly not exported', () => {
    const unexplained = [];
    dirsIn(path.join(PKG_DIR, 'src')).forEach((name) => {
      if (ENUMERATED.includes(name)) return;
      if (NOT_EXPORTED[name] != null) return;
      unexplained.push(name);
    });

    if (unexplained.length > 0) {
      throw new Error(
        `src/${unexplained.join(', src/')} is neither covered by the exports ` +
          `map nor listed as deliberately unexported.\n\n` +
          `If consumers import into it (extensionless, e.g. ` +
          `react-native-web/dist/${unexplained[0]}/Thing), add BOTH patterns ` +
          `for each of ./src, ./dist and ./dist/cjs:\n` +
          `  "./dist/${unexplained[0]}/*.js": "./dist/${unexplained[0]}/*.js",\n` +
          `  "./dist/${unexplained[0]}/*":    "./dist/${unexplained[0]}/*/index.js"\n\n` +
          `If they do not, add it to NOT_EXPORTED in this file with the ` +
          `reason. The catch-all "./src/*" entry does NOT cover it: Node uses ` +
          `the first shape-valid target of a fallback array without checking ` +
          `whether the file exists.`
      );
    }

    // The listed exemptions have to be real directories, so the list cannot
    // rot into an excuse for a directory that was renamed.
    Object.keys(NOT_EXPORTED).forEach((name) => {
      expect(fs.existsSync(path.join(PKG_DIR, 'src', name))).toBe(true);
    });
  });

  /**
   * `./src`, `./dist` and `./dist/cjs` have to be enumerated identically. The
   * src walk is what runs in CI (where `dist/` is not built), and it is only
   * evidence about `dist/` if the three trees carry the same keys.
   */
  test('the src, dist and dist/cjs keys mirror each other', () => {
    const missing = [];
    TREES.forEach((tree) => {
      [`${tree}/*.js`, `${tree}/*`].forEach((key) => {
        if (exportsMap[key] == null) missing.push(key);
      });
    });
    ENUMERATED.forEach((name) => {
      dirsIn(path.join(PKG_DIR, 'src', name)).forEach((child) => {
        if (child === '__tests__') return;
        TREES.forEach((tree) => {
          const key = `${tree}/${name}/${child}`;
          if (exportsMap[key] == null) missing.push(key);
        });
      });
    });
    expect(missing).toEqual([]);
  });

  /**
   * The map is generated. A hand-edit, or a new directory added without
   * re-running the generator, shows up here rather than in a consumer's
   * build. This is the test that actually keeps the map honest; the others
   * assert properties it should have.
   */
  test('the committed map is what the generator produces', () => {
    const generate = require('../../../../scripts/generateExportsMap.js');
    expect(exportsMap).toEqual(generate());
  });

  /**
   * Every name the repo's own babel plugin rewrites to a deep import has to
   * come out of the map as a real file. This is the exact failure the map was
   * added to prevent, read from the consumer's end.
   */
  test('every module the babel plugin rewrites resolves', () => {
    const moduleMap = require('../../../babel-plugin-react-native-web/src/moduleMap');
    const problems = [];
    const names = Object.keys(moduleMap).concat(['index']);

    names.forEach((name) => {
      ['./dist', './dist/cjs'].forEach((tree) => {
        const subpath =
          name === 'index' ? `${tree}/index` : `${tree}/exports/${name}`;
        const resolved = resolveSubpath(subpath);
        if (resolved == null) {
          problems.push(`${subpath} is not covered by the exports map`);
          return;
        }
        const src = resolved
          .replace('./dist/cjs/', './src/')
          .replace('./dist/', './src/');
        if (!fs.existsSync(path.join(PKG_DIR, src))) {
          problems.push(
            `${subpath} resolves to ${resolved}, whose source ${src} is absent`
          );
        }
      });
    });
    expect(problems).toEqual([]);
  });

  /**
   * Literal (non-pattern) targets. `./server` and `.` carry condition
   * ladders; every leaf in them is a path this package must actually ship.
   */
  test('every literal target in the map exists in the source tree', () => {
    const targets = [];
    const collect = (value) => {
      if (typeof value === 'string') targets.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value != null && typeof value === 'object')
        Object.keys(value).forEach((key) => collect(value[key]));
    };
    Object.keys(exportsMap).forEach((key) => {
      if (key.indexOf('*') === -1) collect(exportsMap[key]);
    });
    expect(targets.length).toBeGreaterThan(5);

    const problems = [];
    targets.forEach((target) => {
      // dist/ is generated; check its source twin, which is always present.
      const src = target
        .replace('./dist/cjs/', './src/')
        .replace('./dist/', './src/');
      if (!fs.existsSync(path.join(PKG_DIR, src))) {
        problems.push(`${target} has no source at ${src}`);
      }
      if (target.startsWith('./dist/') && distBuilt) {
        if (!fs.existsSync(path.join(PKG_DIR, target))) {
          problems.push(`${target} is named in the map but was not built`);
        }
      }
    });
    expect(problems).toEqual([]);
  });

  /**
   * The two entry points must resolve to the same tree under every condition
   * a runtime can pick. If `.` landed on `dist/` while `./server` landed on
   * `dist/cjs/`, a bundle would contain two `StyleSheet` modules and the
   * transform would read a different sheet registry than the components
   * write to — which is silent, and worse than a resolution error.
   */
  test('the root and /server condition ladders agree', () => {
    const conditions = (entry) => {
      const out = {};
      const walk = (value, trail) => {
        if (typeof value === 'string') {
          out[trail.join('.')] = value.includes('/cjs/') ? 'cjs' : 'esm';
          return;
        }
        Object.keys(value).forEach((key) =>
          walk(value[key], trail.concat(key))
        );
      };
      walk(entry, []);
      return out;
    };
    expect(conditions(exportsMap['./server'])).toEqual(
      conditions(exportsMap['.'])
    );
  });

  /**
   * Deep imports real packages in the wild make. These are the ones that have
   * to keep working, so they are named rather than derived — a pattern the map
   * happens to satisfy today is not the same as a promise.
   *
   * `react-native-reanimated` >= 4 reaches into the StyleSheet internals with
   * the extension, which the `*.js` passthrough covers because a `*` matches
   * across `/`. Its 3.x line used the same paths *without* the extension; see
   * the next test.
   */
  test('pinned deep-import shapes resolve', () => {
    const pinned = [
      // react-native-reanimated >= 4, verified against the published tarball
      './dist/cjs/exports/StyleSheet/compiler/createReactDOMStyle.js',
      './dist/cjs/exports/StyleSheet/preprocess.js',
      // the same shapes on the ESM tree
      './dist/exports/StyleSheet/compiler/createReactDOMStyle.js',
      './dist/exports/StyleSheet/preprocess.js',
      // directory-shaped vendored internals, reached by list libraries
      './dist/vendor/react-native/Animated/NativeAnimatedHelper.js',
      // the two entry shapes the repo's own babel plugin emits
      './dist/exports/View',
      './dist/index'
    ];
    const problems = [];
    pinned.forEach((subpath) => {
      const resolved = resolveSubpath(subpath);
      if (resolved == null) {
        problems.push(`${subpath} is not covered by the exports map`);
        return;
      }
      const src = resolved
        .replace('./dist/cjs/', './src/')
        .replace('./dist/', './src/');
      if (!fs.existsSync(path.join(PKG_DIR, src))) {
        problems.push(
          `${subpath} resolves to ${resolved}, whose source ${src} is absent`
        );
      }
    });
    expect(problems).toEqual([]);
  });

  /**
   * The inverse of a test that used to live here. These extensionless nested
   * subpaths resolved before the `exports` map existed and were then broken by
   * it — the visible edge of a ~207-subpath hole the pattern-pair design could
   * not close. The generated exact-key map resolves all of them again. The
   * first two are what `react-native-reanimated` 3.x requires on web; the
   * vendor pair is the tree that previously could serve its directories or its
   * files but never both.
   */
  test('the formerly-blocked extensionless nested subpaths resolve', () => {
    const shapes = [
      // react-native-reanimated 3.x, on web
      './dist/exports/StyleSheet/compiler/createReactDOMStyle',
      './dist/exports/StyleSheet/preprocess',
      // representative of the rest of the class
      './dist/exports/ScrollView/ScrollViewBase',
      './dist/modules/useResponderEvents/ResponderSystem',
      // the vendor tree, both shapes at once
      './dist/vendor/react-native/VirtualizedList',
      './dist/vendor/react-native/Animated/NativeAnimatedHelper',
      // the nested file that broke a real consuming build (@expo/html-elements)
      './dist/exports/Text/TextAncestorContext',
      // mixed depths under one prefix
      './dist/exports/StyleSheet/dom',
      './dist/exports/StyleSheet/dom/ingestDelta'
    ];
    const problems = [];
    shapes.forEach((subpath) => {
      const resolved = resolveSubpath(subpath);
      if (resolved == null) {
        problems.push(`${subpath} is not covered by the exports map`);
        return;
      }
      const src = resolved
        .replace('./dist/cjs/', './src/')
        .replace('./dist/', './src/');
      if (!fs.existsSync(path.join(PKG_DIR, src))) {
        problems.push(
          `${subpath} -> ${resolved}, whose source ${src} is absent`
        );
      }
    });
    expect(problems).toEqual([]);
  });
});
