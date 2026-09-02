/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `index.browser.js` is what a bundler substitutes via the `browser` field
 * map. These tests run it in the Node environment (`canUseDOM === false`) —
 * i.e. a non-Node server runtime whose bundler picked the browser build.
 * The point of the module is that this configuration must never silently
 * degrade to process-wide shared state.
 */

const { AsyncLocalStorage } = require('async_hooks');

function loadBrowserModule() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../index.browser');
  });
  return mod;
}

describe('modules/asyncContext browser build on a server runtime', () => {
  test('runInRequestScope throws in development instead of sharing state', () => {
    const { runInRequestScope } = loadBrowserModule();
    expect(() => runInRequestScope(() => null)).toThrow(
      /configureRequestScope/
    );
  });

  test('runInRequestScope logs once, and runs, in production', () => {
    const { hasRequestScope, runInRequestScope } = loadBrowserModule();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(runInRequestScope(() => 'ran')).toBe('ran');
      expect(runInRequestScope(() => hasRequestScope())).toBe(false);
      // Noisy, but only once per process.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatch(/configureRequestScope/);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      spy.mockRestore();
    }
  });

  test('configureRequestScope restores real per-request isolation', async () => {
    const {
      configureRequestScope,
      getScopedState,
      hasRequestScope,
      runInRequestScope
    } = loadBrowserModule();

    configureRequestScope({ AsyncLocalStorage });

    const reads = await Promise.all(
      [1, 2, 3].map((n) =>
        runInRequestScope(async () => {
          const state = getScopedState('configured', () => ({ v: 0 }));
          state.v = n;
          await Promise.resolve();
          return { inScope: hasRequestScope(), value: state.v };
        })
      )
    );

    expect(reads).toEqual([
      { inScope: true, value: 1 },
      { inScope: true, value: 2 },
      { inScope: true, value: 3 }
    ]);
    expect(hasRequestScope()).toBe(false);
  });

  test('configureRequestScope rejects a missing constructor', () => {
    const { configureRequestScope } = loadBrowserModule();
    // $FlowExpectedError - testing the runtime guard
    expect(() => configureRequestScope({})).toThrow(/AsyncLocalStorage/);
  });
});
