// Central place that turns `?scenario=a&position=between` into a config
// object describing what the root layout should render, and what the
// instrumentation script should do out-of-band.
//
// Scenario legend (see FINDINGS.md for the full writeup):
//   a - <style> inserted into React-rendered <head>, among the anchors  (our exact bug)
//   b - <script> inserted into <body>, mimicking Next's own flight-data push
//   c - <style> inserted into <body>
//   d - <script> inserted into <head>, among the anchors
//   e - control: <style> inserted into <head> BY REACT via useServerInsertedHTML
//   f - control: React 19 <style precedence="..."> (React-hoisted resource)
//   none - no script-driven DOM insertion at all; renders the plain anchors
//          only. Used by scripts/run-byte-splice-probe.js, which instead
//          splices a foreign node directly into the raw HTML *response
//          bytes* (before the browser's HTML parser ever runs), to test
//          Next's own createHeadInsertionTransformStream mechanism rather
//          than a post-parse DOM mutation.
//
// `position` ("between" | "after") only applies to a/b/c/d: does the foreign
// node land between two anchors, or strictly after the last one?

const SCENARIOS = ['a', 'b', 'c', 'd', 'e', 'f', 'none'];
const POSITIONS = ['between', 'after'];

export function parseScenario(search) {
  const params = new URLSearchParams(search || '');
  const scenario = SCENARIOS.includes(params.get('scenario'))
    ? params.get('scenario')
    : 'a';
  const position = POSITIONS.includes(params.get('position'))
    ? params.get('position')
    : 'between';

  return {
    scenario,
    position,
    headForeignTag:
      scenario === 'a' ? 'style' : scenario === 'd' ? 'script' : null,
    bodyForeignTag:
      scenario === 'b' ? 'script' : scenario === 'c' ? 'style' : null,
    useServerInserted: scenario === 'e',
    usePrecedence: scenario === 'f'
  };
}

// Builds the source of the single instrumentation <script> that:
//   1. Marks every existing probe anchor (head + body) with an identity
//      token, BEFORE hydration, so we can later tell whether React
//      discarded/recreated the DOM node during hydration (identity lost)
//      vs. reused it (identity preserved, possibly mis-owned).
//   2. Performs the scenario's out-of-band DOM insertion (if any) - a plain
//      `document.createElement` + `insertBefore`/`appendChild` that React's
//      SSR pass never produced and never knows about.
//   3. Timestamps itself via performance.now() so we can later prove this
//      ran before the client bundle evaluated / hydration committed.
export function buildInstrumentationScript(config) {
  const cfg = JSON.stringify(config);
  return `
(function () {
  var cfg = ${cfg};
  window.__PROBE = window.__PROBE || {};
  window.__PROBE.config = cfg;
  window.__PROBE.preHydrationSet = new Set();
  window.__PROBE.log = [];

  function mark(list) {
    for (var i = 0; i < list.length; i++) {
      window.__PROBE.preHydrationSet.add(list[i]);
    }
  }

  mark(document.querySelectorAll('head [data-probe-anchor]'));
  mark(document.querySelectorAll('body [data-probe-anchor]'));

  function insertForeign(container, tag, position, label) {
    var anchors = Array.prototype.slice.call(container.querySelectorAll(':scope > [data-probe-anchor]'));
    var foreign = document.createElement(tag);
    foreign.setAttribute('data-probe-foreign', label);
    if (tag === 'style') {
      // Left textually empty on purpose: matches the real anchors' own
      // (empty) content, so a same-tag foreign node is textually
      // indistinguishable from a real anchor during hydration - the same
      // condition that lets the real react-native-web bug's relocated
      // <style> land silently instead of hard-erroring on a text mismatch.
    } else {
      foreign.textContent = 'window.__PROBE.log.push("foreign-script-ran:' + label + '");';
    }
    if (position === 'between' && anchors.length >= 2) {
      // Land between the 1st and 2nd anchors.
      container.insertBefore(foreign, anchors[1]);
    } else {
      // Land strictly after the last anchor (insertBefore(x, null) === append).
      var last = anchors[anchors.length - 1];
      container.insertBefore(foreign, last ? last.nextSibling : null);
    }
    return foreign;
  }

  if (cfg.headForeignTag) {
    insertForeign(document.head, cfg.headForeignTag, cfg.position, 'head-' + cfg.scenario);
  }
  if (cfg.bodyForeignTag) {
    insertForeign(document.body, cfg.bodyForeignTag, cfg.position, 'body-' + cfg.scenario);
  }

  window.__PROBE.injectedAt = performance.now();
})();
`;
}
