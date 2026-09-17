/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The module reads `window.matchMedia` once, at import time, so every
// test installs its fake query first and then re-requires the module.
function mockMatchMedia(matches) {
  const handlers = new Set();
  const mediaQueryList = {
    matches,
    addListener(handler) {
      handlers.add(handler);
    },
    removeListener(handler) {
      handlers.delete(handler);
    }
  };
  window.matchMedia = jest.fn(() => mediaQueryList);
  return {
    countHandlers: () => handlers.size,
    emit(nextMatches) {
      mediaQueryList.matches = nextMatches;
      handlers.forEach((handler) => handler({ matches: nextMatches }));
    }
  };
}

function requireAppearance() {
  jest.resetModules();
  return require('..');
}

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('apis/Appearance', () => {
  test('getColorScheme reads the prefers-color-scheme query', () => {
    mockMatchMedia(false);
    expect(requireAppearance().getColorScheme()).toBe('light');
    mockMatchMedia(true);
    expect(requireAppearance().getColorScheme()).toBe('dark');
  });

  test('getColorScheme falls back to light without matchMedia', () => {
    window.matchMedia = undefined;
    expect(requireAppearance().getColorScheme()).toBe('light');
  });

  test('change listeners are notified and can be removed', () => {
    const query = mockMatchMedia(false);
    const Appearance = requireAppearance();
    const listener = jest.fn();
    const { remove } = Appearance.addChangeListener(listener);

    query.emit(true);
    expect(listener).toHaveBeenCalledWith({ colorScheme: 'dark' });
    expect(Appearance.getColorScheme()).toBe('dark');

    remove();
    expect(query.countHandlers()).toBe(0);
    query.emit(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('one listener subscribed twice is two independent subscriptions', () => {
    // `MediaQueryList` is an `EventTarget`, so a single memoised adapter
    // shared by both subscriptions registers ONE listener — and the first
    // `remove()` then detaches the registration the survivor depends on,
    // silently. Reachable from the public API: `useColorScheme` allocates a
    // fresh arrow per subscribe and never hits it, but a caller who passes
    // a stable module-level function twice does.
    const query = mockMatchMedia(false);
    const Appearance = requireAppearance();
    const listener = jest.fn();

    const a = Appearance.addChangeListener(listener);
    const b = Appearance.addChangeListener(listener);
    expect(query.countHandlers()).toBe(2);

    query.emit(true);
    expect(listener).toHaveBeenCalledTimes(2);

    a.remove();
    expect(query.countHandlers()).toBe(1);
    query.emit(false);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith({ colorScheme: 'light' });

    // Idempotent, rather than eating its sibling's registration.
    a.remove();
    expect(query.countHandlers()).toBe(1);

    b.remove();
    expect(query.countHandlers()).toBe(0);
  });

  test('set is rejected in the browser', () => {
    mockMatchMedia(false);
    expect(() => {
      requireAppearance().set({ colorScheme: 'dark' });
    }).toThrow('cannot be set in the browser');
  });

  test('unstable_setForHydration overrides the media query', () => {
    mockMatchMedia(false);
    const Appearance = requireAppearance();
    Appearance.unstable_setForHydration({ colorScheme: 'dark' });
    expect(Appearance.getColorScheme()).toBe('dark');
  });

  test('media query changes are suppressed while hydration values are forced', () => {
    const query = mockMatchMedia(false);
    const Appearance = requireAppearance();
    const listener = jest.fn();
    Appearance.addChangeListener(listener);

    Appearance.unstable_setForHydration({ colorScheme: 'dark' });
    query.emit(true);
    expect(listener).not.toHaveBeenCalled();
    expect(Appearance.getColorScheme()).toBe('dark');
  });

  test('unstable_restoreFromHydration hands control back and notifies on a mismatch', () => {
    // The interesting case: the server rendered the user's saved 'dark'
    // preference, the OS says light.
    const query = mockMatchMedia(false);
    const Appearance = requireAppearance();
    const listener = jest.fn();
    Appearance.addChangeListener(listener);

    Appearance.unstable_setForHydration({ colorScheme: 'dark' });
    Appearance.unstable_restoreFromHydration();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ colorScheme: 'light' });
    expect(Appearance.getColorScheme()).toBe('light');
    // The live query is the source of truth again.
    query.emit(true);
    expect(Appearance.getColorScheme()).toBe('dark');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('unstable_restoreFromHydration is silent when the query agrees', () => {
    mockMatchMedia(true);
    const Appearance = requireAppearance();
    const listener = jest.fn();
    Appearance.addChangeListener(listener);

    Appearance.unstable_setForHydration({ colorScheme: 'dark' });
    Appearance.unstable_restoreFromHydration();

    expect(listener).not.toHaveBeenCalled();
    expect(Appearance.getColorScheme()).toBe('dark');
  });

  test('unstable_restoreFromHydration is a no-op without a forced value', () => {
    mockMatchMedia(true);
    const Appearance = requireAppearance();
    const listener = jest.fn();
    Appearance.addChangeListener(listener);

    Appearance.unstable_restoreFromHydration();

    expect(listener).not.toHaveBeenCalled();
    expect(Appearance.getColorScheme()).toBe('dark');
  });
});
