/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Regression test for the ESM server bundle.
 *
 * The rest of the suite runs under Babel-CJS, where `require` exists in
 * module scope. That is precisely why it cannot catch the failure this
 * module used to have: `eval('require')('async_hooks')` throws under ESM,
 * the catch swallowed it, and every concurrent request silently shared one
 * state object.
 *
 * So compile the module the way `build:es` does (ESM preserved), run it in
 * a real Node ESM context, and assert request scoping actually works there.
 */

const babel = require('@babel/core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../../../../..');
const babelConfig = require(path.join(repoRoot, 'configs/babel.config.js'));
const srcDir = path.resolve(__dirname, '..');

// Inside the repo so bare specifiers (@babel/runtime helpers) still resolve.
const outDir = path.join(repoRoot, 'node_modules/.rnw-esm-regression');

function compileToEsm(filename) {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevBabelEnv = process.env.BABEL_ENV;
  // babel.config.js emits CommonJS when NODE_ENV === 'test'; we want the
  // `build:es` output, which is what a bundler feeds an ESM server build.
  process.env.NODE_ENV = 'production';
  delete process.env.BABEL_ENV;
  try {
    return babel.transformSync(fs.readFileSync(filename, 'utf8'), {
      ...babelConfig(),
      babelrc: false,
      configFile: false,
      filename
    }).code;
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevBabelEnv === undefined) {
      delete process.env.BABEL_ENV;
    } else {
      process.env.BABEL_ENV = prevBabelEnv;
    }
  }
}

// Node's ESM resolver has no extension or directory resolution, so flatten
// the module graph's relative specifiers onto the emitted `.mjs` filenames.
function flattenSpecifiers(code) {
  return code
    .replace(/(['"])\.\.\/canUseDom\1/g, "'./canUseDom.mjs'")
    .replace(/(['"])\.\/createAsyncContext\1/g, "'./createAsyncContext.mjs'");
}

const ENTRY = `
import {
  configureRequestScope,
  getProcessState,
  getScopedState,
  hasRequestScope,
  runInRequestScope
} from './index.mjs';

if (typeof configureRequestScope !== 'function') {
  throw new Error('configureRequestScope is not exported');
}

getProcessState('k', () => ({ v: 'process-default' }));

const scoped = await Promise.all(
  [1, 2, 3, 4].map((n) =>
    runInRequestScope(async () => {
      const state = getScopedState('k', () => ({ v: 0 }));
      state.v = n;
      // Yield so the scopes interleave: this only reads back \`n\` if
      // AsyncLocalStorage really is propagating across the await.
      await Promise.resolve();
      return { inScope: hasRequestScope(), value: state.v };
    })
  )
);

console.log(
  JSON.stringify({
    scoped,
    outsideScope: hasRequestScope(),
    processDefault: getScopedState('k', () => ({ v: 0 })).v
  })
);
`;

describe('modules/asyncContext under a real ESM bundle', () => {
  beforeAll(() => {
    fs.rmSync(outDir, { force: true, recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    const files = {
      'canUseDom.mjs': path.join(srcDir, '../canUseDom/index.js'),
      'createAsyncContext.mjs': path.join(srcDir, 'createAsyncContext.js'),
      'index.mjs': path.join(srcDir, 'index.js')
    };
    Object.keys(files).forEach((outName) => {
      fs.writeFileSync(
        path.join(outDir, outName),
        flattenSpecifiers(compileToEsm(files[outName]))
      );
    });
    fs.writeFileSync(path.join(outDir, 'entry.mjs'), ENTRY);
  });

  afterAll(() => {
    fs.rmSync(outDir, { force: true, recursive: true });
  });

  test('the compiled ESM module still resolves AsyncLocalStorage', () => {
    const stdout = execFileSync(
      process.execPath,
      [path.join(outDir, 'entry.mjs')],
      { encoding: 'utf8' }
    );

    expect(JSON.parse(stdout)).toEqual({
      scoped: [
        { inScope: true, value: 1 },
        { inScope: true, value: 2 },
        { inScope: true, value: 3 },
        { inScope: true, value: 4 }
      ],
      outsideScope: false,
      processDefault: 'process-default'
    });
  });

  test('the emitted ESM keeps a static import and no eval()', () => {
    const code = compileToEsm(path.join(srcDir, 'index.js'));
    expect(code).toMatch(/import .* from ["']node:async_hooks["']/);
    expect(code).not.toMatch(/\beval\s*\(/);
  });
});
