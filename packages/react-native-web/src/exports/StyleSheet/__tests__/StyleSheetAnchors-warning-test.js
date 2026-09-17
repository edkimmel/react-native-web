/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `warnIfRuntimeAnchorsSkewHydration` — the one `<head>` shape the library
 * cannot repair from the inside, and therefore the only thing it says out
 * loud from a commit.
 *
 * The shape: RNW's sheet boots when the client bundle evaluates. If the
 * anchors are inside the `<head>` Suspense boundary they have not arrived
 * yet, so the sheet creates `<style data-rnw-runtime>` of its own as
 * `head.firstChild` — a `<style>` React did not render, sitting where React
 * expects its own first `<head>` child. React 18's hydration cannot walk
 * past it and silently falls back to client rendering the whole document;
 * React 19 skips a foreign node whose tag does not match and is unaffected.
 * So the diagnostic is gated on the React major, and the gate is as much of
 * the behaviour as the message is.
 *
 * Two properties this file exists to keep honest, both of which the
 * component's own test file cannot:
 *
 *   1. `warnedRuntimeAnchors` is a module-level once-latch with no reset.
 *      A test that asserts on the warning while sharing a module instance
 *      with a test that merely *trips* it passes or fails on suite order.
 *      Every test here therefore starts from `jest.resetModules()` and
 *      requires React, ReactDOM and the component out of the fresh
 *      registry, so the latch is unlatched at the top of each one and no
 *      other test in the process can reach it.
 *   2. The gate reads `React.version` at call time, so a test can pin it by
 *      redefining the property on the freshly required instance — after
 *      `react-dom` has initialised against the real one.
 */

const RUNTIME_ANCHOR_WARNING = 'element(s) in <head> before the document';

describe('warnIfRuntimeAnchorsSkewHydration', () => {
  let React;
  let StyleSheetAnchors;
  let act;
  let createRoot;
  let consoleError;
  let container;

  beforeEach(() => {
    jest.resetModules();
    jest.useRealTimers();
    global.IS_REACT_ACT_ENVIRONMENT = true;

    // One registry per test: `react` here is the same instance the
    // component and `react-dom` below will resolve to, and the component's
    // `warnedRuntimeAnchors` latch is brand new.
    React = require('react');
    createRoot = require('react-dom/client').createRoot;
    act = require('react-dom/test-utils').act;
    const mod = require('../StyleSheetAnchors');
    StyleSheetAnchors = mod.default || mod;

    // AFTER the requires. Requiring the component pulls in `./index`, which
    // calls `createSheet()` at module scope and puts RNW's own
    // `data-rnw-runtime` anchors in `<head>` — the very nodes this warning
    // is about. Each test plants the `<head>` it means to describe, so the
    // boot's anchors have to go first or every test would warn.
    document.head.innerHTML = '';
    document.body.innerHTML = '';

    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    consoleError.mockRestore();
    global.IS_REACT_ACT_ENVIRONMENT = false;
    jest.useFakeTimers();
  });

  /**
   * Pin the version the gate reads. `React.version` is a plain data property
   * on React's CJS exports, and the gate reads it inside the commit, so this
   * takes effect for the render below without disturbing `react-dom`, which
   * has already initialised against the real value.
   */
  const pinReactVersion = (version) => {
    Object.defineProperty(React, 'version', {
      configurable: true,
      value: version,
      writable: true
    });
  };

  const planAnchor = (group, text, runtime) => {
    const el = document.createElement('style');
    el.setAttribute('data-rnw-group', String(group));
    if (runtime) el.setAttribute('data-rnw-runtime', '');
    el.appendChild(document.createTextNode(text));
    document.head.appendChild(el);
    return el;
  };

  const mount = () => {
    const root = createRoot(container);
    act(() => {
      root.render(React.createElement(StyleSheetAnchors));
    });
    return root;
  };

  const warnings = () =>
    consoleError.mock.calls
      .map((args) => String(args[0]))
      .filter((message) => message.includes(RUNTIME_ANCHOR_WARNING));

  test('warns when RNW created anchors in <head> before the shell arrived', () => {
    // The real shape: the runtime anchor is `head.firstChild`, the server's
    // anchor arrived after it.
    planAnchor(2, '.runtime{padding:1px}', true);
    planAnchor(2, '.server{padding:1px}');

    mount();

    const [message, ...rest] = warnings();
    expect(rest).toEqual([]);
    expect(message).toContain('react-native-web: this library created 1 ');
    // The two arrangements that avoid the window. The warning exists only to
    // name them — there is nothing to fix at runtime.
    expect(message).toContain('<StyleSheet.Anchors /> above the <head>');
    expect(message).toContain('load the client bundle after <head> has');
  });

  test('counts every runtime anchor it found', () => {
    // Not a fixed string: the count is how a reader tells one late boot from
    // a `<head>` that RNW rebuilt wholesale.
    planAnchor(0, '.a{margin:0}', true);
    planAnchor(2, '.b{padding:0}', true);
    planAnchor(3, '.c{border:0}', true);
    planAnchor(0, '.server{margin:0}');

    mount();

    expect(warnings()[0]).toContain('this library created 3 ');
  });

  test('says nothing when every <style> in <head> is one React rendered', () => {
    planAnchor(0, '.a{margin:0}');
    planAnchor(3, '.b{margin-top:1px}');

    mount();

    expect(warnings()).toEqual([]);
  });

  test('says nothing when the runtime anchor is outside <head>', () => {
    // The harm is specific to `<head>`: that is the subtree React is
    // hydrating around the anchors. A runtime anchor in `<body>` is not in
    // the way of anything.
    planAnchor(0, '.a{margin:0}');
    const stray = document.createElement('style');
    stray.setAttribute('data-rnw-group', '9');
    stray.setAttribute('data-rnw-runtime', '');
    document.body.appendChild(stray);

    mount();

    expect(warnings()).toEqual([]);
  });

  test('warns once, however many times the component commits', () => {
    planAnchor(1, '.runtime{padding:1px}', true);
    planAnchor(1, '.server{padding:1px}');

    mount();
    expect(warnings()).toHaveLength(1);
    // A second instance, a remount, a second page-level layout: the DOM
    // shape has not changed and neither has the advice.
    mount();
    expect(warnings()).toHaveLength(1);
  });

  describe('the React-major gate', () => {
    beforeEach(() => {
      planAnchor(2, '.runtime{padding:1px}', true);
      planAnchor(2, '.server{padding:1px}');
    });

    test('warns on React 18, where the DOM is harmful', () => {
      // The version the suite actually runs on, pinned so this test and the
      // ones below differ in exactly one thing.
      pinReactVersion('18.3.1');
      mount();
      expect(warnings()).toHaveLength(1);
    });

    test('is silent on React 19, where the same DOM is benign', () => {
      // 19.0 is where hydration started skipping a foreign node whose tag
      // does not match, so the warning would be pure noise. Measured
      // passing on 19.0.0 by the streaming-ssr-e2e anchors-in-the-boundary
      // spec, which is why the gate is major-granular and not `19.1`.
      pinReactVersion('19.0.0');
      mount();
      expect(warnings()).toEqual([]);
    });

    test('is silent on a React 19 prerelease', () => {
      pinReactVersion('19.0.0-rc.1');
      mount();
      expect(warnings()).toEqual([]);
    });

    test('is silent on an experimental build, which is not React 18', () => {
      // `react@experimental` publishes as `0.0.0-experimental-<sha>-<date>`,
      // so `parseInt(React.version, 10)` is 0. That is why the gate is
      // `major !== 18` and NOT `major < 19`: an experimental build is a
      // *post*-19 build, it skips foreign nodes like 19 does, and `< 19`
      // would fire this warning at every one of them. The apparent
      // "fails open on React 20" improvement is a false positive on the
      // one prerelease channel that exists today.
      pinReactVersion('0.0.0-experimental-019019be-20260911');
      mount();
      expect(warnings()).toEqual([]);
    });

    test('warns on an 18 prerelease, which is React 18', () => {
      pinReactVersion('18.0.0-rc.3');
      mount();
      expect(warnings()).toHaveLength(1);
    });
  });
});
