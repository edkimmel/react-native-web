/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Pins WHEN `createStyleInjectionTransform` emits its prelude.
 *
 * WHAT THIS IS REALLY PROTECTING, and why it cannot say so with a real
 * `renderToPipeableStream` call:
 *
 * The transform used to emit the prelude — doctype, `<head>`, the whole shell
 * stylesheet — only from `_transform`, i.e. on React's first *byte*. React
 * 19.1 broke that assumption. Fizz's preamble became Suspense-aware:
 * `preparePreamble` walks the completed root segment looking for
 * `<html>`/`<head>`/`<body>`, and if it reaches a still-pending Suspense
 * boundary without first passing through a host element it leaves
 * `request.completedPreambleSegments` null, whereupon `flushCompletedQueues`
 * returns before writing anything — React is waiting to learn whether the
 * document element is going to come out of that boundary. For a tree whose
 * root is a `<Suspense>` (or a Fragment or array with one as a direct child)
 * React therefore writes NO bytes until the boundary resolves. Keying the
 * prelude off the first byte withheld the entire document until then: the
 * response stopped streaming, and every rule the boundary compiled was folded
 * into the shell instead of arriving as a delta.
 *
 * What React does still do in that state is call `destination.flush()` — from
 * the `finally` of `flushCompletedQueues`, with zero bytes written. So
 * `start()` runs from `flush()` as well as from `_transform`.
 *
 * The repo installs React 18.3.1, which does not have the Suspense-aware
 * preamble (nor does 19.0.0), so no test here can provoke the real thing.
 * Instead this drives the transform through the two `write`/`flush`
 * interleavings by hand and pins the invariant that survives both:
 *
 *   - the prelude is emitted exactly once,
 *   - before any React byte,
 *   - and a zero-byte flush ahead of the first write does NOT drain a delta
 *     ahead of the shell.
 *
 * "flush-first" is React >= 19.1 with a top-level Suspense boundary;
 * "write-first" is every other version and shape. Verified end to end against
 * 18.3.1, 19.0.0, 19.1.1, 19.2.0 and 19.3.0 at the time this was written.
 *
 * If someone re-restricts `start()` to `_transform`, the flush-first case here
 * fails and says why.
 */

import StyleSheet from '../../../exports/StyleSheet';
import createStyleInjectionTransform from '..';
import { runInRequestScope } from '../../asyncContext';

let seed = 7000;
const uniq = () => seed++;

const PRELUDE = (shellCSS) =>
  `<!doctype html><html><head>${shellCSS}</head><body><div id="root">`;
const EPILOGUE = '</div></body></html>';

/**
 * Drive the transform through an explicit sequence, standing in for React.
 * `'flush'` is React's end-of-pass signal (the public `flush()`, not the
 * Transform `_flush` hook); anything else is a byte chunk React wrote.
 */
function drive(sequence) {
  return runInRequestScope(
    () =>
      new Promise((resolve, reject) => {
        const injector = createStyleInjectionTransform({
          epilogue: EPILOGUE,
          prelude: PRELUDE
        });
        const chunks = [];
        injector.on('data', (chunk) => chunks.push(chunk));
        injector.on('error', reject);
        injector.on('end', () =>
          resolve(Buffer.concat(chunks).toString('utf8'))
        );

        sequence.forEach((step) => {
          if (step === 'flush') {
            // $FlowFixMe - React's hook, deliberately not on the Transform type
            injector.flush();
          } else if (typeof step === 'function') {
            step();
          } else {
            injector.write(Buffer.from(step, 'utf8'));
          }
        });
        injector.end();
      })
  );
}

const countDoctypes = (html) => html.split('<!doctype html>').length - 1;

/**
 * The delta scripts in `html`, in document order, as `[index, source]`.
 *
 * A delta emits no element — that node was the hydration hazard the format
 * exists to remove — so "a delta arrived" cannot be asserted by looking for
 * `data-rnw-delta`. That string IS present in the output, but only inside
 * the script's own `:not([data-rnw-delta]):not([data-rnw-runtime])`
 * selector, so `toContain('data-rnw-delta')` passes whether or not a single
 * rule was streamed, and breaks silently if that selector is ever reworded.
 * The durable trace is the payload pushed onto `__RNW_DELTA__`.
 */
function deltaScripts(html) {
  const result = [];
  const pattern = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = pattern.exec(html)) != null) {
    if (match[1].indexOf('__RNW_DELTA__') > -1) {
      result.push([match.index, match[1]]);
    }
  }
  return result;
}

describe('createStyleInjectionTransform prelude ordering', () => {
  test('a zero-byte flush before the first write still emits the prelude first', async () => {
    // React >= 19.1, root-level Suspense: flush() arrives with nothing
    // written, and no byte will follow until the boundary resolves.
    const lateValue = uniq();
    const html = await drive([
      'flush',
      () => {
        // Stands in for the late boundary compiling CSS once it resolves.
        StyleSheet.create({ late: { marginTop: lateValue } });
      },
      '<div id="body">late</div>',
      'flush'
    ]);

    expect(countDoctypes(html)).toBe(1);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.endsWith(EPILOGUE)).toBe(true);
    // The shell went out ahead of React's first byte, not after it.
    expect(html.indexOf('</head>')).toBeLessThan(
      html.indexOf('<div id="body">')
    );

    // The rule compiled after the shell was taken is a delta, not shell text.
    const headEnd = html.indexOf('</head>');
    expect(html.slice(0, headEnd)).not.toContain(`margin-top:${lateValue}px`);
    expect(html.slice(headEnd)).toContain(`margin-top:${lateValue}px`);
    // And it travelled as a delta, not as stray text: exactly one script
    // pushing onto `__RNW_DELTA__`, carrying that rule.
    const deltas = deltaScripts(html);
    expect(deltas).toHaveLength(1);
    expect(deltas[0][1]).toContain(`margin-top:${lateValue}px`);
  });

  test('the leading zero-byte flush does not drain a delta ahead of the shell', async () => {
    // The ordering inside flush() is start() then emitDelta(), never the
    // reverse: a delta drained first would steal the rules the shell owns and
    // put its script ahead of the doctype.
    //
    // Both rules are needed for this to be able to fail. `early` is what a
    // prematurely drained delta would steal — it is compiled before the
    // scope's shell is taken, so it belongs to the shell and no delta may
    // mention it. `late` is what makes a delta exist at all: with only
    // `early` in play the transform emits no script, and an assertion about
    // where the first delta sits has nothing to say.
    const early = uniq();
    const late = uniq();
    StyleSheet.create({ early: { marginTop: early } });

    const html = await drive([
      'flush',
      () => {
        StyleSheet.create({ late: { marginTop: late } });
      },
      '<div id="body">x</div>',
      'flush'
    ]);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    const headEnd = html.indexOf('</head>');
    // Compiled before the shell was taken, so it belongs to the shell...
    expect(html.slice(0, headEnd)).toContain(`margin-top:${early}px`);

    const deltas = deltaScripts(html);
    expect(deltas).toHaveLength(1);
    // ...and no delta carries it: the leading flush did not drain ahead of
    // the shell.
    expect(deltas[0][1]).not.toContain(`margin-top:${early}px`);
    expect(deltas[0][1]).toContain(`margin-top:${late}px`);
    // Nothing was emitted between the first flush and the prelude.
    expect(deltas[0][0]).toBeGreaterThan(headEnd);
  });

  test('write-first still emits exactly one prelude, before the first byte', async () => {
    // React 18 / 19.0, and every version once a host element sits above the
    // boundary: completeWriting() writes before flushBuffered() calls us, so
    // _transform has already run and start() in flush() is a no-op.
    const html = await drive([
      '<div id="a">a</div>',
      'flush',
      '<div id="b">b</div>',
      'flush'
    ]);

    expect(countDoctypes(html)).toBe(1);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.indexOf('</head>')).toBeLessThan(html.indexOf('<div id="a">'));
    expect(html.indexOf('<div id="a">')).toBeLessThan(
      html.indexOf('<div id="b">')
    );
    expect(html.endsWith(EPILOGUE)).toBe(true);
  });

  test('a stream that only ever flushes, never writes, is still a whole document', async () => {
    // The degenerate end of the same change: React aborts, or the boundary
    // never resolves, and not one byte is produced.
    const html = await drive(['flush']);

    expect(countDoctypes(html)).toBe(1);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.endsWith(EPILOGUE)).toBe(true);
    expect(html).toContain('data-rnw-group="0"');
  });
});
