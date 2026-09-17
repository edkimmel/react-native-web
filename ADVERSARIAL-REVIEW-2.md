# Adversarial review 2 — only what landed today

Scope: the six areas named in the brief — the `react-native-web/server` subpath,
`StyleSheet.Anchors`, the new S1 anchor-bytes gate, the React version gating in
`packages/streaming-ssr-e2e/specs/helpers.js`, `scripts/react-version-matrix.js`, the new tests,
and the three rewritten docs. Findings already in `ADVERSARIAL-REVIEW.md` are not repeated
unless they **survived today's rewrite of the file they live in**, in which case they are
marked `(SURVIVED)`.

**Baseline, run at review time.** `npm run flow` → No errors. `npm run lint` → clean.
`npm run format` → clean (the previous review's #14 is fixed). `jest --config
./configs/jest.config.js` → 65 suites / 836 passed, 6 skipped. `jest --config
./configs/jest.config.node.js` → 18 suites / 138 passed. Playwright, run per version through
`E2E_REACT_DIR`: **18.3.1 → 20 passed / 4 skipped**, **19.0.0 → 21 / 3**, **19.3.0 → 21 / 3** —
all three match the table at `STREAMING-SSR.md:150-156` exactly. So none of what follows is
caught by any existing gate.

Probes live outside the repo, in a scratch directory. The working tree is unchanged apart from
this file; `packages/react-native-web/dist/cjs/modules/styleInjection/index.js` was temporarily
mutated for the negative controls in #3 and restored byte-for-byte (`dist` is gitignored and was
not rebuilt).

### Index

| # | Sev | Finding |
|---|---|---|
| 1 | **HIGH** | `react-native-web/server` does not resolve from native Node ESM — `ERR_UNSUPPORTED_DIR_IMPORT`. Every documented example is the form that fails; the in-tree verification used the one form that works |
| 2 | HIGH | `STREAMING-SSR.md` **still** documents the deleted missing-anchor fallback, in a file rewritten today (SURVIVED) |
| 3 | MED-HIGH | The duplicate-shell `console.error` is documented as development-only; the source deliberately fires it in production too |
| 4 | MED | `IStyleSheet` type-checks nothing — the annotation is vacuous, proved with two Flow mutants |
| 5 | MED | Three new tests cannot fail for the reason they name; `warnIfRuntimeAnchorsSkewHydration` has zero coverage and burns its own once-latch inside the suite |
| 6 | MED-LOW | The `tail` fallback in `push()` **drops** the bytes it exists to preserve; its comment claims the opposite. Unreachable from React (verified in four React builds), so latent |
| 7 | MED-LOW | "the cost is bounded … rather than paid per chunk forever" is false for the configuration the same comment says is supported: measured 1.57× on the transform's write path, with a full copy of every chunk |
| 8 | MED-LOW | `STREAMING-SSR.md` scope claim is still false, in a file rewritten today (SURVIVED) |
| 9 | LOW-MED | `REACT19-FINDINGS.md` Surface 1 documents `RELOCATE_SCRIPT`, a mechanism deleted from the source, in the present tense and cites a test that does not exist |
| 10 | LOW | `reactMajor` gates classify `react@experimental` (`0.0.0-experimental-…`) as React 18 → two specs would fail falsely; the same build false-negatives `hasSuspenseAwarePreamble` |
| 11 | LOW | `react-version-matrix.js` never verifies that the React that *ran* is the React it installed; cache invalidation checks only `react`'s version; no `passed > 0` floor |
| 12 | LOW | A non-UTF-8 string `write()` defeats the anchor scan entirely (measured) |
| 13 | LOW | `src/server/index.js` is shipped in `files` and is not covered by the `browser` field map |
| 14 | LOW | Assorted overstatements in `REACT19-FINDINGS.md` / `helpers.js` (the "preamble" word claim; a "FIXED" comment that was not fixed; 19.0.8 / 19.1.0 installs that do not exist) |
| S1–S4 | — | Suspected, not reproduced |
| T1–T5 | — | Test quality |

---

## The headline answers, first

Three of the brief's questions have a clean yes/no and deserve to be up front.

**Did the S1 gate regress the CRITICAL ordering fix? No.** Measured, not reasoned — see #A
below. Under real backpressure with real `renderToPipeableStream` over a real socket, on both
React 18.3.1 and 19.3.0, every delta still lands between elements. The negative control fires.

**Can the carry-over drop or duplicate a match? No.** Every split offset 1–15, a three-way
split, and a one-byte-at-a-time stream all open the gate. The carry is copied, not aliased, and
survives a writer that overwrites its own view. See #B.

**Does the `StyleSheet` ⇄ `StyleSheetAnchors` cycle resolve in both orders? Yes**, on a real
build, in CJS and ESM and through a bundler. See #C. The author's claim about Babel hoisting is
correct — though not for the module they describe. See the note in #C.

---

## CONFIRMED

### 1. HIGH — `react-native-web/server` is unresolvable from native Node ESM

`packages/react-native-web/server/package.json`

The directory shim is the pre-`exports` pattern, and it works for CJS `require` and for
bundlers. Node's **ESM** resolver does not do directory/`main` resolution for a bare specifier
*subpath* — that is exactly what an `exports` map is for.

Measured against the real published artefact: `npm pack` → install the tarball into a clean
project → `node t.mjs`:

```
### 1. CJS require of subpath
[ '__esModule', 'createStyleInjectionTransform', 'getProcessState', 'getScopedState',
  'hasRequestScope', 'registerHydrationState', 'takeHydrationStateHTML' ]

### 2. ESM import of subpath (.mjs)
  code: 'ERR_UNSUPPORTED_DIR_IMPORT',
  url: 'file:///…/node_modules/@edkimmel/react-native-web/server'

### 3. ESM named import — same ERR_UNSUPPORTED_DIR_IMPORT
```

For contrast, in the same project the **package root** imports fine from ESM
(`import { View, runInRequestScope, StyleSheet } from '@edkimmel/react-native-web'` → ok), and
so does the deep path `@edkimmel/react-native-web/dist/cjs/server/index.js`. It is only the new
subpath that fails, and it fails on the runtime its own audience is most likely to be on: a
Node SSR server with `"type": "module"`.

**Why nothing caught it.** Every usage in the repo goes through a resolver that *does*
implement directory resolution:

- `packages/streaming-ssr-e2e/app/serverEntry.js:14` — `export * as rnwServer from
  '@edkimmel/react-native-web/server'` — is bundled by esbuild before Node sees it.
- `SUSPENSE-TODO.md:1026` records the verification as:
  > Verified against the built `dist`: **`require('@edkimmel/react-native-web/server')`**
  > resolves to `dist/cjs/server/index.js`

  `require` is the one form that works. That claim is true and does not cover the form the docs
  actually teach.

**And the docs teach the failing form, five times.** `STREAMING-SSR.md:49`, `:274`, `:594`,
`:653`, `:962` and `src/server/index.js:39` all show
`import { … } from 'react-native-web/server'`. `:653` is a complete single-line example.

- **Confidence:** certain. Node 24.18.0, packed tarball `@edkimmel/react-native-web@0.21.2-edk.3`.
- **Not reproduced:** Yarn PnP, pnpm's strict layout, Vite's SSR externalisation path, webpack,
  Metro. Only esbuild was available in-tree; it resolves the subpath correctly for both
  `platform: 'node'` and `platform: 'browser'`.

---

### 2. HIGH — the missing-anchor fallback is still documented, after a full rewrite of the file (SURVIVED)

`packages/react-native-web/STREAMING-SSR.md:414-419` and `:761`

This is `ADVERSARIAL-REVIEW.md` #4, present verbatim in today's rewritten file:

> **The missing-anchor fallback.** … **Rather than drop the rules, the script creates the anchor
> itself**, ordered ascending among whatever group elements are in `<head>` …

against `src/exports/StyleSheet/index.js:322` (heading: *"The missing anchor: queue, never
create"*) and `:404-407`:

```js
// No anchor: mark the bucket pending and hand it to the runtime. See
// "The missing anchor" above — creating the element here is the one
// thing that reintroduces the hydration skew.
'else{b.p=1;}' +
```

The rewrite made it worse, not better: the same document now contradicts itself at `:582-584`
("the delta script **queues** them, and the queue is drained at sheet bootstrap, by later
chunks, by the component's own commit, and at `DOMContentLoaded`" — which is correct) and at
`:404`. `SUSPENSE-TODO.md:950` says the fallback "is **deleted**", and `SUSPENSE-TODO.md:859`
still describes it as present.

A defect that four consecutive reviews have named, and that survived a rewrite of the exact
paragraph, is worth treating as a process problem and not only a text problem.

- **Confidence:** certain.

---

### 3. MEDIUM-HIGH — the duplicate-shell warning is documented as dev-only; it is deliberately a production signal

`STREAMING-SSR.md:1074-1080`:

> `takeShellGroups()` logs a **development-only** `console.error` on the second and later shell
> within one request scope … and it is silent outside a request scope … **and in production**.

`src/exports/StyleSheet/index.js:487-501` has no `NODE_ENV` guard, and the comment directly
above it (`:466`, `:480-482`) is an explicit rebuttal:

> ## Why this reports in production too
> … The production signal is deliberately `console.error` rather than a throw — by the time this
> fires the response is usually already on the wire, and aborting a half-written document is
> worse than mis-cascading it.

The "silent outside a request scope" half of the doc claim is correct (`:490`). The dev-only
half inverts a documented design decision, and tells an operator that a production log line they
will in fact see cannot happen.

This is a *new* error: the paragraph is part of today's rewrite.

- **Confidence:** certain (source read; no `NODE_ENV` anywhere in `markShellEmitted`).

---

### 4. MEDIUM — `IStyleSheet` type-checks nothing

`src/exports/StyleSheet/index.js:811-829`

The brief asks whether `IStyleSheet` still type-checks honestly now that `Anchors` is on it. It
does not, and it did not before either — the annotation `const stylesheet: IStyleSheet =
StyleSheet;` is vacuous because `StyleSheet` is a function and Flow 0.148 treats function
statics as unsealed.

Two mutants, each run against the real `npm run flow`:

```
A: add `bogusMember: number` to IStyleSheet (StyleSheet has no such property)
   -> No errors!
B: delete `StyleSheet.Anchors = StyleSheetAnchors` and keep `Anchors: typeof StyleSheetAnchors`
   -> No errors!
```

So the one mechanical guard on the new `StyleSheet.Anchors` surface — the thing that would catch
a future refactor dropping the assignment, or the circular import resolving to `undefined` on
some toolchain — is decoration. The failure would be a runtime `undefined` component in a
consumer's `<head>`.

`gen-flow-files` does propagate the type to consumers
(`dist/exports/StyleSheet/index.js.flow:476` carries `Anchors: typeof StyleSheetAnchors`), so
consumers get a type that this repo never checks the implementation against.

- **Confidence:** certain (both mutants measured, tree restored).

---

### 5. MEDIUM — three of the new tests cannot fail for the reason they name; one production warning has zero coverage

Detail is in the test-quality section below (T1–T5). The three headline items:

- `anchor-gate-test.node.js:285-323` — *"multi-byte UTF-8 around the scan survives"*. Making
  `scanForAnchorBytes` decode-and-re-encode every buffer — literally what the test's own comment
  forbids — leaves **all 6 tests green**. Replacing the entire scan body with `sawAnchorBytes =
  true; return;` also leaves this test green. It measures Transform pass-through fidelity, not
  the scan. Its third assertion, `expect(html).not.toContain('<style')`, is a tautology:
  `takeDeltaHTML()` can only ever return a `<script>`.
- `StyleSheetAnchors-test.js:91-99` — *"the snapshot is frozen, so a re-render never moves a head
  child"*. Replacing `React.useState(() => …)` with a direct call on every render leaves **all 7
  jsdom tests and all 14 node tests green**, because the module-level `clientGroups` latch
  already memoises the read. The case `useState` uniquely covers is the un-latched one
  (`readClientGroups` only latches when `groups.length > 0`), and no test constructs it.
- `warnIfRuntimeAnchorsSkewHydration` (`StyleSheetAnchors.js:259-281`) — ~25 lines of
  user-facing `console.error` with **no coverage at all**. Inverting the gate to `if (major ===
  18) return;` → 7/7 pass. Deleting the call from the commit effect → 7/7 pass. Worse, it is
  already firing unasserted inside the suite (`StyleSheetAnchors-test.js:79` plants a
  `data-rnw-runtime` anchor and mounts the component), and because `warnedRuntimeAnchors` is a
  module-level latch with no reset hook, the first test to trip it silently suppresses it for
  every test after.

- **Confidence:** certain (all mutants run; working tree verified byte-identical afterwards).

---

### 6. MEDIUM-LOW — the `tail` fallback drops the bytes it exists to preserve

`src/modules/styleInjection/index.js:417`, `:436-439`, `:545-549`

```js
// HTML that had nowhere to go because the writable side was already ended
// or destroyed when `push()` was reached. `_flush` emits it first, so the
// bytes keep their order instead of being dropped.
let tail = '';
```

Measured: they are dropped. `Transform.end()` runs `_flush` **synchronously**, before `end()`
returns, in every arrangement I could build — including one with 200 × 4 KB chunks written
first and a `highWaterMark: 1` sink:

```
A no-backpressure   | order: _flush -> end() -> flush() | tail delta survived: false
B with-backpressure | order: _flush -> end() -> flush() | tail delta survived: false
```

(`order` is instrumented on `_flush` and on the calls themselves; `_flush` is recorded before
`end()` returns.) So by the time `push()` observes `writableEnded === true`, the only consumer
of `tail` has already run, and the assignment at `:437` is a write to a variable nothing will
read again.

**It is latent, not live.** The comment's other claim — "Unreachable on React's own call order
(trap 1), which ends the stream after the last `flush()`" — I verified directly in
`react-dom/cjs/react-dom-server.node.development.js` for **18.3.1, 19.0.0, 19.1.1 and 19.3.0**.
In all four, `flushCompletedQueues`'s `finally` is `completeWriting(destination);
flushBuffered(destination); … destination.end()` — our `flush()` always precedes our `end()`.
18.3.1:

```js
} finally {
  completeWriting(destination);
  flushBuffered(destination);
  if (request.allPendingTasks === 0 && …) { … close(destination); }
}
```

So the risk is a non-React caller, or a future React that reorders. The problem is that the code
reads as a safety net and is not one, and the mutation audit confirms no test has ever executed
either half (`tail += html` can be deleted with 138/138 still passing).

- **Confidence:** certain for the drop (measured, two arrangements); certain for the React call
  order (read in four builds).

---

### 7. MEDIUM-LOW — "bounded by the distance to the first anchor rather than paid per chunk forever" is false for a configuration the same comment declares supported

`src/modules/styleInjection/index.js:173-177` claims:

> Scanning stops for good at the first hit, so the cost is bounded by the distance to the first
> anchor rather than paid per chunk forever

Twenty-four lines later, `:197-206` ("ONE NARROWING, DELIBERATE") describes a supported caller
that writes the shell outside the transform — i.e. one for whom the marker **never arrives**. In
that case the scan runs on every chunk for the whole response, and because `anchorCarry` is
non-empty after the first chunk, `Buffer.concat([anchorCarry, bytes])` (`:300`) allocates and
copies **the entire chunk**, every chunk.

Measured over 20 000 × 4 KB writes (80 MB) through the real transform:

```
anchor present: 25.3ms | anchor NEVER present: 39.6ms | ratio: 1.57x
```

A 57 % cost on the transform's write path, plus 80 MB of allocation churn, for a caller the
comment explicitly says is supported. The gate it replaced (`hasForwardedBytes`) was O(1).

Cheap fixes exist (`indexOf` on `bytes` plus a separate `indexOf` on a 31-byte
carry+prefix window; or stop scanning once `_flush`-only delivery is inevitable), but the
reporting point is that the comment asserts a bound the code does not have.

- **Confidence:** certain (measured; the configuration is the one the source names).

---

### 8. MEDIUM-LOW — the "no-ops or return `''` outside a request scope" claim is still false (SURVIVED)

`STREAMING-SSR.md:737` — `ADVERSARIAL-REVIEW.md` #9, unchanged through today's rewrite.
Re-measured against the installed tarball:

```
takeShellHTML outside scope length: 12936
takeShellGroups outside scope groups: 6
takeDeltaHTML outside scope: ""
takeRequestDelta outside scope: ""
```

Only the two delta accessors are scope-gated, and the shell accessors must not be — the same
document depends on them working outside a scope at `:810-813`.

- **Confidence:** certain (measured).

---

### 9. LOW-MEDIUM — `REACT19-FINDINGS.md` Surface 1 documents a deleted mechanism and cites a test that does not exist

`REACT19-FINDINGS.md:225`, `:236-241`, and again at `:411-412`, `:515-516`:

> ### `RELOCATE_SCRIPT` still works under React 19's new reveal machinery. VERIFIED.
> … `RELOCATE_SCRIPT` moves them into `<head>` synchronously at parse time … The passing test
> `styleInjection/index-test.node.js › a late boundary's CSS arrives as a delta with the
> relocation script` asserts …

`grep -rn "RELOCATE_SCRIPT" packages/react-native-web/src/` → **zero hits**. The named test does
not exist; the real one is `index-test.node.js:181`, *"a late boundary's CSS arrives as a delta
**and leaves no node**"*. `STREAMING-SSR.md:393-405` correctly calls the relocation format "the
previous format".

`REACT19-FINDINGS.md:652-658` shows the author knows the convention for marking a superseded
section ("left below as written, with this note") and applies it only to the "Remaining gaps"
list. This is the same class as #2: a document rewritten today that still teaches a deleted
mechanism in the present tense.

- **Confidence:** certain.

---

### 10. LOW — `reactMajor` gates mis-classify `react@experimental` as React 18

`packages/streaming-ssr-e2e/specs/helpers.js:199-201`

```js
return Number((await reactVersion(request, baseURL)).split('.')[0]);
```

React's `experimental` dist-tag publishes as `0.0.0-experimental-<sha>-<date>` (confirmed live:
`npm view react dist-tags` → `experimental: 0.0.0-experimental-019019be-20260911`). That gives
`reactMajor === 0`, so:

| Gate | Effect on a `0.0.0-experimental-*` build |
|---|---|
| `streamingHead.spec.js:287` `skip(major >= 19)` | **does not skip** — runs the React-18 diagnosis, which asserts a shape experimental React does not produce |
| `streamingHead.spec.js:362` `skip(major >= 19)` | **does not skip** — asserts `html` contains `<div hidden id="S:0"><!DOCTYPE html>` |
| `streamingHead.spec.js:232`, `fouc.spec.js:250` `skip(major < 19)` | skips (benign) |
| `hasSuspenseAwarePreamble('0.0.0-experimental-…')` | `false` — skips the preamble spec on a build that has the preamble |

This is the same class as the bug the author just fixed (wrong granularity in a version gate),
in the opposite direction: two specs would fail rather than skip. Every other dist-tag is
classified correctly, including `19.0.0-beta-…` → 19, `19.0.0-rc.1` → 19,
`19.3.0-canary-…` → 19.

The docs do list "canary / experimental builds" under what has not been verified, and
`react-version-matrix.js` never installs one — so this is latent, not live. But
`.github/workflows/react-integration.yml` already installs `react@next` on a schedule, and the
distance from `next` to `experimental` is one word.

Beyond that, `atLeast` is sound. I ran 29 adversarial inputs
(`''`, `undefined`, `null`, `'garbage'`, `'19'`, `'19.1'`, `'19.10.0'`, `'19.01.0'`,
`'19.1.0+meta'`, `'19.1.0.0'`, `' 19.1.0 '`, `'1e2.0.0'`, `'0x13.1.0'`, `'Infinity.0.0'`,
`'-1.0.0'`, every real dist-tag): every one either classifies correctly or fails safe, and none
throws. `'19.10.0' >= '19.1.0'` is `true` (a string comparator would get this wrong).

- **Confidence:** the arithmetic is certain (measured); the resulting spec failure is by
  construction and **not reproduced** — I did not install `react@experimental` into the harness.

---

### 11. LOW — `react-version-matrix.js` never verifies that the React that *ran* is the React it installed

`packages/streaming-ssr-e2e/scripts/react-version-matrix.js`

The script exists so that "if the numbers a documentation claim cites don't come back from this
script, the claim is wrong, not the script" (`:20-22`). It does not close the loop:

- **No post-run version assertion.** It never reads `GET /env`, never re-reads
  `react/package.json` after the run, and never greps the run output for the version. The
  harness *does* honour `E2E_REACT_DIR` (I confirmed: `[e2e] listening on … (react 19.0.0)`
  with the cache dir set), so this is currently fine — but the one invariant the script's
  purpose rests on is unchecked, and it is one line (`/env` already exists and already returns
  it).
- **Cache invalidation checks only `react`'s version** (`:136-148`). `react-dom` and `scheduler`
  are checked for *existence* only (`:179-186`). I poisoned a cache dir two ways — `react@19.3.0
  + react-dom@18.3.1`, then the subtler `react@19.3.0 + react-dom@19.2.0` — and in both the
  script logged `react@19.3.0 already cached` and reused it. **Both then failed loudly** (React's
  internal cross-package coupling breaks immediately) and the script correctly reported
  `FAILED TO RUN … no Playwright summary` and exited 1. So the gap is real and currently
  un-exploitable; I could not construct a mismatch that ran green.
- **No `passed > 0` floor.** `ok: exitCode === 0 && failed === 0` (`:258`) with
  `ranAnything = passed + failed + skipped > 0` (`:224`). A run of `0 passed, 24 skipped` is
  reported green.
- `parseSummary` (`:203-211`) does not account for a `flaky` line. `playwright.config.js` sets
  `retries: 0`, so no flaky line can appear today; it becomes wrong the moment retries are
  enabled.

Things I checked and found **correct**: an install/build/run throw is caught per version and
does not abort the matrix (`:264-266`); `results.every(r => r.ok)` treats an error entry as not
ok (`ok` is `undefined`), and the script exits 1; an unparseable run is reported as
`FAILED TO RUN` rather than green; `--all` plus explicit versions is rejected;
`webServer.reuseExistingServer: false` means a stale server on the port fails loudly rather than
silently serving the wrong React.

- **Confidence:** the gaps are certain (read + two poisoning experiments); "reports green when
  something failed" is **not reproduced**.

---

### 12. LOW — a non-UTF-8 string `write()` defeats the anchor scan entirely

`src/modules/styleInjection/index.js:288-292`:

```js
if (typeof chunk === 'string') {
  // Node decodes a string `write()` into a Buffer before `_transform`
  // sees it, and React never writes strings, so this is only for a
  // caller who constructed the stream with `decodeStrings: false`.
  bytes = Buffer.from(chunk, 'utf8');
}
```

Two things. First, the branch is dead as written — the Transform is constructed without
`decodeStrings: false` (`:515-517`), so Node always hands `_transform` a Buffer. The mutation
audit confirms: replacing the body with `throw` leaves 138/138 node tests passing.

Second, the live hazard is the *other* direction — Node decodes with whatever encoding the
caller passed, and the scan assumes UTF-8 bytes. Measured, writing the anchors with
`t.write(html, 'utf16le')`:

```
utf8    | output chunks: 4 | delta in chunk # 1 | delta is LAST chunk (withheld to _flush): false
utf16le | output chunks: 4 | delta in chunk # 3 | delta is LAST chunk (withheld to _flush): true
```

The gate never opens and every delta is withheld to `_flush`. Degradation is graceful (the rules
still arrive, before the epilogue, and still insert into their anchors) but every boundary loses
its streamed CSS window. React never does this, so it needs a caller writing the head through
`injector.write(head, 'utf16le')`.

- **Confidence:** certain (measured).

---

### 13. LOW — `src/server/index.js` ships and is not covered by the `browser` field map

`packages/react-native-web/package.json` `files` includes `src`, and the `browser` map covers
only `./dist/…` and `./dist/cjs/…` paths. `npm pack --dry-run` confirms `src/server/index.js`
ships. A toolchain configured to prefer sources (some Metro / `resolver.sourceExts`
arrangements, or a monorepo alias to `src`) that reaches `src/server` gets the real
`node:stream` implementation with no stand-in.

This is the pre-existing `src`-is-unprotected hole (`ADVERSARIAL-REVIEW.md` API section) with a
new entry point added to it, and the new entry point is precisely the one the docblock says
makes the constraint "structural rather than conditional" (`src/server/index.js:20-27`). It is
structural only for `dist`.

- **Confidence:** certain (file list from `npm pack`; browser map read). **Not reproduced** — I
  did not build a Metro/source-preferring bundle.

---

### 14. LOW — three overstatements

- **`STREAMING-SSR.md:84-86` / `REACT19-FINDINGS.md:106-108`**: "the string 'preamble' does not
  occur in 19.0.x's server build at all", from which "so this is not a rename — the concept is
  absent" is inferred. `grep -oi preamble` on 19.0.8's
  `react-dom-server.node.development.js` → 8 hits (`flushStyleInPreamble`, `flushStylesInPreamble`,
  `PREAMBLE`). The *lowercase* string is indeed absent (0 hits), so the sentence is defensible
  as written and the inference is not. The **conclusion is correct** and I verified the floor
  independently by installing both versions from npm:

  ```
  19.0.8: preparePreamble=0  completedPreambleSegments=0
  19.1.0: preparePreamble=13 completedPreambleSegments=11
  ```

  So `SUSPENSE_AWARE_PREAMBLE = '19.1.0'` (`helpers.js:245`) is right.
- **`REACT19-FINDINGS.md:68`** marks "Doc comment cited a 2048-byte Fizz view (4096 on React 19)"
  as *"FIXED — comment corrected"*. `src/modules/styleInjection/index.js:156-157` still reads
  "The view is 2048 bytes on React 18 and 4096 on React 19", which is wrong for 19.0.0, 19.1.1
  and 19.2.0 — as the same document establishes 12 lines later.
- **`helpers.js:230-238` and `REACT19-FINDINGS.md:92-104`** cite 19.0.8 and 19.1.0 installs
  ("installed for the purpose") that do not exist anywhere in the tree;
  `.react-version-cache/` holds exactly `18.3.1 19.0.0 19.1.1 19.2.0 19.3.0`, and
  `DEFAULT_VERSIONS` (`react-version-matrix.js:66`) cannot produce them. The 19.1.0 row is the
  **sole** direct evidence for the floor (19.1.1 is the earliest reproducible version), and it
  carries none of the "not reproducible" marking the same document applies to its jsdom figures.
  I reinstalled both from npm and the rows hold — but the docs should not have claimed a
  reproducible provenance they do not have.

---

## SUSPECTED

### S1. `hasEmittedShell()` is still a process-lifetime-blind boolean per request, and the new gate does not change that

`emitDelta`'s conjunction is `sawAnchorBytes && StyleSheet.hasEmittedShell()`. `sawAnchorBytes`
is per-transform, `hasEmittedShell()` is per-request-scope. A caller who creates two transforms
inside one `runInRequestScope` (a retried render, an ESI-style composition) gets the second
transform scanning for an anchor while `hasEmittedShell()` is already true from the first — so
the second transform withholds until `_flush` even though the first already emitted. I could not
build a realistic caller that does this; the documented usage is one transform per scope.

### S2. The false-positive analysis does not consider a marker in the *prelude* path's own output

With `prelude != null` the scan is skipped entirely (`:531`), which is correct. With
`prelude == null`, the only bytes that reach `_transform` are React's and any the caller writes.
I traced every emission point: the delta, the epilogue and the tail all go out through
`push()` with `forwarding === true`, i.e. straight onto the readable side, so none is ever
scanned. I could not find a path where the transform's own output opens its own gate. Stated
here only because the comment's argument for it (`:188-192`) is "a delta cannot be emitted until
the gate is already open", which is true but does not cover the epilogue or the `_flush`-exempt
final delta; the *code* covers those, the *argument* does not.

### S3. `warnIfRuntimeAnchorsSkewHydration`'s `major !== 18` is right today but fails open

The brief asked me to challenge this. I agree with the author's conclusion and can add evidence:
I ran `streamingHead.spec.js` against **React 19.0.0** and the anchors-in-the-boundary test
(`:221`) passes, with runtime anchors present — so 19.0 does skip the foreign node and the
warning would be noise there. The floor is a 19.0 change, not a 19.1 change, and `reactMajor` is
the right granularity.

What I would still change: `major !== 18` means every future major is silent, and
`parseInt('0.0.0-experimental-…')` is `0`, also silent. A React 20 that tightened hydration
again, or an experimental build, gets no warning. `major < 19` fails closed instead and costs
nothing. Not a defect today — an assumption about the future written as a fact.

### S4. `_flush` has no guard against `push()` being reached with `forwarding === false`

`_flush` sets `forwarding = true` in a `try`, and the `finally` clears it (`:543-555`). If
`epilogue` or the delta serialisation throws inside that block, the `finally` restores
`forwarding = false` and the exception propagates out of `_flush` without calling `callback()` —
the stream neither finishes nor errors cleanly. `takeDeltaHTML` and a string concat are both
hard to make throw, so this is theoretical, but the whole `_flush` body is unguarded and its
`callback()` is outside the `try`.

---

## SURFACES I TRIED HARD TO BREAK AND COULD NOT

Stated specifically, with what was run.

### A. The CRITICAL ordering fix is intact under real backpressure. Measured, on two Reacts.

Real `renderToPipeableStream`, real `http.createServer`, real socket, a client reading N bytes
every M ms, no `prelude`, `<StyleSheet.Anchors />` rendered by React into `<head>`. Chunked
transfer-encoding decoded before analysis. Stream state captured at the instant React's
`flush()` runs.

```
REAL 18.3.1, text-heavy, 1.75MB, client 2048b/60ms
  deltaScripts 15 | between-elements 15 | inside-text 0 | INSIDE-A-TAG 0
  flushes 26 | flushesAtOrAboveHWM 12 | maxReadableAtFlush 67054 | maxWritableQueuedAtFlush 44

REAL 18.3.1, attribute-heavy, 2.91MB, client 1024b/25ms
  deltaScripts  4 | between-elements  4 | inside-text 0 | INSIDE-A-TAG 0
  flushes 25 | flushesAtOrAboveHWM 21 | maxReadableAtFlush 67329 | maxWritableQueuedAtFlush 58

REAL 19.3.0, text-heavy, 1.75MB, client 2048b/60ms
  deltaScripts  9 | between-elements  9 | inside-text 0 | INSIDE-A-TAG 0
  flushes 20 | flushesAtOrAboveHWM 16 | maxReadableAtFlush 68340 | maxWritableQueuedAtFlush 23
```

Up to **58 React chunks parked on the writable side** at the moment a delta is emitted, and
every delta still lands on an element boundary.

**Negative control**, same load, one line of the built transform changed
(`if (forwarding)` → `if (true)`, i.e. always `stream.push()`):

```
MUTANT 18.3.1, attribute-heavy, 2.91MB, client 1024b/25ms
  deltaScripts 9 | between-elements 7 | INSIDE-A-TAG 2
    ..."efghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz\" data-k2=\"a"<script>...
    ..."wxyz\" data-k2=\"abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrs"<script>...
```

The probe is capable of seeing the regression; the real transform does not have it. `push()`'s
discipline — `stream.push()` only under `forwarding`, `originalWrite` otherwise — survived the
S1 change intact. Also confirmed: `emitDelta` is reached only from `flush()` and `_flush`, and
`scanForAnchorBytes` runs *before* `callback(null, chunk)` but that is safe, because the chunk
still reaches the readable side ahead of any delta that the flag then permits (the delta enters
through the writable queue behind it).

### B. The 15-byte carry-over is correct at every offset, and does not alias

Driving the real transform (`Transform.write` + `flush()` per chunk), with the shell already
emitted so only `sawAnchorBytes` decides. "mid-stream" means the delta appeared before the last
markup byte, not merely somewhere in the output:

```
split@1 … split@15                 mid-stream delta: TRUE  (all 15)
3-way (data- | rnw-g | roup=")     mid-stream delta: TRUE
one byte at a time                 mid-stream delta: TRUE
aliased view, split@9              mid-stream delta: TRUE
no marker anywhere                 mid-stream delta: false, delta still present at end: TRUE
false positive in page text        mid-stream delta: TRUE (== the old behaviour, as documented)
```

`ANCHOR_CARRY_MAX = ANCHOR_MARKER.length - 1` is exactly right: a partial prefix of a 16-byte
marker is at most 15 bytes, so it always fits, however many chunks it is spread across. The
"aliased view" case constructs what the comment worries about — a single backing buffer the
writer overwrites after each `write()` — and the gate still opens, so the carry really is copied
(`Buffer.from(haystack)` / `Buffer.from(haystack.subarray(…))`). The mutation audit independently
killed a 14-byte carry, a dropped-carry variant, and a `subarray(0, MAX)` (head instead of tail)
variant.

The false positive costs exactly the old behaviour and nothing more: `hasEmittedShell()` is still
a required conjunct, so no amount of matching page text can drain a delta before a shell exists.
I could not find anything a false positive makes *worse*.

### C. The `StyleSheet` ⇄ `StyleSheetAnchors` cycle resolves in every order I could construct

On the **real build** (`dist` current with `src`; `find src -newer dist/cjs/index.js` → empty):

```
index-first   | typeof StyleSheet: function | StyleSheet.Anchors: function | same module: true
anchors-first | typeof StyleSheet: function | StyleSheet.Anchors: function | same module: true
barrel-first  | typeof StyleSheet: function | StyleSheet.Anchors: function | same module: true
server-first  | typeof StyleSheet: function | StyleSheet.Anchors: function | same module: true

ESM (dist/, via esbuild) index-first   | Anchors: function | same: true
ESM (dist/, via esbuild) anchors-first | Anchors: function | same: true
bundled CJS (dist/cjs/, via esbuild) anchors-first | Anchors: function | same: true
```

The mechanism is as the author says, but **not in the module they name**. The comment at
`src/exports/StyleSheet/index.js:796-801` says "Babel hoists a default-exported function
declaration above the requires"; the built `dist/cjs/exports/StyleSheet/index.js` does **not**
hoist — it ends with `var _default = exports.default = stylesheet; module.exports =
exports.default;`. What saves the cycle is the hoist in the *other* file:
`dist/cjs/exports/StyleSheet/StyleSheetAnchors.js` line 5 is `exports.default =
StyleSheetAnchors;`, above every `require`. The claim happens to be true of the module that
matters; the sentence points at the wrong one. (Not filed as a finding — it is a comment
imprecision, not a defect.)

`babel-plugin-add-module-exports` behaves as claimed: `require('…/exports/StyleSheet')` returns
the function with no `.default`, and `StyleSheet` *is* in
`packages/babel-plugin-react-native-web/src/moduleMap.js:43`, so the plugin deep-imports it.

### D. The `browser` field map still protects `createStyleInjectionTransform`; the new entry does not route around it

esbuild, `platform: 'browser'`, against the installed tarball:

```
bundle of '@edkimmel/react-native-web/server'  -> 579 bytes, contains the throwing stand-in only
bundle of '@edkimmel/react-native-web' (barrel) -> 309246 bytes, zero `node:stream` references
```

The single `node:stream` occurrence in the 579-byte bundle is inside the stand-in's own error
message. And the barrel really did stop pulling the stand-in in — the claim in
`src/server/index.js:19-27` holds for esbuild.

### E. `npm pack` ships everything the subpath needs

```
server/package.json
dist/server/index.js, dist/server/index.js.flow
dist/cjs/server/index.js
src/server/index.js
both browser stand-ins for styleInjection and asyncContext
```

912 files, 784 KB packed. Nothing missing.

### F. The old spellings are gone, and the moved names fail the right way

From the installed tarball: `require('@edkimmel/react-native-web').createStyleInjectionTransform`
→ `undefined`; `.StyleSheetAnchors` → `undefined`; `.runInRequestScope` → `function`;
`.StyleSheet.Anchors` → `function`. From **ESM**, `import { createStyleInjectionTransform } from
'@edkimmel/react-native-web'` and `import { StyleSheetAnchors } from …` both throw a real
`SyntaxError` at link time rather than binding `undefined` — so an ESM consumer gets a loud
failure and a CJS consumer gets a silent `undefined`. That asymmetry is inherent to CJS and is
the best available answer.

### G. `_flush` still behaves

```
1 epilogue is last: true | final delta before epilogue: true
3 flushes forwarded to two destinations: a=2 b=2
4 after destroy(): epilogue present: false   (inherent to destroy, as previously noted)
5 with a prelude, deltas stream mid-response: true   (the scan is correctly skipped)
```

The downstream-`flush()`-throws guard and the `unpipe` listener bookkeeping added after the last
review are both present and correct (`:587-604`, `:619-628`).

### H. The React version floor is real

Installed `react-dom@19.0.8` and `react-dom@19.1.0` from npm (neither is in the tree, contra the
docs):

```
19.0.8: preparePreamble=0  completedPreambleSegments=0
19.1.0: preparePreamble=13 completedPreambleSegments=11
```

`SUSPENSE_AWARE_PREAMBLE = '19.1.0'` is correct, and the split of gates between
`hasSuspenseAwarePreamble` (the boundary-above-`<head>` shape) and `reactMajor` (the
foreign-node-skipping shape) is the right classification for every gate in the two spec files. I
checked each one against what it actually keys on and found no second instance of the
major-for-a-minor bug — the only mis-gate is #10, which is a different mechanism.

---

## Test quality

The mutation audit ran 27 tests across the three new files against targeted mutants of the exact
behaviour each names. **25 die. 2 do not.** These files are materially stronger than the material
`ADVERSARIAL-REVIEW.md` T1–T7 covered — in particular the `SENTINEL` device in
`anchor-gate-test.node.js` is precisely the "record *where* the push happened" discipline T1
asked for, and it works.

### T1. `anchor-gate-test.node.js:285-323` cannot fail for the reason it names

Covered in #5. Three mutants prove it: making the scan decode-and-re-encode (**the thing the
test's comment forbids**) → 6/6 pass; replacing the scan body with `sawAnchorBytes = true;
return;` → the test still passes (1 and 6 fail); corrupting the *forwarding* path → this is the
only test that fails. It measures pass-through fidelity, not the scan. Its
`expect(html).not.toContain('<style')` is a tautology.

### T2. `anchor-gate-test.node.js:351-477` — the real-Fizz backpressure test — has no sentinel

Its only ordering assertion is `expect(deltaAt).toBeGreaterThan(anchorAt)`. Rewriting the gate so
a delta can *only* ever come out of `_flush` leaves it passing, because an end-of-stream delta is
trivially after the anchors. It does kill the primary mutant (dropping `sawAnchorBytes` from the
conjunction), so it is not vacuous — but it is the one test driven by real
`renderToPipeableStream` under real backpressure, and it is the only one of the six that drops
the sentinel the other five use.

### T3. `StyleSheetAnchors-test.js:91-99` — "the snapshot is frozen" survives deleting the freeze

Covered in #5. Removing `React.useState` leaves all 21 tests green, because the module-level
`clientGroups` latch already memoises. The un-latched path (`readClientGroups` only latches a
non-empty read, so a client-only page re-reads every render) is the case `useState` uniquely
covers and no test constructs it.

### T4. `warnIfRuntimeAnchorsSkewHydration` has zero coverage and its once-latch is burned inside the suite

Covered in #5. Inverting the React-major gate → 7/7 pass. Deleting the call → 7/7 pass. And
`StyleSheetAnchors-test.js:79` already trips the warning for real, unasserted, which silently
suppresses it for every later test because `warnedRuntimeAnchors` is a module-level latch with
no reset hook.

### T5. Coverage holes in the new tests

| Scenario | Covered |
|---|---|
| Backpressure | **Yes** — `anchor-gate-test.node.js:351-477`, `highWaterMark: 1`, with a vacuity guard. This closes the previous review's T6 hole. |
| Marker split at every offset | **Yes** — the one-byte-at-a-time loop exercises carry lengths 1→15 and the trim branch, and kills three separate carry mutants. Stronger than a per-offset test. |
| False-positive marker in page content | **Yes** — and it is the only test that kills "drop `hasEmittedShell()`". |
| String chunk (`decodeStrings: false`) | **No — dead code.** Replacing the branch body with `throw` → 138/138 pass. |
| Non-`Buffer` `Uint8Array` chunk | **No — dead code.** Same. |
| Carry copies rather than aliases | **No.** Turning both `Buffer.from(…)` copies into views survives 138/138, despite the source comment calling the copy load-bearing. (I verified the invariant holds by construction in probe B; it is simply not guarded by a test.) |
| `_flush` with a non-empty `tail` | **No — dead code**, and see finding #6: deleting `tail += html` leaves 138/138 passing, and the path is broken anyway. |
| `<StyleSheet.Anchors>` hydrated (`hydrateRoot` against server anchors) | **No.** Its own docblock says hydration byte-equality is the entire point. Still absent in both new files. |
| `<StyleSheet.Anchors>` into a real `<head>` through the transform | Partly — test 6 renders it through the transform but into a `<div>`. The real shape is only covered by Playwright, which CI does not run. |
| Multiple destinations | Not in the new files, but covered by `backpressure-ordering-test.node.js`. |

### What is good, and worth saying

`StyleSheetAnchors-test.node.js` is the strongest file in the change set: all 14 tests die to
targeted mutants, and the `useId` retry-vs-second-instance discriminator is pinned from **both**
directions by two mutants that each fail exactly one test. `props are applied to every anchor`
uses `html.match(…).length === orderedGroups.length` rather than the `toContain` pattern the
previous review complained about. No test in any of the three files mocks away its subject, and
there is no dead `if` containing an assertion.

### Still not in CI

`.github/workflows/tests.yml` runs `format`, `flow`, `lint`, `unit` — and nothing else.
`packages/streaming-ssr-e2e` is still not a workspace, still matched by neither jest config, and
still absent from CI, including the new `e2e:matrix` scripts. It remains the only place
`hydrateRoot(document, …)`, `<StyleSheet.Anchors>`-in-`<head>` and the whole React version
matrix are exercised. `@playwright/test` and `esbuild` were added to the **root** devDependencies
(both declare `engines.node >= 18`; CI pins `node-version: 16`), so every CI job now installs
them and no job uses them.

---

## What I did not cover

- **Only esbuild.** Every bundler claim (resolution of the subpath, the `browser` map, the
  import cycle under scope hoisting) was tested with esbuild 0.28.2, the only bundler in the
  tree. webpack, Vite/rollup, Metro, Parcel, Yarn PnP and pnpm's strict layout are all
  unverified, and the `"browser": "../dist/server/index.js"` escape-the-directory main field is
  the most likely place one of them differs.
- **No TypeScript consumer check.** The package ships Flow types only; nothing changed there,
  and I did not evaluate what a TS consumer sees for `react-native-web/server`.
- **`react@experimental` was not installed.** Finding #10's spec failures are established by the
  gate arithmetic (`reactMajor('0.0.0-experimental-…') === 0`, measured) and by reading the two
  gates, not by a run.
- **No full matrix run.** Per the brief I ran three single-version suites (18.3.1, 19.0.0,
  19.3.0). 19.1.1 and 19.2.0 were not run; their rows in the docs are unverified by me.
- **No real-browser verification of anything in this review.** Everything in #A–#G is Node,
  jsdom or `renderToPipeableStream`.
- **`repro/`, `PRIOR-ART.md` and the bulk of `SUSPENSE-TODO.md`** were read only where a claim
  under review pointed into them.
- **Firefox / WebKit, CSP enforcement, Web Streams, concurrent load** — unchanged from the
  previous review's list, and still untested.
- **I could not construct a matrix run that reports green while something failed.** Both cache
  poisonings I built failed loudly. The gap in #11 is real as a missing check, not as a
  demonstrated false green.
