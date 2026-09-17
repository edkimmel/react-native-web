/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The two halves meeting: HTML the emitter produced, parsed and executed by
 * a browser, then read back through the client API that hydration uses.
 *
 * Neither half is hand-written here. The wire format is whatever
 * `takeHydrationStateHTML()` currently emits and the reader is whatever
 * `unstable_hydrationStore.getServerSnapshot()` currently does, so a change
 * to one that the other does not follow fails this file rather than
 * surfacing as a hydration mismatch in an app.
 *
 * The document is the live jsdom one, and the script element is re-created
 * on insert so that it actually executes — `innerHTML` flags parsed scripts
 * "already started". Same technique, same reason, as
 * `StyleSheet/__tests__/streamed-hydration-test.js`.
 *
 * The "server" values are forced with `unstable_setForHydration` rather than
 * declared with `set`, because `set` refuses to run in a browser realm and
 * this whole file lives in one.
 */

const SERVER_WINDOW = { fontScale: 1, height: 800, scale: 2, width: 360 };
const SERVER_SCREEN = { fontScale: 1, height: 900, scale: 2, width: 400 };

function req(path) {
  const mod = require(path);
  return mod.default || mod;
}

function runScript(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  Array.prototype.slice.call(template.content.childNodes).forEach((node) => {
    const script = document.createElement('script');
    script.textContent = node.textContent;
    document.body.appendChild(script);
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  delete window.__RNW_HYDRATION__;
});

describe('hydration state round trip', () => {
  /**
   * Emit a response in one module registry, then throw that registry away —
   * so the client half below boots with no in-memory state at all and can
   * only know what the document tells it. That is exactly the client's
   * situation.
   */
  function emitServerResponse(extra) {
    let html;
    jest.isolateModules(() => {
      req('../../../exports/Dimensions').unstable_setForHydration({
        screen: SERVER_SCREEN,
        window: SERVER_WINDOW
      });
      req('../../../exports/Appearance').unstable_setForHydration({
        colorScheme: 'dark'
      });
      const hydrationState = require('..');
      if (extra != null) {
        hydrationState.registerHydrationState(extra.key, extra.read);
      }
      html = hydrationState.takeHydrationStateHTML();
    });
    return html;
  }

  test('every built-in survives the trip', () => {
    const html = emitServerResponse();
    expect(window.__RNW_HYDRATION__).toBeUndefined();

    runScript(html);
    expect(window.__RNW_HYDRATION__).toBeDefined();

    jest.isolateModules(() => {
      const Dimensions = req('../../../exports/Dimensions');
      const Appearance = req('../../../exports/Appearance');

      expect(Dimensions.unstable_hydrationStore.getServerSnapshot()).toEqual(
        SERVER_WINDOW
      );
      expect(Appearance.unstable_hydrationStore.getServerSnapshot()).toBe(
        'dark'
      );

      // ...and the live values are genuinely different, or the assertions
      // above would pass for the wrong reason.
      expect(Dimensions.unstable_hydrationStore.getSnapshot()).not.toEqual(
        SERVER_WINDOW
      );
      expect(Dimensions.get('window').width).not.toBe(SERVER_WINDOW.width);
    });
  });

  test('the server snapshot survives a restore', () => {
    // The property the whole design rests on: handing control back to the
    // browser must not disturb what a boundary that has not hydrated yet
    // reads. Before this change, restoring was the single most likely
    // cause of a late-boundary mismatch.
    runScript(emitServerResponse());

    jest.isolateModules(() => {
      const Dimensions = req('../../../exports/Dimensions');
      const Appearance = req('../../../exports/Appearance');
      const store = Dimensions.unstable_hydrationStore;

      const before = store.getServerSnapshot();
      expect(before).toEqual(SERVER_WINDOW);

      Dimensions.unstable_restoreFromHydration();
      Appearance.unstable_restoreFromHydration();

      // Same value AND the same object identity — `useSyncExternalStore`
      // calls `getServerSnapshot()` twice on mount and warns if the results
      // differ.
      expect(store.getServerSnapshot()).toBe(before);
      expect(Appearance.unstable_hydrationStore.getServerSnapshot()).toBe(
        'dark'
      );
      // The live value did move, which is what restoring is for.
      expect(store.getSnapshot()).not.toEqual(SERVER_WINDOW);
    });
  });

  test('a consumer key round-trips the same way', () => {
    const html = emitServerResponse({
      key: 'Locale',
      read: () => ({ locale: 'fr-CA' })
    });
    runScript(html);

    jest.isolateModules(() => {
      const store = require('../store');
      expect(store.getServerValue('Locale')).toEqual({ locale: 'fr-CA' });
      expect(Object.isFrozen(store.getServerValue('Locale'))).toBe(true);
    });
  });

  test('with no emitted script, readers fall back to the live values', () => {
    // The no-wiring case: an app that adopts none of this must behave
    // exactly as it did before it existed.
    jest.isolateModules(() => {
      const Dimensions = req('../../../exports/Dimensions');
      const Appearance = req('../../../exports/Appearance');
      const store = Dimensions.unstable_hydrationStore;

      expect(store.getServerSnapshot()).toBe(store.getSnapshot());
      expect(store.getServerSnapshot()).toEqual(Dimensions.get('window'));
      expect(Appearance.unstable_hydrationStore.getServerSnapshot()).toBe(
        Appearance.getColorScheme()
      );
    });
  });

  test('unstable_setForHydration alone is enough, with no script at all', () => {
    // The other supported wiring: an app that plumbs the values across by
    // itself and never calls the emitter.
    jest.isolateModules(() => {
      const Dimensions = req('../../../exports/Dimensions');
      const store = Dimensions.unstable_hydrationStore;
      Dimensions.unstable_setForHydration({
        screen: SERVER_SCREEN,
        window: SERVER_WINDOW
      });

      expect(store.getServerSnapshot()).toEqual(SERVER_WINDOW);
      // Identity, not just equality: the live value and the frozen
      // snapshot are the same object while the override stands, so React
      // has nothing to reconcile after hydration.
      expect(store.getServerSnapshot()).toBe(store.getSnapshot());

      Dimensions.unstable_restoreFromHydration();
      expect(store.getServerSnapshot()).toEqual(SERVER_WINDOW);
      expect(store.getSnapshot()).not.toEqual(SERVER_WINDOW);
    });
  });
});
