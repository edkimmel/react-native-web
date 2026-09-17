/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The bug this file exists for.
 *
 * Under streaming SSR every Suspense boundary hydrates on its own schedule:
 * the root hydrates as soon as the shell lands, a boundary hydrates when its
 * chunk arrives — which can be seconds later. A hook that seeds its state
 * from module-level device state at *its own* first render therefore reads
 * whatever that state happens to be at that moment, not what the server
 * rendered the markup with. Anything that moves the value in between — a
 * resize, or the `unstable_restoreFromHydration` an app is *supposed* to call
 * once the root is interactive — makes every not-yet-hydrated boundary
 * mismatch.
 *
 * `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)` is the
 * fix: React calls `getServerSnapshot` for every subtree it hydrates,
 * whenever it hydrates it, so a late boundary re-reads the frozen server
 * value and then reconciles to the live one as an ordinary update.
 *
 * The simulation is the real thing, not an approximation of it:
 *   - `renderToPipeableStream` produces genuinely streamed markup, with the
 *     boundary emitted as React's dehydrated `<!--$?-->` placeholder plus a
 *     later `<div hidden>` + `$RC(...)` chunk.
 *   - Both halves go into the live jsdom document, the late one only after
 *     the root has hydrated, with its inline script re-created so that it
 *     actually runs (`innerHTML` marks parsed scripts already-started).
 *   - The viewport moves in between, through the documented
 *     `unstable_setForHydration` / `unstable_restoreFromHydration` pair.
 *
 * Two environment traps, both of which cost real time to find:
 *
 *   1. React's Node server build schedules its first render pass with
 *      `setImmediate`, which the jsdom test environment does not expose as a
 *      global. Restoring it is what makes `renderToPipeableStream` — and so
 *      a genuinely dehydrated boundary — reachable from a browser-realm test
 *      at all.
 *   2. EVERY module has to come from the same registry. `jest.resetModules()`
 *      gives RNW a clean slate, but a `react` required before that call is a
 *      *different copy* from the one `react-dom` then picks up, with its own
 *      `ReactCurrentDispatcher`. The symptom is not an obvious failure: the
 *      tree renders, and effects silently never run. Hence `require` inside
 *      `beforeEach`, after the reset, for React and the renderers too.
 */

global.setImmediate = global.setImmediate || require('timers').setImmediate;

const { Writable } = require('stream');

// The viewport the "server" rendered with; deliberately nothing like the
// 1024x768 jsdom reports, so a boundary that reads the live value instead of
// the server one cannot accidentally agree.
const SERVER_WINDOW = { fontScale: 1, height: 800, scale: 2, width: 360 };

describe('useWindowDimensions under progressive hydration', () => {
  let Dimensions;
  let React;
  let hydrateRoot;
  let liveWidth;
  let renderToPipeableStream;
  let useWindowDimensions;

  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';

    // What this environment really reports, read from a module instance
    // that is then thrown away — so nothing below hardcodes a jsdom value.
    const probe = require('../../Dimensions');
    liveWidth = (probe.default || probe).get('window').width;

    jest.resetModules();
    React = require('react');
    hydrateRoot = require('react-dom/client').hydrateRoot;
    renderToPipeableStream =
      require('react-dom/server.node').renderToPipeableStream;
    const dimensions = require('../../Dimensions');
    Dimensions = dimensions.default || dimensions;
    const hook = require('..');
    useWindowDimensions = hook.default || hook;
  });

  afterEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = false;
    jest.useFakeTimers();
  });

  /**
   * Stream `element`, pausing at the shell so the caller can hydrate the
   * root before the boundary's chunk exists. Returns the two halves of the
   * response separately, which is precisely the split a real client sees.
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
   * `<script>` elements so React's `$RC` boundary-completion script actually
   * executes. Same trick, and same reason, as
   * `StyleSheet/__tests__/streamed-hydration-test.js`.
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

  test('a boundary that hydrates after the viewport moves does not mismatch', async () => {
    expect(liveWidth).not.toBe(SERVER_WINDOW.width);

    let released = false;
    let releaseLate;
    const latePromise = new Promise((resolve) => {
      releaseLate = resolve;
    });

    function Late() {
      // Suspends on the server until the caller releases it; by the time the
      // client hydrates this boundary it has long since resolved, so the
      // client render is synchronous — exactly like a boundary whose data
      // was streamed in.
      if (!released) {
        throw latePromise;
      }
      const { width } = useWindowDimensions();
      return React.createElement('span', { id: 'late' }, String(width));
    }

    function Early() {
      const { width } = useWindowDimensions();
      return React.createElement('span', { id: 'root' }, String(width));
    }

    // The subscriber and the boundary are siblings, not ancestor and
    // descendant, and that is not incidental. A component that re-renders
    // *above* a still-dehydrated boundary hands React a fresh `<Suspense>`
    // element, which counts as an update to the boundary — React then
    // discards the server HTML and client-renders it ("received an update
    // before it finished hydrating"), which would mask the mismatch this
    // test is looking for behind a different failure. `App` itself never
    // re-renders, so the boundary stays dehydrated until its chunk lands.
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
    // The server knows the viewport (a client hint, a session, a guess); it
    // is forced here rather than declared with `Dimensions.set` because that
    // refuses to run in a browser realm, and this whole test lives in one.
    Dimensions.unstable_setForHydration({
      screen: SERVER_WINDOW,
      window: SERVER_WINDOW
    });

    const { lateHTML, shellHTML } = await streamInTwoHalves(
      React.createElement(App),
      () => {
        released = true;
        releaseLate();
      }
    );

    // The shell really does carry a dehydrated boundary, and both halves
    // really were rendered with the server's viewport.
    expect(shellHTML).toContain('<!--$?-->');
    expect(shellHTML).toContain(`<span id="root">${SERVER_WINDOW.width}<`);
    expect(lateHTML).toContain(`<span id="late">${SERVER_WINDOW.width}<`);

    // ---- client ----------------------------------------------------------
    const container = document.createElement('div');
    container.innerHTML = shellHTML;
    document.body.appendChild(container);

    // React reports hydration mismatches through `console.error` and
    // `onRecoverableError`, and is otherwise silent — the page just
    // re-renders and looks fine. Fail on *any* call and print it, rather
    // than matching a message, so a reworded React warning still trips this.
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

      // The root hydrated against the server's viewport.
      expect(document.getElementById('root').textContent).toBe(
        String(SERVER_WINDOW.width)
      );
      expect(recoverable).toEqual([]);
      expect(consoleErrors).toEqual([]);

      // The app hands control back to the browser now that the root is
      // interactive — the documented sequence, and the moment the old hook
      // broke every boundary that had not hydrated yet.
      await React.act(async () => {
        Dimensions.unstable_restoreFromHydration();
      });
      expect(Dimensions.get('window').width).toBe(liveWidth);
      expect(document.getElementById('root').textContent).toBe(
        String(liveWidth)
      );

      // Only now does the boundary's chunk arrive and hydrate.
      await React.act(async () => {
        appendStreamedHTML(lateHTML);
      });

      expect(document.getElementById('late')).not.toBeNull();
      // No mismatch: the boundary hydrated against the server snapshot...
      expect(recoverable).toEqual([]);
      expect(consoleErrors).toEqual([]);
      // ...and then reconciled to the live viewport like any other update.
      expect(document.getElementById('late').textContent).toBe(
        String(liveWidth)
      );
    } finally {
      spy.mockRestore();
    }
  });
});
