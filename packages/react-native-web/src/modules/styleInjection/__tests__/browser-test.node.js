/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `index.browser.js` is what a bundler substitutes via the `browser` field
 * map in `package.json`. Its whole job is to keep `node:stream` out of a
 * browser or native bundle, and to fail loudly rather than hand back
 * something stream-shaped that does nothing.
 */

import createStyleInjectionTransform from '../index.browser';

describe('modules/styleInjection browser build', () => {
  test('throws with an actionable message instead of returning a fake stream', () => {
    expect(() => createStyleInjectionTransform()).toThrow(
      /takeShellHTML\(\) and StyleSheet\.takeDeltaHTML\(\)/
    );
  });

  test('importing it pulls in no node builtins', () => {
    const source = require('fs').readFileSync(
      require.resolve('../index.browser.js'),
      'utf8'
    );
    // A browser bundle that resolved this file must not reach a Node core
    // module through it — that is the entire reason the file exists.
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(/require\(['"]node:/);
  });
});
