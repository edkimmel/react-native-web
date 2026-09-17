/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Two pre-existing defects in the `reduceMotionChanged` subscription, and
 * the behavior around them. Nothing here is about SSR: this module holds no
 * per-request state and nothing renders from it.
 *
 * The module reads `window.matchMedia` once, at import time, so every test
 * installs its fake query first and then re-requires the module. Mirrors
 * `Appearance/__tests__/index-test.js`.
 */
function mockMatchMedia(matches) {
  const handlers = new Set();
  const mediaQueryList = {
    matches,
    addEventListener(type, handler) {
      handlers.add(handler);
    },
    removeEventListener(type, handler) {
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

function requireAccessibilityInfo() {
  jest.resetModules();
  return require('..');
}

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('apis/AccessibilityInfo', () => {
  test('reads the prefers-reduced-motion query', async () => {
    mockMatchMedia(true);
    await expect(
      requireAccessibilityInfo().isReduceMotionEnabled()
    ).resolves.toBe(true);
    mockMatchMedia(false);
    await expect(
      requireAccessibilityInfo().isReduceMotionEnabled()
    ).resolves.toBe(false);
  });

  test('change listeners are notified and can be removed', () => {
    const query = mockMatchMedia(false);
    const AccessibilityInfo = requireAccessibilityInfo();
    const listener = jest.fn();
    const { remove } = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      listener
    );

    query.emit(true);
    expect(listener).toHaveBeenCalledWith(true);

    remove();
    expect(query.countHandlers()).toBe(0);
    query.emit(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('two listeners with identical source text are independent', () => {
    // The registry this replaced was a plain object keyed by the listener
    // function, and object keys are strings — so two listeners that
    // stringified the same shared one entry, and unsubscribing either
    // detached the other.
    const query = mockMatchMedia(false);
    const AccessibilityInfo = requireAccessibilityInfo();
    const calls = [];
    const first = (value) => calls.push(['first', value]);
    const second = (value) => calls.push(['second', value]);

    const a = AccessibilityInfo.addEventListener('reduceMotionChanged', first);
    AccessibilityInfo.addEventListener('reduceMotionChanged', second);
    a.remove();
    query.emit(true);

    expect(calls).toEqual([['second', true]]);
  });

  test('one handler subscribed twice is two independent subscriptions', () => {
    // The regression a memoised adapter reintroduces. `EventTarget` dedups
    // by `(type, listener, capture)`, so handing the media query ONE
    // adapter for both subscriptions registers one DOM listener — and then
    // the first `remove()` detaches the listener the survivor is relying
    // on, while the survivor goes on believing it is subscribed. Upstream
    // built a fresh closure per call and did not have this; the fix must
    // not reintroduce it.
    const query = mockMatchMedia(false);
    const AccessibilityInfo = requireAccessibilityInfo();
    const handler = jest.fn();

    const a = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      handler
    );
    const b = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      handler
    );
    // Two subscriptions, two DOM listeners.
    expect(query.countHandlers()).toBe(2);

    query.emit(true);
    expect(handler).toHaveBeenCalledTimes(2);

    a.remove();
    // A's registration is gone; B's is not.
    expect(query.countHandlers()).toBe(1);
    query.emit(false);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenLastCalledWith(false);

    // And `remove()` is idempotent rather than eating its sibling.
    a.remove();
    expect(query.countHandlers()).toBe(1);

    b.remove();
    expect(query.countHandlers()).toBe(0);
  });

  test('removeEventListener detaches one registration, not all of them', () => {
    // The RN-shaped spelling has only the handler to go on, so it cannot
    // say WHICH subscription it means. One per call is the only answer that
    // keeps the count right.
    const query = mockMatchMedia(false);
    const AccessibilityInfo = requireAccessibilityInfo();
    const handler = jest.fn();

    AccessibilityInfo.addEventListener('reduceMotionChanged', handler);
    AccessibilityInfo.addEventListener('reduceMotionChanged', handler);

    AccessibilityInfo.removeEventListener('reduceMotionChanged', handler);
    expect(query.countHandlers()).toBe(1);
    AccessibilityInfo.removeEventListener('reduceMotionChanged', handler);
    expect(query.countHandlers()).toBe(0);
    // An extra removal for a handler with nothing left is inert.
    expect(() =>
      AccessibilityInfo.removeEventListener('reduceMotionChanged', handler)
    ).not.toThrow();
  });

  test('a subscription whose registration was already taken does not eat a sibling', () => {
    // `removeEventListener` can only mean "one of them", so it takes the
    // most recent — B's. B's own `remove()` must then find nothing and stop,
    // not fall back to "the last one" and cancel A.
    const query = mockMatchMedia(false);
    const AccessibilityInfo = requireAccessibilityInfo();
    const handler = jest.fn();

    AccessibilityInfo.addEventListener('reduceMotionChanged', handler);
    const b = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      handler
    );

    AccessibilityInfo.removeEventListener('reduceMotionChanged', handler);
    expect(query.countHandlers()).toBe(1);
    b.remove();
    expect(query.countHandlers()).toBe(1);

    query.emit(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('subscribing without a media query still returns a subscription', () => {
    // Every server render reaches this path, and any browser without
    // `matchMedia`. `addEventListener` used to return `undefined` here, so
    // the documented `const { remove } = ...` threw on destructuring.
    window.matchMedia = undefined;
    const AccessibilityInfo = requireAccessibilityInfo();
    const listener = jest.fn();

    const { remove } = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      listener
    );
    expect(listener).not.toHaveBeenCalled();
    expect(() => remove()).not.toThrow();
  });

  test('an unknown event name is inert but still unsubscribable', () => {
    mockMatchMedia(false);
    const AccessibilityInfo = requireAccessibilityInfo();
    const { remove } = AccessibilityInfo.addEventListener('nope', jest.fn());
    expect(() => remove()).not.toThrow();
  });
});
