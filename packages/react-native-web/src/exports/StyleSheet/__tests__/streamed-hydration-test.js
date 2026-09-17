/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The *client* half of streaming CSS: RNW booting against a document that a
 * real streamed response produced.
 *
 * `streaming-test.node.js` covers the wire format. What it cannot cover is
 * what happens when RNW's own runtime then starts up inside that document —
 * `createSheet` sniffing the mode, hydrating its selector/group bookkeeping
 * out of the anchors' live `cssRules` (which is where a chunk that arrived
 * before boot put its rules), and installing the ingest hook for the chunks
 * that arrive after. Every one of those exists for a single reason: a runtime
 * `StyleSheet.create` for a class the server already sent must dedup rather
 * than insert a second copy. A regression there is invisible — the page
 * still looks right — until the sheet doubles in size on a long-lived
 * client, or a duplicate lands in a group that inverts the cascade.
 *
 * How the document under test is built (and why it is built this way):
 *
 *  1. The HTML is produced by the real server path — `takeShellHTML()` plus
 *     one `takeDeltaHTML()` per chunk, inside `runInRequestScope`. Nothing
 *     here hand-writes a `<style>`, so the tests break if the emitted format
 *     drifts.
 *  2. That HTML is parsed by jsdom with `runScripts: 'dangerously'` so each
 *     chunk's inline script actually executes, exactly as a browser does at
 *     parse time. The ambient Jest environment *is* such a
 *     jsdom (`jest-environment-jsdom` constructs it with
 *     `runScripts: 'dangerously'`), and it has to be the one used: RNW,
 *     React and the DOM must all share a realm, since `createSheet` reaches
 *     for the global `document` and `installDeltaIngest` for the global
 *     `window`. So chunks are appended to the live document and their
 *     `<script>` elements re-created on insert — `innerHTML` flags parsed
 *     scripts "already started", so only a freshly created element runs.
 *     Appending chunk by chunk is also closer to a stream than a single
 *     parse of the whole page would be.
 *  3. RNW boots afterwards, in a fresh module registry, so
 *     `StyleSheet/index.js`'s module-level `createSheet()` runs against the
 *     finished streamed document. `dom/index.js` keeps process-wide state
 *     (`sheets`, `roots`, the cached mode), so every case must use
 *     `jest.isolateModules` or it inherits the previous one's boot.
 *
 * TRAP (see the same warning in `streaming-test.node.js`): a chunk adds its
 * rules with `CSSStyleSheet.insertRule`, which never writes back to the
 * element's text, so serializing the document loses the entire delta. Every
 * cascade assertion below goes through `computedFromSerialization`, which
 * rebuilds each `<style>` from its live `cssRules` before re-parsing.
 */

// jsdom's URL parser reads TextEncoder/TextDecoder at module load, and the
// jsdom *test environment* does not expose them as globals. Requiring the
// jsdom package from inside a jsdom test throws without this shim, so it has
// to come first — which is also why this file uses `require` throughout:
// Babel hoists `import` above every `require`, defeating the ordering.
const { TextDecoder, TextEncoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

const { JSDOM } = require('jsdom');

// Distinct values per case. Each case renders in its own module registry, so
// the sheets do not actually share state, but a collision would make a
// "server already sent this" assertion pass for the wrong reason.
let nextPx = 100;
const uniq = () => nextPx++;

// ---------------------------------------------------------------------------
// Document plumbing
// ---------------------------------------------------------------------------

function resetDocument() {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete window.__RNW_DELTA__;
  delete window.__RNW_INGEST_DELTA__;
  // Each chunk's script skips itself if its sequence number is already in
  // this set. The counter is per request scope, and every case here opens
  // a fresh module registry, so without clearing it case 2's first chunk
  // would collide with case 1's and be silently dropped. A real page has
  // one document per request and cannot collide.
  delete window.__RNW_DELTA_SEEN__;
}

beforeEach(resetDocument);
afterEach(resetDocument);

/**
 * Run `build` on the server side of the fork: a fresh module registry (so
 * the sheet starts empty) inside a request scope (so the delta channel is
 * live). Returns whatever `build` returns.
 *
 * The server-side `createSheet` in this registry boots against the ambient
 * document too — `canUseDOM` is true under jsdom — and leaves its own group
 * anchors behind. Those are wiped afterwards: the client must boot against
 * the streamed document and nothing else.
 */
function renderOnServer(build) {
  let result;
  jest.isolateModules(() => {
    const StyleSheet = require('..');
    const { runInRequestScope } = require('../../../modules/asyncContext');
    result = runInRequestScope(() => build(StyleSheet));
  });
  resetDocument();
  return result;
}

/**
 * Append one streamed chunk to `<body>`, running its inline script the way
 * the parser would.
 *
 * `innerHTML` sets the "already started" flag on any `<script>` it parses,
 * so those never execute. Re-creating each script element as it is inserted
 * is what makes the chunk actually apply. The script deletes itself once it
 * has run, so nothing of the chunk survives in the DOM — which is the
 * property `hydrateRoot(document, …)` depends on.
 */
function streamChunk(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const nodes = Array.prototype.slice.call(template.content.childNodes);
  nodes.forEach((node) => {
    if (node.nodeName === 'SCRIPT') {
      const script = document.createElement('script');
      script.textContent = node.textContent;
      document.body.appendChild(script);
    } else {
      document.body.appendChild(node);
    }
  });
}

const totalRuleCount = () =>
  Array.prototype.slice
    .call(document.querySelectorAll('style'))
    .reduce(
      (n, el) => n + (el.sheet != null ? el.sheet.cssRules.length : 0),
      0
    );

const headGroups = () =>
  Array.prototype.slice
    .call(document.head.querySelectorAll('style[data-rnw-group]'))
    .map(
      (el) =>
        el.getAttribute('data-rnw-group') +
        (el.hasAttribute('data-rnw-delta') ? ':delta' : '')
    );

/**
 * Ground truth for the cascade: re-parse the live document in a virgin
 * jsdom, because jsdom's computed-style cache is not invalidated by the
 * script-driven `<style>` moves this whole design is built on.
 *
 * The markup alone is not enough to re-parse from. Runtime rules are added
 * through `CSSStyleSheet.insertRule`, which never writes back to the
 * element's text, so `outerHTML` shows a streamed `<style>` exactly as the
 * server sent it and silently omits everything RNW inserted after boot.
 * Each element's text is therefore rebuilt from its live `cssRules` — the
 * same content, in the same DOM position, which is all the cascade is.
 */
function computedFromSerialization(elementId, property) {
  const clone = document.documentElement.cloneNode(true);
  const live = document.querySelectorAll('style');
  const copies = clone.querySelectorAll('style');
  for (let i = 0; i < live.length; i++) {
    const cssSheet = live[i].sheet;
    if (cssSheet == null) continue;
    copies[i].textContent = Array.prototype.slice
      .call(cssSheet.cssRules)
      .map((rule) => rule.cssText)
      .join('\n');
  }
  const reparsed = new JSDOM('<!doctype html>' + clone.outerHTML);
  return reparsed.window.getComputedStyle(
    reparsed.window.document.getElementById(elementId)
  )[property];
}

// ---------------------------------------------------------------------------

describe('client boot against a streamed document', () => {
  test('a runtime create for an already-streamed class inserts nothing', () => {
    const shellPx = uniq();
    const chunkPx = uniq();

    // Two rules the server sends: one in the shell, one in a later chunk.
    // They exercise different client code paths — the shell class is
    // hydrated from the group anchor's parsed text, the chunk class from
    // the rules its script inserted into that same anchor's CSSOM — and
    // both must end up in the same dedup map.
    const { chunkClass, chunkHTML, shellClass, shellHTML } = renderOnServer(
      (StyleSheet) => {
        const shell = StyleSheet.create({ s: { marginTop: shellPx } });
        const [shellClass] = StyleSheet([shell.s]);
        const shellHTML = StyleSheet.takeShellHTML();

        const chunk = StyleSheet.create({ c: { margin: chunkPx } });
        const [chunkClass] = StyleSheet([chunk.c]);
        return {
          chunkClass,
          chunkHTML: StyleSheet.takeDeltaHTML(),
          shellClass,
          shellHTML
        };
      }
    );

    document.head.innerHTML = shellHTML;
    document.body.innerHTML = `<div id="probe" class="${shellClass} ${chunkClass}"></div>`;
    streamChunk(chunkHTML);

    const beforeBoot = totalRuleCount();

    jest.isolateModules(() => {
      const StyleSheet = require('..');

      // Booting alone must not add anything. `createSheet` re-inserts its
      // `initialRules` on every boot; they are already in the group-0 anchor
      // the server dumped, so they have to dedup against it.
      expect(totalRuleCount()).toBe(beforeBoot);

      // Now the case this whole mechanism exists for. `create` only
      // registers the style; `StyleSheet([...])` is what compiles and
      // inserts, so both calls are needed to reach the sheet.
      const again = StyleSheet.create({
        c: { margin: chunkPx },
        s: { marginTop: shellPx }
      });
      const [classes] = StyleSheet([again.s, again.c]);

      // Same input, same atomic classes — the client resolved to exactly
      // what the server streamed.
      expect(classes.split(' ').sort()).toEqual(
        [shellClass, chunkClass].sort()
      );
      // ...and not one new rule anywhere in the document.
      expect(totalRuleCount()).toBe(beforeBoot);
    });
  });

  test('a longhand streamed before the shorthand it overrides still wins', () => {
    const topPx = uniq();
    const allPx = uniq();

    // `marginTop` is group 3, `margin` is group 2, and the shorthand is
    // discovered a chunk *later* than the longhand. Source order in the
    // response is therefore the wrong order; only the per-group anchors,
    // and the chunk writing its rules into the right one, make the
    // longhand win.
    const { chunkClass, chunkHTML, shellClass, shellHTML } = renderOnServer(
      (StyleSheet) => {
        const shell = StyleSheet.create({ s: { marginTop: topPx } });
        const [shellClass] = StyleSheet([shell.s]);
        const shellHTML = StyleSheet.takeShellHTML();

        const chunk = StyleSheet.create({ c: { margin: allPx } });
        const [chunkClass] = StyleSheet([chunk.c]);
        return {
          chunkClass,
          chunkHTML: StyleSheet.takeDeltaHTML(),
          shellClass,
          shellHTML
        };
      }
    );

    document.head.innerHTML = shellHTML;
    document.body.innerHTML =
      `<div id="probe" class="${shellClass} ${chunkClass}"></div>` +
      `<div id="runtime" class="${shellClass}"></div>`;
    streamChunk(chunkHTML);

    jest.isolateModules(() => {
      const StyleSheet = require('..');

      // Booting must not disturb the streamed head: no re-ordering, no
      // second anchor for a group that already has one, nothing left in
      // body. The chunk contributed no element at all — its rules live in
      // group 2's anchor.
      expect(headGroups()).toEqual(['0', '1', '2', '2.1', '2.2', '3']);
      expect(document.body.querySelectorAll('style').length).toBe(0);

      expect(computedFromSerialization('probe', 'marginTop')).toBe(
        `${topPx}px`
      );
      // The shorthand still applies where the longhand does not override it,
      // which is what makes the assertion above about order and not about
      // the shorthand having been dropped.
      expect(computedFromSerialization('probe', 'marginBottom')).toBe(
        `${allPx}px`
      );

      // The other direction, and the one only the client can get wrong: a
      // shorthand compiled at *runtime* must still lose to a longhand the
      // server streamed. That only holds if the runtime rule is written into
      // group 2's existing anchor — which sits before group 3's — rather
      // than appended wherever is convenient. Appending to the end of
      // <head> is the obvious implementation and is silently wrong.
      const runtimePx = uniq();
      const runtime = StyleSheet.create({ r: { margin: runtimePx } });
      const [runtimeClass] = StyleSheet([runtime.r]);
      const target = document.getElementById('runtime');
      target.className = `${target.className} ${runtimeClass}`;

      expect(computedFromSerialization('runtime', 'marginTop')).toBe(
        `${topPx}px`
      );
      expect(computedFromSerialization('runtime', 'marginBottom')).toBe(
        `${runtimePx}px`
      );
    });
  });

  test('hydrating the streamed markup produces no React warnings', () => {
    const shellPx = uniq();
    const chunkPx = uniq();

    // The tree is rendered on the server *inside* the request scope, so the
    // classes React emits are exactly the ones the shell and the chunk
    // carry. Two components split across the shell/chunk boundary mirrors a
    // suspense boundary resolving late.
    const { chunkHTML, markup, shellHTML } = renderOnServer((StyleSheet) => {
      const React = require('react');
      const ReactDOMServer = require('react-dom/server');
      const View = require('../../View');

      // `View` calls `useLayoutEffect`, which React unconditionally warns
      // about on the server. That is upstream behaviour and pure noise here,
      // and it would drown the output of the assertion this test is really
      // about, so the server render runs behind a silenced console.
      const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const shellStyles = StyleSheet.create({ s: { marginTop: shellPx } });
        const shellElement = React.createElement(View, {
          style: shellStyles.s,
          testID: 'shell'
        });
        // Flush the shell before the late subtree compiles anything, so the
        // second component's rules can only reach the client via the delta.
        ReactDOMServer.renderToString(shellElement);
        const shellHTML = StyleSheet.takeShellHTML();

        const chunkStyles = StyleSheet.create({ c: { margin: chunkPx } });
        const tree = React.createElement(
          View,
          { style: shellStyles.s, testID: 'shell' },
          React.createElement(View, { style: chunkStyles.c, testID: 'chunk' })
        );
        const markup = ReactDOMServer.renderToString(tree);
        return { chunkHTML: StyleSheet.takeDeltaHTML(), markup, shellHTML };
      } finally {
        quiet.mockRestore();
      }
    });

    document.head.innerHTML = shellHTML;
    document.body.innerHTML = `<div id="root">${markup}</div>`;
    streamChunk(chunkHTML);

    // React reports hydration mismatches through console.error, and a
    // mismatch is silent otherwise — the client just re-renders and the
    // markup looks fine. Fail on *any* call and print it, rather than
    // matching a message, so a reworded React warning still trips this.
    const calls = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => {
      calls.push(args.join(' '));
    });
    // Recoverable errors (hydration among them) do not always reach
    // console.error in production builds of React; capture them too.
    const recovered = [];

    // React 18 schedules hydration; `act` drains it. The jsdom Jest config
    // installs fake timers globally, which the scheduler's fallbacks rely on
    // being real.
    jest.useRealTimers();
    global.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      jest.isolateModules(() => {
        const StyleSheet = require('..');
        const React = require('react');
        const { hydrateRoot } = require('react-dom/client');
        // React 18.3 moved `act` onto the React export and warns via
        // console.error when it is taken from react-dom/test-utils — which
        // this test would then report as a failure.
        const act = React.act;
        const View = require('../../View');

        const shellStyles = StyleSheet.create({ s: { marginTop: shellPx } });
        const chunkStyles = StyleSheet.create({ c: { margin: chunkPx } });
        const tree = React.createElement(
          View,
          { style: shellStyles.s, testID: 'shell' },
          React.createElement(View, { style: chunkStyles.c, testID: 'chunk' })
        );

        act(() => {
          hydrateRoot(document.getElementById('root'), tree, {
            onRecoverableError: (error) => recovered.push(String(error))
          });
        });
      });
    } finally {
      spy.mockRestore();
      global.IS_REACT_ACT_ENVIRONMENT = false;
      jest.useFakeTimers();
    }

    expect(calls).toEqual([]);
    expect(recovered).toEqual([]);
    // Hydration adopted the server nodes rather than replacing them, which
    // is the observable difference between "no warning" and "no mismatch".
    expect(document.getElementById('root').innerHTML).toBe(markup);
  });

  test('a delta arriving after boot is ingested and still dedups', () => {
    const shellPx = uniq();
    const latePx = uniq();

    // The real suspense case: RNW's runtime is already live when a later
    // boundary resolves, so the chunk's script finds __RNW_INGEST_DELTA__
    // installed and calls it synchronously instead of only queueing.
    const { lateClass, lateHTML, shellHTML } = renderOnServer((StyleSheet) => {
      StyleSheet([StyleSheet.create({ s: { marginTop: shellPx } }).s]);
      const shellHTML = StyleSheet.takeShellHTML();

      const late = StyleSheet.create({ l: { paddingTop: latePx } });
      const [lateClass] = StyleSheet([late.l]);
      return { lateClass, lateHTML: StyleSheet.takeDeltaHTML(), shellHTML };
    });

    document.head.innerHTML = shellHTML;
    document.body.innerHTML = '<div id="probe"></div>';

    jest.isolateModules(() => {
      const StyleSheet = require('..');
      expect(typeof window.__RNW_INGEST_DELTA__).toBe('function');

      const afterBoot = totalRuleCount();

      // The chunk lands now.
      streamChunk(lateHTML);
      // The hook drained the queue synchronously rather than leaving the
      // payload for a boot that already happened.
      expect(window.__RNW_DELTA__).toEqual([]);
      // The rule went into group 3's existing anchor; <head> is untouched.
      expect(headGroups()).toEqual(['0', '1', '2', '2.1', '2.2', '3']);
      expect(document.body.querySelectorAll('style').length).toBe(0);
      expect(document.body.querySelectorAll('script').length).toBe(0);

      const withLate = totalRuleCount();
      expect(withLate).toBe(afterBoot + 1);

      // The client now compiles the same style itself — the case where a
      // late-hydrated component re-runs `create` for a class its own chunk
      // already delivered.
      const again = StyleSheet.create({ l: { paddingTop: latePx } });
      const [classes] = StyleSheet([again.l]);
      expect(classes).toBe(lateClass);
      expect(totalRuleCount()).toBe(withLate);

      document.getElementById('probe').className = classes;
      expect(computedFromSerialization('probe', 'paddingTop')).toBe(
        `${latePx}px`
      );
    });
  });

  test('boot is unaffected by a chunk script running repeatedly', () => {
    const shellPx = uniq();
    const firstPx = uniq();
    const secondPx = uniq();

    // A chunk's script deletes itself once it has run, so the parser can
    // never run it twice — but the source can still be replayed by hand,
    // and it must stay a no-op when it is. Two chunks landing in the *same*
    // group is the case that makes a bad re-run observable: without the
    // per-chunk guard in `__RNW_DELTA_SEEN__`, a replay appends the same
    // rules into the anchor a second time and the sheet grows without
    // bound on a long-lived page.
    //
    // `margin` and `padding` are both group 2 but different properties, so
    // a duplicate cannot be papered over by the cascade — and, going the
    // other way, the assertions below are not secretly depending on
    // intra-group order, which the format deliberately leaves unspecified.
    const { firstClass, firstHTML, secondClass, secondHTML, shellHTML } =
      renderOnServer((StyleSheet) => {
        StyleSheet([StyleSheet.create({ s: { marginTop: shellPx } }).s]);
        const shellHTML = StyleSheet.takeShellHTML();

        const first = StyleSheet.create({ f: { margin: firstPx } });
        const [firstClass] = StyleSheet([first.f]);
        const firstHTML = StyleSheet.takeDeltaHTML();

        const second = StyleSheet.create({ s2: { padding: secondPx } });
        const [secondClass] = StyleSheet([second.s2]);
        return {
          firstClass,
          firstHTML,
          secondClass,
          secondHTML: StyleSheet.takeDeltaHTML(),
          shellHTML
        };
      });

    const sourceOf = (html) =>
      html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
    const replay = (html) => {
      const el = document.createElement('script');
      el.textContent = sourceOf(html);
      document.body.appendChild(el);
      // The script removes itself; this only covers the guard path, where
      // `currentScript` is a node the caller still owns.
      if (el.parentNode != null) document.body.removeChild(el);
    };

    document.head.innerHTML = shellHTML;
    document.body.innerHTML = `<div id="probe" class="${firstClass} ${secondClass}"></div>`;
    streamChunk(firstHTML);
    streamChunk(secondHTML);

    // <head> is exactly the shell: two chunks, no new elements.
    const headAfterStream = headGroups();
    expect(headAfterStream).toEqual(['0', '1', '2', '2.1', '2.2', '3']);
    const rulesAfterStream = totalRuleCount();

    // Replays before RNW loads: nothing inserted twice, nothing moved.
    // Checked after *each* replay — a duplicate a second replay would not
    // undo is still a duplicate the page rendered with.
    replay(firstHTML);
    expect(headGroups()).toEqual(headAfterStream);
    expect(totalRuleCount()).toBe(rulesAfterStream);
    replay(secondHTML);
    expect(headGroups()).toEqual(headAfterStream);
    expect(totalRuleCount()).toBe(rulesAfterStream);

    const rulesBeforeBoot = totalRuleCount();

    jest.isolateModules(() => {
      const StyleSheet = require('..');

      expect(headGroups()).toEqual(headAfterStream);
      expect(totalRuleCount()).toBe(rulesBeforeBoot);
      // Both payloads were consumed, so the queue drained to empty rather
      // than accumulating work for every later chunk.
      expect(window.__RNW_DELTA__).toEqual([]);

      // Replays after boot now reach the installed hook as well.
      replay(firstHTML);
      expect(headGroups()).toEqual(headAfterStream);
      replay(secondHTML);

      expect(headGroups()).toEqual(headAfterStream);
      expect(document.body.querySelectorAll('style').length).toBe(0);
      expect(document.body.querySelectorAll('script').length).toBe(0);
      expect(totalRuleCount()).toBe(rulesBeforeBoot);

      // The repeated ingest did not corrupt the bookkeeping: both streamed
      // classes are still known, so runtime creates for them stay no-ops.
      const again = StyleSheet.create({
        f: { margin: firstPx },
        s2: { padding: secondPx }
      });
      expect(StyleSheet([again.f])[0]).toBe(firstClass);
      expect(StyleSheet([again.s2])[0]).toBe(secondClass);
      expect(totalRuleCount()).toBe(rulesBeforeBoot);
      expect(computedFromSerialization('probe', 'marginTop')).toBe(
        `${firstPx}px`
      );
      expect(computedFromSerialization('probe', 'paddingTop')).toBe(
        `${secondPx}px`
      );
    });
  });
});
