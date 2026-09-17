/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `unstable_restoreFromHydration` hands control of the viewport back to the
 * browser after hydration has committed. The subtle part is the
 * notification: `handleResize` is the only other notifier, and the resize
 * that prompts an app to restore has usually already been handled with
 * `setForHydration` still set — so `update()` returned early and that event
 * was consumed for nothing. If restoring stayed silent, every
 * `useWindowDimensions` consumer would hold the server's forced size until
 * some later resize happened to arrive.
 */

describe('Dimensions hydration override', () => {
  const forced = {
    window: { fontScale: 1, height: 800, scale: 1, width: 360 },
    screen: { fontScale: 1, height: 800, scale: 1, width: 360 }
  };

  let Dimensions;
  // What this environment really reports, read from a module instance that
  // was never forced — so the expectations never hardcode a jsdom value.
  let real;

  beforeEach(() => {
    jest.resetModules();
    const fresh = require('..');
    real = { ...(fresh.default || fresh).get('window') };
    jest.resetModules();
    const mod = require('..');
    Dimensions = mod.default || mod;
  });

  test('the real viewport differs from the forced one, or this suite proves nothing', () => {
    expect(real.width).not.toBe(forced.window.width);
  });

  test('forced values win over the real viewport', () => {
    Dimensions.unstable_setForHydration(forced);
    expect(Dimensions.get('window').width).toBe(360);
    expect(Dimensions.get('window').height).toBe(800);
  });

  test('a resize does not overwrite forced values', () => {
    Dimensions.unstable_setForHydration(forced);
    window.dispatchEvent(new window.Event('resize'));
    expect(Dimensions.get('window').width).toBe(360);
  });

  test('restoring reads the real viewport back', () => {
    Dimensions.unstable_setForHydration(forced);
    Dimensions.unstable_restoreFromHydration();
    expect(Dimensions.get('window')).toEqual(real);
  });

  // The regression this file exists for.
  test('restoring notifies change subscribers', () => {
    const handler = jest.fn();
    Dimensions.unstable_setForHydration(forced);
    Dimensions.addEventListener('change', handler);

    // The realistic sequence: the app restores from its own resize
    // listener, and RNW's handler has already run for that same event as a
    // no-op because the override was still in force.
    window.dispatchEvent(new window.Event('resize'));
    handler.mockClear();

    Dimensions.unstable_restoreFromHydration();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].window).toEqual(real);
  });

  test('restoring is silent when nothing actually changed', () => {
    const handler = jest.fn();
    Dimensions.get('window');
    Dimensions.addEventListener('change', handler);
    // Never forced, so update() reads back the values it already holds.
    Dimensions.unstable_restoreFromHydration();
    expect(handler).not.toHaveBeenCalled();
  });
});
