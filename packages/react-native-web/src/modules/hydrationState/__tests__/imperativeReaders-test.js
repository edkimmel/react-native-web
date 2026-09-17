/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The emitted script covers the hooks, and deliberately nothing else.
 *
 * `getServerValue` is consulted from exactly one place per device module —
 * its `getServerSnapshot` — so `window.__RNW_HYDRATION__` landing in the
 * document does NOT redirect `Dimensions.get()` or
 * `Appearance.getColorScheme()`. Those keep returning the live client
 * value.
 *
 * That asymmetry is the design, not an oversight. Leaving the live value
 * alone is what lets React reconcile to it in a passive effect after
 * hydration, which is what retired the whole "when is it safe to restore?"
 * problem. Forcing the live value from the wire would reinstate it.
 *
 * The consequence a consumer has to know: a component reading
 * `Dimensions.get('window').width` directly in render, rather than through
 * `useWindowDimensions`, is not covered by the emitter alone and still
 * wants `unstable_setForHydration`. This file pins both halves of that, so
 * "fixing" the asymmetry breaks a test that explains why it exists.
 */

const SERVER_WINDOW = { fontScale: 1, height: 800, scale: 2, width: 360 };
const SERVER_SCREEN = { fontScale: 1, height: 900, scale: 2, width: 400 };

function req(path) {
  const mod = require(path);
  return mod.default || mod;
}

function emitServerPayload() {
  // Written the way the server would: the global only, with no client API
  // call, so nothing but the wire has spoken.
  window.__RNW_HYDRATION__ = {
    Appearance: { colorScheme: 'dark' },
    Dimensions: { screen: SERVER_SCREEN, window: SERVER_WINDOW }
  };
}

afterEach(() => {
  delete window.__RNW_HYDRATION__;
});

describe('the emitted snapshot and imperative readers', () => {
  test('the wire alone feeds getServerSnapshot but not Dimensions.get', () => {
    jest.resetModules();
    emitServerPayload();
    const Dimensions = req('../../../exports/Dimensions');

    expect(Dimensions.unstable_hydrationStore.getServerSnapshot()).toEqual(
      SERVER_WINDOW
    );
    // The live reader is untouched: still the real viewport.
    expect(Dimensions.get('window')).not.toEqual(SERVER_WINDOW);
    expect(Dimensions.get('window').width).toBe(
      document.documentElement.clientWidth
    );
  });

  test('the wire alone feeds getServerSnapshot but not getColorScheme', () => {
    jest.resetModules();
    emitServerPayload();
    const Appearance = req('../../../exports/Appearance');

    expect(Appearance.unstable_hydrationStore.getServerSnapshot()).toBe('dark');
    // jsdom reports no `prefers-color-scheme: dark` match, so the live
    // value is 'light' and disagrees with the wire on purpose.
    expect(Appearance.getColorScheme()).toBe('light');
  });

  test('unstable_setForHydration is what also moves the imperative readers', () => {
    jest.resetModules();
    const Dimensions = req('../../../exports/Dimensions');
    const Appearance = req('../../../exports/Appearance');

    Dimensions.unstable_setForHydration({
      screen: SERVER_SCREEN,
      window: SERVER_WINDOW
    });
    Appearance.unstable_setForHydration({ colorScheme: 'dark' });

    expect(Dimensions.get('window')).toEqual(SERVER_WINDOW);
    expect(Appearance.getColorScheme()).toBe('dark');
    expect(Dimensions.unstable_hydrationStore.getServerSnapshot()).toEqual(
      SERVER_WINDOW
    );
    expect(Appearance.unstable_hydrationStore.getServerSnapshot()).toBe('dark');
  });
});
