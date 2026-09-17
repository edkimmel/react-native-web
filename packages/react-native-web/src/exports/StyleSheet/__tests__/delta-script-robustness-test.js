/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The emitted chunk script must always remove itself.
 *
 * It runs in a `<head>` the app may have rendered through React, where a
 * node React did not render is the one DOM shape that silently mis-binds
 * hydration — every later sibling shifts onto the wrong fiber. So a
 * bookkeeping failure inside the script must never be allowed to become
 * that: the self-removal is in `finally`.
 *
 * The reachable thrower is `window.__RNW_INGEST_DELTA__`, which is RNW's own
 * hook (or whatever a page has put on that global). Rules are inserted and
 * queued before it runs, so swallowing its failure costs only the dedup
 * bookkeeping, not the styles.
 */

import StyleSheet from '..';
import { runInRequestScope } from '../../../modules/asyncContext';

let seed = 7000;
const uniq = () => seed++;

function runChunkScript(html) {
  // Re-create the element so jsdom actually executes it: `innerHTML` marks
  // parsed scripts "already started".
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const scripts = Array.prototype.slice.call(holder.querySelectorAll('script'));
  scripts.forEach((parsed) => {
    const script = document.createElement('script');
    script.textContent = parsed.textContent;
    document.body.appendChild(script);
  });
}

function emitChunk() {
  return runInRequestScope(() => {
    StyleSheet.takeShellHTML();
    const value = uniq();
    const style = StyleSheet.create({ late: { marginTop: value } });
    StyleSheet([style.late]);
    return { deltaHTML: StyleSheet.takeDeltaHTML(), value };
  });
}

beforeEach(() => {
  document.head.innerHTML =
    '<style data-rnw-group="0"></style><style data-rnw-group="3"></style>';
  document.body.innerHTML = '';
  delete window.__RNW_DELTA__;
  delete window.__RNW_DELTA_SEEN__;
  delete window.__RNW_INGEST_DELTA__;
});

describe('the emitted chunk script', () => {
  test('removes itself even when the ingest hook throws', () => {
    const { deltaHTML, value } = emitChunk();
    window.__RNW_INGEST_DELTA__ = () => {
      throw new Error('ingest exploded');
    };

    expect(() => runChunkScript(deltaHTML)).not.toThrow();

    // The whole point: no node left behind for React's sibling walk.
    expect(document.querySelectorAll('script').length).toBe(0);
    // And the styles it carried still applied, because insertRule runs
    // before the hook.
    const anchor = document.querySelector('style[data-rnw-group="3"]');
    const rules = Array.prototype.slice.call(anchor.sheet.cssRules);
    expect(rules.some((r) => r.cssText.includes(`${value}px`))).toBe(true);
    // The payload reached the queue, so a later drain can still dedup it.
    expect(Array.isArray(window.__RNW_DELTA__)).toBe(true);
    expect(window.__RNW_DELTA__.length).toBeGreaterThan(0);
  });

  test('removes itself on the ordinary path too', () => {
    const { deltaHTML } = emitChunk();
    runChunkScript(deltaHTML);
    expect(document.querySelectorAll('script').length).toBe(0);
  });
});
