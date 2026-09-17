/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The `useColorScheme` counterpart to
 * `useWindowDimensions/__tests__/progressive-hydration-test.js`, and the only
 * test in the suite that can tell `getServerSnapshot` from `getSnapshot`.
 *
 * Why the everyday test cannot. `render()` from `@testing-library/react` is
 * `createRoot()`, and React never calls `getServerSnapshot` outside
 * hydration — so passing `getSnapshot` as the third argument of
 * `useSyncExternalStore` changes nothing there. It reads the right value
 * only because `unstable_setForHydration` also moves the *live* value, which
 * makes the two snapshots agree.
 *
 * They are pulled apart here the way a real page pulls them apart. The OS
 * says light; the server rendered the user's saved dark. The root hydrates
 * while the override is still on (both snapshots say dark), the app then
 * calls `unstable_restoreFromHydration` — the documented "the root is
 * interactive now" step — and only *afterwards* does the streamed boundary
 * arrive and hydrate. At that moment the live value is light and the frozen
 * server value is dark, so a boundary that reads the live one renders light
 * against markup that says dark, and React reports a hydration mismatch.
 *
 * This is the scheme case rather than the viewport case, and it is sharper:
 * the client *can* answer this question and answers it differently, because
 * `matchMedia('(prefers-color-scheme: dark)')` only ever reports the OS
 * setting while the server may have rendered a saved preference.
 *
 * Two environment traps, both inherited from the Dimensions version:
 *   1. React's Node server build schedules its first render pass with
 *      `setImmediate`, which the jsdom environment does not expose.
 *   2. Every module has to come from one registry — a `react` required
 *      before `jest.resetModules()` is a different copy with its own
 *      dispatcher, and the symptom is effects that silently never run.
 * A third is specific to this file: `Appearance` reads `window.matchMedia`
 * once, at module scope, so the fake query has to be installed *before* the
 * module is required, i.e. inside `beforeEach` after the reset.
 */

global.setImmediate = global.setImmediate || require('timers').setImmediate;

const { Writable } = require('stream');

// The OS preference for the whole file: light. The server renders dark.
const SERVER_SCHEME = 'dark';
const OS_SCHEME = 'light';

describe('useColorScheme under progressive hydration', () => {
  let Appearance;
  let React;
  let hydrateRoot;
  let renderToPipeableStream;
  let useColorScheme;

  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';

    // A media query list that reports the OS preference and nothing else —
    // which is the whole point: it cannot know about the user's saved theme.
    const handlers = new Set();
    window.matchMedia = () => ({
      matches: false,
      addListener(handler) {
        handlers.add(handler);
      },
      removeListener(handler) {
        handlers.delete(handler);
      }
    });

    React = require('react');
    hydrateRoot = require('react-dom/client').hydrateRoot;
    renderToPipeableStream =
      require('react-dom/server.node').renderToPipeableStream;
    const appearance = require('../../Appearance');
    Appearance = appearance.default || appearance;
    const hook = require('..');
    useColorScheme = hook.default || hook;
  });

  afterEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = false;
    jest.useFakeTimers();
  });

  /**
   * Stream `element`, pausing at the shell so the caller can hydrate the
   * root before the boundary's chunk exists — the split a real client sees.
   */
  async function streamInTwoHalves(element, releaseBoundary) {
    const chunks = [];
    const errors = [];
    const destination = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(chunk.toString('utf8'));
        callback();
      }
    });
    const finished = new Promise((resolve) =>
      destination.on('finish', resolve)
    );

    let onShell;
    const shellReady = new Promise((resolve) => {
      onShell = resolve;
    });

    const { pipe } = renderToPipeableStream(element, {
      onShellReady() {
        pipe(destination);
        onShell();
      },
      onError(error) {
        errors.push(error);
      }
    });

    await shellReady;
    // Fizz writes from a scheduled task, so the shell bytes are not on the
    // wire the instant `onShellReady` returns.
    while (chunks.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const shellHTML = chunks.join('');
    chunks.length = 0;

    releaseBoundary();
    await finished;

    expect(errors).toEqual([]);
    return { lateHTML: chunks.join(''), shellHTML };
  }

  /**
   * Append streamed HTML to `<body>` the way the parser would, re-creating
   * `<script>` elements so React's `$RC` boundary-completion script runs.
   */
  function appendStreamedHTML(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    Array.prototype.slice.call(template.content.childNodes).forEach((node) => {
      if (node.nodeName === 'SCRIPT') {
        const script = document.createElement('script');
        script.textContent = node.textContent;
        document.body.appendChild(script);
      } else {
        document.body.appendChild(node);
      }
    });
  }

  test('a boundary that hydrates after the scheme is restored does not mismatch', async () => {
    let released = false;
    let releaseLate;
    const latePromise = new Promise((resolve) => {
      releaseLate = resolve;
    });

    function Late() {
      if (!released) {
        throw latePromise;
      }
      return React.createElement('span', { id: 'late' }, useColorScheme());
    }

    function Early() {
      return React.createElement('span', { id: 'root' }, useColorScheme());
    }

    // Siblings, not ancestor and descendant: a component re-rendering ABOVE
    // a dehydrated boundary hands React a fresh `<Suspense>` element, which
    // makes React throw the server markup away and client-render it —
    // masking the mismatch this test is looking for behind a different
    // failure.
    function App() {
      return React.createElement(
        'div',
        null,
        React.createElement(Early),
        React.createElement(
          React.Suspense,
          { fallback: React.createElement('span', null, 'loading') },
          React.createElement(Late)
        )
      );
    }

    // ---- server ----------------------------------------------------------
    // `Appearance.set` refuses to run in a browser realm and this whole test
    // lives in one, so the request's scheme is declared through the
    // hydration pair instead. Same effect: the render and the frozen
    // snapshot both say dark.
    Appearance.unstable_setForHydration({ colorScheme: SERVER_SCHEME });
    expect(Appearance.getColorScheme()).toBe(SERVER_SCHEME);

    const { lateHTML, shellHTML } = await streamInTwoHalves(
      React.createElement(App),
      () => {
        released = true;
        releaseLate();
      }
    );

    expect(shellHTML).toContain('<!--$?-->');
    expect(shellHTML).toContain(`<span id="root">${SERVER_SCHEME}<`);
    expect(lateHTML).toContain(`<span id="late">${SERVER_SCHEME}<`);

    // ---- client ----------------------------------------------------------
    const container = document.createElement('div');
    container.innerHTML = shellHTML;
    document.body.appendChild(container);

    // React reports hydration mismatches through `console.error` and
    // `onRecoverableError` and is otherwise silent. Fail on *any* call and
    // print it, so a reworded React warning still trips this.
    const consoleErrors = [];
    const recoverable = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      consoleErrors.push(args.join(' '));
    });

    try {
      await React.act(async () => {
        hydrateRoot(container, React.createElement(App), {
          onRecoverableError: (error) => recoverable.push(String(error))
        });
      });

      expect(document.getElementById('root').textContent).toBe(SERVER_SCHEME);
      expect(recoverable).toEqual([]);
      expect(consoleErrors).toEqual([]);

      // The app hands control back to the media query now that the root is
      // interactive. The OS says light, so every mounted subscriber moves —
      // and the frozen server snapshot deliberately does not.
      await React.act(async () => {
        Appearance.unstable_restoreFromHydration();
      });
      expect(Appearance.getColorScheme()).toBe(OS_SCHEME);
      expect(document.getElementById('root').textContent).toBe(OS_SCHEME);

      // Only now does the boundary's chunk arrive and hydrate, against
      // markup that says dark while the live value says light.
      await React.act(async () => {
        appendStreamedHTML(lateHTML);
      });

      expect(document.getElementById('late')).not.toBeNull();
      // No mismatch: the boundary hydrated against the server snapshot...
      expect(recoverable).toEqual([]);
      expect(consoleErrors).toEqual([]);
      // ...and then reconciled to the live scheme like any other update.
      expect(document.getElementById('late').textContent).toBe(OS_SCHEME);
    } finally {
      spy.mockRestore();
    }
  });
});
