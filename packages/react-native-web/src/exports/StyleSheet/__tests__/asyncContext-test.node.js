/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import StyleSheet from '..';
import { runInRequestScope } from '../../../modules/asyncContext';

/**
 * The StyleSheet shared registry is module-scope state. Each test runs in
 * its own Jest module, but tests inside this file share the same registry,
 * so we make each test use distinct style keys to avoid the dedup map
 * (selectors) silently dropping a "new" rule that another test already
 * inserted.
 *
 * These tests run in the node Jest environment (`*.test.node.js`) so
 * `canUseDOM` is false and the underlying CSSOM sheet is a no-op — same
 * conditions as SSR.
 */

// A counter-driven generator that produces unique, valid `width` values.
// Width is a numeric property → no validate-time rejection, and the unique
// number ensures each call produces a distinct atomic rule (distinct
// generated class name). Using `width` instead of `color` avoids both the
// hex-color validation and any color-format normalization that would make
// it harder to find the value in the emitted CSS text.
let widthCounter = 1000;
const makeStyle = () => ({ width: widthCounter++ });

describe('StyleSheet per-request delta', () => {
  test('takeRequestDelta returns "" outside a request scope', () => {
    StyleSheet.create({ outside: makeStyle() });
    expect(StyleSheet.takeRequestDelta()).toBe('');
  });

  test('takeRequestDelta returns rules added during the scope', () => {
    runInRequestScope(() => {
      // Drain any rules that arrived before this test (none in a fresh
      // process, but harmless to call).
      StyleSheet.resetRequestDelta();
      StyleSheet.create({ a: makeStyle() });
      const delta = StyleSheet.takeRequestDelta();
      // Sanity: the delta contains at least one rule plus a marker.
      expect(delta).toContain('[stylesheet-group="');
      expect(delta).toMatch(/\.r-[^ ]+ ?\{/);
    });
  });

  test('takeRequestDelta clears the buffer', () => {
    runInRequestScope(() => {
      StyleSheet.resetRequestDelta();
      StyleSheet.create({ a: makeStyle() });
      const first = StyleSheet.takeRequestDelta();
      expect(first.length).toBeGreaterThan(0);
      // Calling again with no new rules returns empty.
      expect(StyleSheet.takeRequestDelta()).toBe('');
    });
  });

  test('a group marker is emitted only on the first flush per request', () => {
    runInRequestScope(() => {
      StyleSheet.resetRequestDelta();
      StyleSheet.create({ a: makeStyle() });
      const first = StyleSheet.takeRequestDelta();
      const firstMarkerCount = (first.match(/\[stylesheet-group="/g) || [])
        .length;
      expect(firstMarkerCount).toBeGreaterThan(0);

      // Add another rule to the same request and flush again. The marker
      // should NOT reappear because the client already knows the group.
      StyleSheet.create({ b: makeStyle() });
      const second = StyleSheet.takeRequestDelta();
      expect(second).toMatch(/\.r-[^ ]+ ?\{/);
      expect(second).not.toContain('[stylesheet-group="');
    });
  });

  test('every concurrent scope receives every rule its own render needs', async () => {
    const styles = [makeStyle(), makeStyle(), makeStyle(), makeStyle()];
    const deltas = await Promise.all(
      styles.map((styleObj) =>
        runInRequestScope(async () => {
          StyleSheet.resetRequestDelta();
          StyleSheet.create({ x: styleObj });
          // Yield to the microtask queue so other scopes interleave.
          await Promise.resolve();
          return StyleSheet.takeRequestDelta();
        })
      )
    );

    // Completeness is the invariant that matters: a client that misses a
    // rule renders unstyled. Atomic CSS embeds the width as `width:NNNpx`.
    deltas.forEach((delta, i) => {
      expect(delta).toContain(`width:${styles[i].width}px`);
    });

    // Precision is explicitly NOT claimed. Because the shared sheet is
    // process-wide and a lazily imported module inserts its rules exactly
    // once, a request cannot know which of the rules that appeared during
    // its lifetime its own boundaries needed — so it takes all of them.
    // `takeShellHTML` already ships the whole sheet to every client, so
    // this is the same imprecision one flush earlier, and it disappears
    // once the app is warm and nothing new is being inserted.
  });

  test("a rule inserted by another request after this one's shell still reaches it", () => {
    // The concurrency hole. B flushes its shell, and only afterwards does
    // another request insert a rule that B's own boundary then renders.
    //
    // B never calls StyleSheet.create: that is the point. A lazily imported
    // module runs its module-scope create() once per process, so the request
    // that reaches the boundary second inserts nothing. Any delta keyed on
    // "rules I inserted" is empty here, and B's client renders unstyled —
    // exactly the FOUC the delta channel exists to prevent.
    const shared = makeStyle();
    const token = `width:${shared.width}px`;

    let releaseB;
    const bMayResume = new Promise((resolve) => {
      releaseB = resolve;
    });

    const bDelta = runInRequestScope(async () => {
      const shell = StyleSheet.takeShellHTML();
      // The rule does not exist yet, so B's shell cannot contain it.
      expect(shell).not.toContain(token);
      await bMayResume;
      return StyleSheet.takeDeltaHTML();
    });

    // Request A is the one that evaluates the module.
    runInRequestScope(() => {
      StyleSheet.create({ shared });
    });

    releaseB();
    return bDelta.then((delta) => {
      expect(delta).toContain(token);
    });
  });

  test("a rule already in this request's shell is not repeated in its delta", () => {
    // The converse guard: the fix must not degrade into re-sending the
    // whole sheet on every chunk.
    const early = makeStyle();
    const earlyToken = `width:${early.width}px`;

    runInRequestScope(() => {
      StyleSheet.create({ early });
    });

    runInRequestScope(() => {
      const shell = StyleSheet.takeShellHTML();
      expect(shell).toContain(earlyToken);
      // Nothing new since the shell.
      expect(StyleSheet.takeDeltaHTML()).toBe('');

      const late = makeStyle();
      StyleSheet.create({ late });
      const delta = StyleSheet.takeDeltaHTML();
      expect(delta).toContain(`width:${late.width}px`);
      expect(delta).not.toContain(earlyToken);
    });
  });

  test('a rule is not repeated across chunks within one request', () => {
    runInRequestScope(() => {
      StyleSheet.takeShellHTML();

      const styleObj = makeStyle();
      const token = `width:${styleObj.width}px`;
      StyleSheet.create({ chunked: styleObj });

      expect(StyleSheet.takeDeltaHTML()).toContain(token);
      // Re-rendering the same styles in a later chunk adds nothing.
      StyleSheet.create({ chunked: styleObj });
      expect(StyleSheet.takeDeltaHTML()).toBe('');
    });
  });

  test('resetRequestDelta drops pending rules without emitting them', () => {
    runInRequestScope(() => {
      StyleSheet.resetRequestDelta();
      StyleSheet.create({ a: makeStyle() });
      // Simulate the shell head dump: caller emits full sheet, then resets
      // the delta so subsequent flushes only carry rules added after the
      // shell.
      StyleSheet.resetRequestDelta();
      expect(StyleSheet.takeRequestDelta()).toBe('');
    });
  });

  test("duplicate rule across requests does not show in the second request's delta", () => {
    const shared = makeStyle();
    runInRequestScope(() => {
      StyleSheet.resetRequestDelta();
      StyleSheet.create({ s: shared });
      const first = StyleSheet.takeRequestDelta();
      expect(first).toContain(`width:${shared.width}px`);
    });
    // Second request: same rule. The shared sheet already has it; dedup
    // skips re-insertion; delta stays empty.
    runInRequestScope(() => {
      StyleSheet.resetRequestDelta();
      StyleSheet.create({ s: shared });
      expect(StyleSheet.takeRequestDelta()).toBe('');
    });
  });
});
