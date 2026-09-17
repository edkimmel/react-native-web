/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The everyday behavior of the hook, on the client.
 *
 * `progressive-hydration-test.js` covers the streaming case this was
 * rewritten for; this file covers the parts that must not have regressed in
 * the move from `useState` + `useEffect` to `useSyncExternalStore` — in
 * particular that a change still reaches mounted subscribers, which is now
 * what drives the post-restore update.
 *
 * Rendering goes through `react-dom/client` directly rather than
 * `@testing-library/react`, for a mundane reason with a confusing symptom.
 * `Dimensions` keeps module state that one test forces and another must not
 * inherit, so every test needs a fresh registry — and a `react` required
 * *before* `jest.resetModules()` is a different copy from the one the
 * renderer then picks up, with its own dispatcher ("Cannot read properties
 * of null (reading 'useSyncExternalStore')"). So React has to be required
 * after the reset, inside `beforeEach`, and the testing library cannot be:
 * it registers its own `afterEach`/`afterAll` at import time, which Jest
 * refuses once a test has started.
 */

let Dimensions;
let React;
let notifications;
let createRoot;
let real;
let useWindowDimensions;

const FORCED = { fontScale: 1, height: 800, scale: 2, width: 360 };

function WindowWidth() {
  return String(useWindowDimensions().width);
}

describe('hooks/useWindowDimensions', () => {
  beforeEach(() => {
    jest.resetModules();
    // What this environment really reports, from a module instance that was
    // never forced — so nothing below hardcodes a jsdom value.
    const probe = require('../../Dimensions');
    real = { ...(probe.default || probe).get('window') };

    jest.resetModules();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    React = require('react');
    createRoot = require('react-dom/client').createRoot;
    const dimensions = require('../../Dimensions');
    Dimensions = dimensions.default || dimensions;

    // Count the notifications the store actually delivers. Wrapped here, in
    // between the two requires, because the hook destructures `subscribe`
    // at its own module scope — replacing it afterwards would change
    // nothing. Wrapping, not replacing: the real `subscribe` runs and the
    // real unsubscribe it returns is what React is handed, so a leak in
    // either is a leak here.
    notifications = 0;
    const store = Dimensions.unstable_hydrationStore;
    const realSubscribe = store.subscribe;
    store.subscribe = (callback) =>
      realSubscribe(() => {
        notifications += 1;
        callback();
      });

    const hook = require('..');
    useWindowDimensions = hook.default || hook;
  });

  // Every root has to be torn down before the next test, and not just for
  // tidiness: `Dimensions` attaches its `resize` listener to `window` at
  // module scope, so each test's registry leaves one behind permanently. A
  // root left mounted from an earlier test therefore still receives resize
  // notifications through its own copy of React — whose act queue is not
  // the current one — and reports "an update was not wrapped in act(...)"
  // against whichever test dispatched the event.
  const mounted = [];

  afterEach(() => {
    const teardown = React.act;
    mounted.splice(0).forEach((root) => {
      teardown(() => {
        root.unmount();
      });
    });
    global.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = '';
    delete window.visualViewport;
  });

  function render(element) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push(root);
    React.act(() => {
      root.render(element);
    });
    return {
      container,
      unmount() {
        React.act(() => {
          root.unmount();
        });
        mounted.splice(mounted.indexOf(root), 1);
      }
    };
  }

  const act = (fn) => React.act(fn);

  test('returns the current viewport', () => {
    const { container } = render(<WindowWidth />);
    expect(container.textContent).toBe(String(real.width));
  });

  // jsdom's `documentElement.clientWidth` is a non-configurable accessor, so
  // the viewport is moved through the `visualViewport` branch `update()`
  // prefers anyway. `afterEach` deletes the property again, which is why
  // every test that needs a resize to *change* something has to install it.
  function resizeTo(width) {
    window.visualViewport = { height: real.height, scale: 1, width };
    window.dispatchEvent(new window.Event('resize'));
  }

  test('tracks resizes', () => {
    const { container } = render(<WindowWidth />);
    const resized = real.width + 137;
    act(() => {
      resizeTo(resized);
    });
    expect(container.textContent).toBe(String(resized));
  });

  test('renders the forced hydration value, then the live one on restore', () => {
    // The regression this hook's rewrite must not lose: after the app hands
    // control back to the browser, mounted subscribers have to move to the
    // live viewport. Nothing else will tell them — the resize that prompted
    // the restore has typically already been swallowed by the override.
    Dimensions.unstable_setForHydration({ screen: FORCED, window: FORCED });

    const { container } = render(<WindowWidth />);
    expect(container.textContent).toBe(String(FORCED.width));

    act(() => {
      Dimensions.unstable_restoreFromHydration();
    });
    expect(container.textContent).toBe(String(real.width));
  });

  test('unsubscribes on unmount', () => {
    // What this has to observe is the SUBSCRIPTION, not a symptom of one.
    // Asserting "React logged no warning" cannot fail: React 18 emits no
    // update-on-unmounted-component warning at all, and a leaked
    // `useSyncExternalStore` subscription on an unmounted fiber is bailed
    // out of silently. `notifications` counts what the store really
    // delivered (see `beforeEach`), which a leaked subscription cannot hide.
    const { container, unmount } = render(<WindowWidth />);

    // Positive control: while mounted, a resize really does reach the
    // subscriber. Without it the assertion below would also pass for a
    // subscription that was never established.
    act(() => {
      resizeTo(real.width + 137);
    });
    expect(notifications).toBe(1);
    expect(container.textContent).toBe(String(real.width + 137));

    unmount();

    act(() => {
      resizeTo(real.width + 274);
    });
    expect(notifications).toBe(1);
  });
});
