/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Verifies the __RNW_INGEST_DELTA__ hook handles deltas that stream into
 * the document AFTER initial RNW boot. Each test uses jest.isolateModules
 * so dom/index.js's module-scope `sheets` array starts fresh — otherwise
 * tests would see the prior test's createSheet having already booted.
 *
 * Two queue entry shapes are covered, and both have to keep working:
 *
 *   { g, r }  the current wire format. The chunk's script has already put
 *             these rules into the group anchor's CSSOM; the queue entry
 *             exists only so RNW's dedup map learns about them.
 *   "N"       the legacy format, a `data-rnw-delta` element id. No longer
 *             emitted — the elements were what skewed
 *             `hydrateRoot(document, …)` — but still read, because a
 *             client bundle can be newer than the server that rendered
 *             the page it boots into.
 */

const planStyleElement = (textContent, attrs = {}) => {
  const el = document.createElement('style');
  Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
  el.appendChild(document.createTextNode(textContent));
  document.head.appendChild(el);
  return el;
};

import createOrderedCSSStyleSheet from '../dom/createOrderedCSSStyleSheet';

const buildDeltaText = (rules) => {
  // createOrderedCSSStyleSheet is stateless; we use it as a helper to
  // construct the same CSS text the SSR pipeline would emit.
  const s = createOrderedCSSStyleSheet();
  rules.forEach(([cssText, group]) => s.insert(cssText, group));
  return s.getTextContent();
};

const cleanup = () => {
  delete window.__RNW_DELTA__;
  delete window.__RNW_INGEST_DELTA__;
  document.querySelectorAll('style').forEach((el) => el.remove());
  setReadyState('complete');
};

// jsdom reports `readyState: 'complete'`, which for the ingest path means
// "the parser is done, no further shell anchor is ever coming". Every test
// about a pending bucket WAITING for its anchor therefore has to put the
// document back into the state a streaming response is actually in.
const setReadyState = (value) => {
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    value
  });
};

// A group anchor as the shell emits it, optionally with rules already in
// its CSSOM — which is where a chunk that arrived before RNW booted put
// them, and which never shows up in the element's text.
const planAnchor = (group, cssomRules = []) => {
  const el = planStyleElement('', { 'data-rnw-group': String(group) });
  cssomRules.forEach((rule) => {
    el.sheet.insertRule(rule, el.sheet.cssRules.length);
  });
  return el;
};

afterEach(cleanup);

describe('createSheet streaming-delta late ingest', () => {
  test('drains pending __RNW_DELTA__ ids on initial sheet boot', () => {
    jest.isolateModules(() => {
      const { createSheet } = require('../dom');

      planStyleElement(buildDeltaText([['.pre-boot { padding: 8px }', 1]]), {
        'data-rnw-delta': '1'
      });
      window.__RNW_DELTA__ = ['1'];

      const sheet = createSheet();

      expect(typeof window.__RNW_INGEST_DELTA__).toBe('function');
      expect(window.__RNW_DELTA__.length).toBe(0);

      const repeat = sheet.insert('.pre-boot { padding: 8px }', 1);
      expect(repeat.ruleAdded).toBe(false);
    });
  });

  test('absorbs a delta that arrives AFTER boot via the hook', () => {
    jest.isolateModules(() => {
      const { createSheet } = require('../dom');

      // Boot first with no pending deltas.
      const sheet = createSheet();
      expect(typeof window.__RNW_INGEST_DELTA__).toBe('function');

      // A streaming chunk lands later.
      planStyleElement(buildDeltaText([['.post-boot { margin: 4px }', 1]]), {
        'data-rnw-delta': '2'
      });
      (window.__RNW_DELTA__ = window.__RNW_DELTA__ || []).push('2');
      window.__RNW_INGEST_DELTA__();

      const repeat = sheet.insert('.post-boot { margin: 4px }', 1);
      expect(repeat.ruleAdded).toBe(false);
      expect(sheet.getTextContent()).toContain('.post-boot');
    });
  });

  test('processing a delta twice is a no-op', () => {
    jest.isolateModules(() => {
      const { createSheet } = require('../dom');

      planStyleElement(buildDeltaText([['.idempotent { width: 7px }', 1]]), {
        'data-rnw-delta': '3'
      });
      window.__RNW_DELTA__ = ['3'];

      const sheet = createSheet();

      // Re-push the same id and call the hook again — should be a no-op.
      window.__RNW_DELTA__.push('3');
      window.__RNW_INGEST_DELTA__();

      const repeat = sheet.insert('.idempotent { width: 7px }', 1);
      expect(repeat.ruleAdded).toBe(false);

      const text = sheet.getTextContent();
      const matches = (text.match(/\.idempotent/g) || []).length;
      expect(matches).toBe(1);
    });
  });

  test('grouped deltas take their group from the element attribute', () => {
    jest.isolateModules(() => {
      // The streaming format: no marker rules, the group travels on the
      // element so the inline relocation script can read it too.
      planStyleElement('.grouped-delta { margin: 4px }', {
        'data-rnw-group': '2',
        'data-rnw-delta': '10'
      });

      const { createSheet } = require('../dom');
      const sheet = createSheet();

      expect(sheet.insert('.grouped-delta { margin: 4px }', 2).ruleAdded).toBe(
        false
      );
      // Registered under group 2, not appended to whatever came last.
      expect(sheet.getTextContent()).toMatch(
        /\[stylesheet-group="2"\]\{\}\n\.grouped-delta/
      );
    });
  });

  test('a grouped delta arriving after boot is ingested too', () => {
    jest.isolateModules(() => {
      const { createSheet } = require('../dom');
      const sheet = createSheet();

      planStyleElement('.late-grouped { margin-top: 4px }', {
        'data-rnw-group': '3',
        'data-rnw-delta': '11'
      });
      (window.__RNW_DELTA__ = window.__RNW_DELTA__ || []).push('11');
      window.__RNW_INGEST_DELTA__();

      expect(
        sheet.insert('.late-grouped { margin-top: 4px }', 3).ruleAdded
      ).toBe(false);
    });
  });

  test('a rules payload queued before boot is registered on drain', () => {
    jest.isolateModules(() => {
      // The chunk's script ran before RNW loaded: it inserted the rule
      // into the anchor's CSSOM and left the payload in the queue.
      window.__RNW_DELTA__ = [{ g: 2, r: ['.payload-pre-boot{margin:4px}'] }];

      const { createSheet } = require('../dom');
      const sheet = createSheet();

      expect(window.__RNW_DELTA__.length).toBe(0);
      expect(sheet.insert('.payload-pre-boot{margin:4px}', 2).ruleAdded).toBe(
        false
      );
      expect(sheet.getTextContent()).toMatch(
        /\[stylesheet-group="2"\]\{\}\n\.payload-pre-boot/
      );
    });
  });

  test('a rules payload arriving after boot is ingested via the hook', () => {
    jest.isolateModules(() => {
      const { createSheet } = require('../dom');
      const sheet = createSheet();

      (window.__RNW_DELTA__ = window.__RNW_DELTA__ || []).push({
        g: 3,
        r: ['.payload-post-boot{margin-top:4px}', '.payload-two{top:1px}']
      });
      window.__RNW_INGEST_DELTA__();

      expect(window.__RNW_DELTA__.length).toBe(0);
      expect(
        sheet.insert('.payload-post-boot{margin-top:4px}', 3).ruleAdded
      ).toBe(false);
      expect(sheet.insert('.payload-two{top:1px}', 3).ruleAdded).toBe(false);
    });
  });

  test('ingesting the same payload twice adds nothing', () => {
    jest.isolateModules(() => {
      const { createSheet } = require('../dom');
      const sheet = createSheet();

      const entry = { g: 2, r: ['.payload-idempotent{margin:9px}'] };
      window.__RNW_DELTA__ = window.__RNW_DELTA__ || [];
      window.__RNW_DELTA__.push(entry);
      window.__RNW_INGEST_DELTA__();
      window.__RNW_DELTA__.push(entry);
      window.__RNW_INGEST_DELTA__();

      // No `processed` set guards this path; the selector dedup inside
      // registerExisting is what makes it safe.
      const text = sheet.getTextContent();
      expect((text.match(/\.payload-idempotent/g) || []).length).toBe(1);
    });
  });

  test('a payload with a missing or malformed group is skipped', () => {
    jest.isolateModules(() => {
      const { createSheet } = require('../dom');
      const sheet = createSheet();
      const before = sheet.getTextContent();

      window.__RNW_DELTA__ = window.__RNW_DELTA__ || [];
      window.__RNW_DELTA__.push({ g: 'nope', r: ['.bad-group{margin:1px}'] });
      window.__RNW_DELTA__.push({ g: 2 });
      window.__RNW_INGEST_DELTA__();

      expect(sheet.getTextContent()).toBe(before);
      // ...and a runtime insert of that rule still works normally.
      expect(sheet.insert('.bad-group{margin:1px}', 2).ruleAdded).toBe(true);
    });
  });

  test('boot alone sees rules a chunk put in an anchor before RNW loaded', () => {
    jest.isolateModules(() => {
      // No queue entry at all — the drain is an optimisation, not the
      // correctness path. `collectGroupSheets` reads each anchor's live
      // cssRules, which is the only place an `insertRule`d rule exists.
      planAnchor(2, ['.cssom-only{margin:6px}']);

      const { createSheet } = require('../dom');
      const sheet = createSheet();

      expect(sheet.insert('.cssom-only{margin:6px}', 2).ruleAdded).toBe(false);
    });
  });

  test('queues delta ids when the hook is not yet installed', () => {
    jest.isolateModules(() => {
      // Server's inline script runs before RNW boots. It pushes into the
      // queue and tries to call the hook, which is absent — a no-op.
      (window.__RNW_DELTA__ = window.__RNW_DELTA__ || []).push('4');
      expect(typeof window.__RNW_INGEST_DELTA__).toBe('undefined');

      planStyleElement(
        buildDeltaText([['.queued-before-boot { color: blue }', 1]]),
        { 'data-rnw-delta': '4' }
      );

      // RNW boots; queue gets drained by installDeltaIngest.
      const { createSheet } = require('../dom');
      const sheet = createSheet();
      expect(window.__RNW_DELTA__.length).toBe(0);

      const repeat = sheet.insert('.queued-before-boot { color: blue }', 1);
      expect(repeat.ruleAdded).toBe(false);
    });
  });
  // -------------------------------------------------------------------
  // Pending buckets: a chunk that ran before its anchor existed.
  //
  // Reachable once the app renders `<head>` through React with a Suspense
  // boundary in or above it. The chunk applies nothing and flags the
  // bucket `p`; the runtime is what applies it, and only once an anchor is
  // actually there — synthesising one would be a `<style>` React did not
  // render sitting among ones it did, which is the shape that silently
  // mis-binds `hydrateRoot(document, …)`.
  // -------------------------------------------------------------------

  test('a pending bucket with no anchor stays queued and creates nothing', () => {
    jest.isolateModules(() => {
      setReadyState('loading');
      window.__RNW_DELTA__ = [{ g: 3, p: 1, r: ['.pending{margin-top:4px}'] }];

      const { createSheet } = require('../dom');
      const sheet = createSheet();

      // Still queued...
      expect(window.__RNW_DELTA__.length).toBe(1);
      expect(window.__RNW_DELTA__[0].g).toBe(3);
      // ...and no group-3 element was conjured for it. (Group 0 exists
      // because createSheet inserts its own reset rules.)
      expect(
        document.querySelectorAll('style[data-rnw-group="3"]').length
      ).toBe(0);
      // Not recorded either: a rule nothing is applying must not make a
      // later runtime insert dedup itself out of existence.
      expect(sheet.insert('.pending{margin-top:4px}', 3).ruleAdded).toBe(true);
    });
  });

  test('the same bucket is applied once the anchor appears', () => {
    jest.isolateModules(() => {
      setReadyState('loading');
      window.__RNW_DELTA__ = [
        { g: 3, p: 1, r: ['.late-anchor{margin-top:4px}'] }
      ];

      const { createSheet } = require('../dom');
      const sheet = createSheet();
      expect(window.__RNW_DELTA__.length).toBe(1);

      // React commits the head boundary; the anchor is now in the document
      // and <StyleSheet.Anchors> asks for a re-drain.
      planAnchor(3);
      window.__RNW_INGEST_DELTA__();

      expect(window.__RNW_DELTA__.length).toBe(0);
      // Actually applied, not merely recorded: the rule is in the anchor's
      // own sheet, which is what puts it in the right cascade bucket.
      const anchor = document.querySelector('style[data-rnw-group="3"]');
      expect(
        Array.from(anchor.sheet.cssRules).map((rule) => rule.cssText)
      ).toContain('.late-anchor {margin-top: 4px;}');
      // And a runtime create for the same class dedups against it.
      expect(sheet.insert('.late-anchor{margin-top:4px}', 3).ruleAdded).toBe(
        false
      );
    });
  });

  test('a pending bucket does not hold up a later applicable one', () => {
    jest.isolateModules(() => {
      setReadyState('loading');
      planAnchor(2);
      window.__RNW_DELTA__ = [
        { g: 3, p: 1, r: ['.blocked{margin-top:4px}'] },
        { g: 2, p: 1, r: ['.not-blocked{margin:4px}'] }
      ];

      const { createSheet } = require('../dom');
      const sheet = createSheet();

      // Group 2 had somewhere to go; group 3 did not, and waits alone.
      expect(window.__RNW_DELTA__.map((entry) => entry.g)).toEqual([3]);
      expect(sheet.insert('.not-blocked{margin:4px}', 2).ruleAdded).toBe(false);
    });
  });

  test('drainDeltaQueue is a no-op before the sheet boots', () => {
    jest.isolateModules(() => {
      setReadyState('loading');
      const { drainDeltaQueue } = require('../dom/ingestDelta');
      window.__RNW_DELTA__ = [
        { g: 3, p: 1, r: ['.untouched{margin-top:4px}'] }
      ];
      expect(() => drainDeltaQueue()).not.toThrow();
      expect(window.__RNW_DELTA__.length).toBe(1);
    });
  });

  test('requeueing does not look like a second chunk arriving', () => {
    jest.isolateModules(() => {
      setReadyState('loading');
      // The e2e harness observes chunks by wrapping the queue's `push`.
      // A retained entry going back must not be counted twice.
      const seen = [];
      const queue = [];
      queue.push = function (...entries) {
        entries.forEach((entry) => seen.push(entry));
        return Array.prototype.push.apply(this, entries);
      };
      queue.push({ g: 3, p: 1, r: ['.counted-once{margin-top:4px}'] });
      window.__RNW_DELTA__ = queue;

      const { createSheet } = require('../dom');
      createSheet();
      window.__RNW_INGEST_DELTA__();
      window.__RNW_INGEST_DELTA__();

      expect(seen.length).toBe(1);
      expect(window.__RNW_DELTA__.length).toBe(1);
    });
  });
  test('a bucket still waiting when the parser finishes stops waiting', () => {
    jest.isolateModules(() => {
      // The shape a caller who streams deltas but never emits a shell ends
      // up in. Once the document is parsed no React-rendered anchor can
      // still be on its way, so there is nothing left to collide with and
      // the rules are applied through RNW's normal runtime path — which
      // creates the anchor in ascending position, exactly as a runtime
      // `StyleSheet.create` for that group would have.
      setReadyState('loading');
      window.__RNW_DELTA__ = [
        { g: 3, p: 1, r: ['.no-shell-at-all{margin-top:4px}'] }
      ];

      const { createSheet } = require('../dom');
      const sheet = createSheet();
      expect(window.__RNW_DELTA__.length).toBe(1);

      // The document finishes parsing. (Driven through the hook rather than
      // by dispatching DOMContentLoaded: `jest.isolateModules` leaves every
      // earlier test's listener attached to the one shared jsdom document,
      // and the event would run all of them against their own stale sheets.)
      setReadyState('interactive');
      window.__RNW_INGEST_DELTA__();

      expect(window.__RNW_DELTA__.length).toBe(0);
      expect(
        sheet.insert('.no-shell-at-all{margin-top:4px}', 3).ruleAdded
      ).toBe(false);
      expect(
        document.querySelector('style[data-rnw-group="3"][data-rnw-runtime]')
      ).not.toBe(null);
    });
  });
});
