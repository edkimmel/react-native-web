/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The store in an environment with no `window` at all.
 *
 * This is not a hypothetical: the module is imported by `Dimensions` and
 * `Appearance`, both of which are evaluated on every server render. A
 * `ReferenceError` here would take down SSR, and the jsdom suite cannot
 * prove its absence because jsdom always has a `window`.
 */

describe('modules/hydrationState/store without a DOM', () => {
  test('window is genuinely absent, or this file proves nothing', () => {
    expect(typeof window).toBe('undefined');
  });

  test('reading returns null instead of throwing', () => {
    jest.isolateModules(() => {
      const store = require('../store');
      expect(store.getServerValue('Dimensions')).toBeNull();
    });
  });

  test('writing and reading back still works', () => {
    // The server side has no global to parse, but `setServerValue` is a
    // plain in-memory record and must not be collateral damage.
    jest.isolateModules(() => {
      const store = require('../store');
      store.setServerValue('Appearance', { colorScheme: 'dark' });
      expect(store.getServerValue('Appearance').colorScheme).toBe('dark');
    });
  });
});
