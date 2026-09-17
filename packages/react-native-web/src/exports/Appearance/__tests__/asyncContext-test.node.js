/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// In the Node test environment `canUseDOM` is false, so `Appearance.set`
// is permitted (it throws in the browser) and there is no media query to
// fall back to. This is the same call shape the SSR pipeline uses to
// declare the color scheme a request should render with.

let Appearance;
let runInRequestScope;

// `Appearance.set` has no inverse — it declares a scheme, it cannot
// un-declare one — so tests that assert the pristine process default get
// a fresh module registry instead of a reset call.
beforeEach(() => {
  jest.resetModules();
  Appearance = require('..');
  runInRequestScope =
    require('../../../modules/asyncContext').runInRequestScope;
});

describe('apis/Appearance per-request scoping', () => {
  test('defaults to light with no media query and no override', () => {
    expect(Appearance.getColorScheme()).toBe('light');
    runInRequestScope(() => {
      expect(Appearance.getColorScheme()).toBe('light');
    });
  });

  test('set + getColorScheme inside a request scope reads back the per-request value', () => {
    runInRequestScope(() => {
      Appearance.set({ colorScheme: 'dark' });
      expect(Appearance.getColorScheme()).toBe('dark');
    });
  });

  test("concurrent scopes do not see each other's color scheme", async () => {
    const schemes = ['dark', 'light', 'dark', 'light'];
    const reads = await Promise.all(
      schemes.map((colorScheme) =>
        runInRequestScope(async () => {
          Appearance.set({ colorScheme });
          // Yield to the microtask queue so other scopes interleave
          // between Appearance.set and Appearance.getColorScheme.
          await Promise.resolve();
          return Appearance.getColorScheme();
        })
      )
    );
    expect(reads).toEqual(schemes);
  });

  test('writes inside a scope do not leak to the process default', () => {
    runInRequestScope(() => {
      Appearance.set({ colorScheme: 'dark' });
      expect(Appearance.getColorScheme()).toBe('dark');
    });
    expect(Appearance.getColorScheme()).toBe('light');
  });

  test('a scope inherits a scheme set outside any scope', () => {
    // The established pattern: declare a process-wide default once at
    // module scope, then render every request against it.
    Appearance.set({ colorScheme: 'dark' });
    runInRequestScope(() => {
      expect(Appearance.getColorScheme()).toBe('dark');
    });
  });

  test("inheritance is per-scope: one scope's override does not reach another", async () => {
    Appearance.set({ colorScheme: 'dark' });

    const [overridden, inherited] = await Promise.all([
      runInRequestScope(async () => {
        Appearance.set({ colorScheme: 'light' });
        await Promise.resolve();
        return Appearance.getColorScheme();
      }),
      runInRequestScope(async () => {
        await Promise.resolve();
        return Appearance.getColorScheme();
      })
    ]);

    expect(overridden).toBe('light');
    expect(inherited).toBe('dark');
    // The override did not write through to the process default either.
    expect(Appearance.getColorScheme()).toBe('dark');
  });

  test('set(null) and a missing scheme leave the current value alone', () => {
    Appearance.set({ colorScheme: 'dark' });
    Appearance.set(null);
    Appearance.set({});
    expect(Appearance.getColorScheme()).toBe('dark');
  });

  test('unstable_setForHydration is rejected on the server', () => {
    expect(() => {
      Appearance.unstable_setForHydration({ colorScheme: 'dark' });
    }).toThrow('should only be used in the browser');
  });

  test('change listeners still subscribe and unsubscribe without a media query', () => {
    const listener = jest.fn();
    const { remove } = Appearance.addChangeListener(listener);
    expect(listener).not.toHaveBeenCalled();
    remove();
  });
});
