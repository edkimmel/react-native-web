/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Appearance reads `window.matchMedia` once, at import time, so the fake
// query is installed before the modules under test are loaded — hence
// `require` at module scope rather than hoisted `import`s.
const handlers = new Set();
const mediaQueryList = {
  matches: false,
  addListener(handler) {
    handlers.add(handler);
  },
  removeListener(handler) {
    handlers.delete(handler);
  }
};
window.matchMedia = jest.fn(() => mediaQueryList);

function emit(matches) {
  mediaQueryList.matches = matches;
  handlers.forEach((handler) => handler({ matches }));
}

const React = require('react');
const { act, render } = require('@testing-library/react');
const Appearance = require('../../Appearance');
const useColorScheme = require('..');

function ColorScheme() {
  return useColorScheme();
}

beforeEach(() => {
  mediaQueryList.matches = false;
});

describe('hooks/useColorScheme', () => {
  test('returns the current color scheme and tracks changes', () => {
    const { container } = render(<ColorScheme />);
    expect(container.textContent).toBe('light');

    act(() => {
      emit(true);
    });
    expect(container.textContent).toBe('dark');
  });

  test('renders the forced hydration scheme, then the real one on restore', () => {
    // The OS says light; the server rendered the user's saved 'dark'.
    Appearance.unstable_setForHydration({ colorScheme: 'dark' });

    const { container } = render(<ColorScheme />);
    // Matches the server markup, so hydration does not mismatch.
    expect(container.textContent).toBe('dark');

    act(() => {
      Appearance.unstable_restoreFromHydration();
    });
    expect(container.textContent).toBe('light');
  });
});
