# React 19 compatibility investigation

Investigated 2026-09-10 against **react@19.3.0 / react-dom@19.3.0** (plus spot checks
against 19.0.0, 19.1.1, 19.2.0), installed into an isolated scratch directory. No repo
`node_modules`, `package.json`, source file or test was modified. Everything below marked
"VERIFIED" was executed; everything marked "NOT VERIFIED" was not.

Scratch tree used (all configs, probes and raw logs live there):

```
/private/tmp/claude-502/-Users-eddie-kimmel-Documents-GitHub-react-native-web/
  01ecd315-b32a-4390-87e4-cef6dd4f5332/scratchpad/
    react19/          react 19.3.0 + jest configs + probe tests
    r19.0.0/ r19.1.1/ r19.2.0/   version-bisect installs
    base-node2.txt base-dom2.txt      React 18.3.1 baselines
    r19-node3.txt r19-node4.txt r19-dom2.txt   React 19 runs
```

**Reproducibility note.** The scratch tree above lived under `/private/tmp`,
was never checked in, and no longer exists — so the Node/jsdom figures in this
file (the "Test results" table below) cannot be rerun as they stand and
should be read as a historical record, not a reproducible claim. The
real-browser slice of this same investigation *is* reproducible today:
`packages/streaming-ssr-e2e/scripts/react-version-matrix.js` installs a given
React version into a checked-in, scripted cache and reruns the Playwright
suite against it (`npm run e2e:matrix -- <version>` from
`packages/streaming-ssr-e2e/`). Current, rerunnable numbers — **all five
versions green**, 32 specs:

| React | passed | skipped | failed |
|---|---|---|---|
| 18.3.1 | 28 | 4 | 0 |
| 19.0.0 | 29 | 3 | 0 |
| 19.1.1 | 29 | 3 | 0 |
| 19.2.0 | 29 | 3 | 0 |
| 19.3.0 | 29 | 3 | 0 |

The runner now also reads the React that actually *ran* back out of the run
output and prints it beside the version it installed (`React 19.3.0 (ran as
19.3.0)`). That was the one invariant every number here rested on and did not
check, so these rows are stronger than the ones they replace, not just newer.
Skips are deliberate complements: each is gated off on a version that does not
have the shape, and each has a sibling spec asserting what that version does
instead.

See `packages/react-native-web/STREAMING-SSR.md#real-browser-coverage`.

**Correction, 2026-09-11.** An earlier version of this note recorded 19.0.0 as
failing one spec and excluded it from the supported set. That was a bug in the
harness's own gating, not in 19.0.0: `specs/streamingHead.spec.js` gated the
boundary-above-`<head>` shape on `reactMajor >= 19`, but the shape needs
Fizz's Suspense-aware preamble, which shipped in **19.1.0**. The gate now asks
`hasSuspenseAwarePreamble(version)`. See
[the 19.1 boundary](#the-191-boundary-verified-2026-09-11) below for the
evidence, and the table above for the post-fix numbers.

---

## Verdict

**Yes.** After the changes described below, both suites pass on **18.3.1, 19.0.0, 19.1.1,
19.2.0 and 19.3.0** (historical — see the reproducibility note above; these installs no
longer exist). The fork's runtime design needed no rework — the two assumptions it is
built on both survived React 19 — but it did have one genuine behavioural bug, now fixed.
The claim that *is* rerunnable today is the real-browser suite, and it passes on all five:
18.3.1, 19.0.0, 19.1.1, 19.2.0 and 19.3.0 (see the reproducibility note).

Status of everything found:

| # | Finding | Status |
|---|---|---|
| 1 | React >= 19.1 withholds every byte until a top-level `<Suspense>` resolves, so the prelude and shell CSS were never emitted | **FIXED** — `start()` now also runs from React's `flush()` |
| 2 | `fakeTimers.enableGlobally` hangs every streaming test under React 19 | **FIXED** — `doNotFake: ['queueMicrotask']` |
| 3 | `ScrollView` test uses `findDOMNode`, removed in React 19 | **FIXED** — test-only |
| 4 | `AppRegistry` inline element snapshot breaks on React 19's element brand | **FIXED** — test-only, replaced with structural assertions |
| 5 | Doc comment cited a 2048-byte Fizz view (4096 on React 19) | **NOT FIXED** — see below |
| 6 | Document-level hydration with a relocated `<head>` | **NOT VERIFIED** — see "Remaining gaps" |
| 7 | `precedence` stylesheets hoist above the RNW anchors | **BY DESIGN, needs docs** — text under "For the docs" |

Item 5 was marked FIXED here for a while and is not.
`src/modules/styleInjection/index.js:166-167` still reads "The view is 2048
bytes on React 18 and 4096 on React 19", which the correction 15 lines below
contradicts: `VIEW_SIZE` / `new Uint8Array(…)` is **2048 in 18.3.1, 19.0.0,
19.0.8, 19.1.0, 19.1.1 and 19.2.0, and 4096 only from 19.3.0** (re-grepped
2026-09-11 across the cached installs). Nothing in the transform depends on the
number, so this is a wrong comment rather than a wrong behaviour — but the
status column said the opposite of the tree.

The two assumptions that held, unchanged:

* React 19 does **not** hoist, dedupe or reorder the `<style data-rnw-group>` anchors, and
  does **not** hoist a plain `<style>` out of a streamed Suspense chunk. VERIFIED.
* Fizz still guarantees a clean element boundary at `completeWriting()` + `flushBuffered()`
  → `destination.flush()` in the `finally` of `flushCompletedQueues()`. VERIFIED, same
  place, same shape, in both the dev and production Node builds. Only the buffer size
  changed: **2048 -> 4096 bytes**, which the transform never depended on.
  **Corrected 2026-09-11:** that change is a *19.3.0* change, not a React 19 change.
  `currentView = new Uint8Array(…)` is 2048 in 18.3.1, 19.0.0, 19.1.1 and 19.2.0, and
  4096 only in 19.3.0. Re-verified by grepping each cached install's
  `react-dom/cjs/react-dom-server.node.development.js`. The original measurement was
  taken against 19.3.0 and over-generalised to "React 19".

---

## <a id="the-191-boundary-verified-2026-09-11"></a>The 19.1 boundary — VERIFIED 2026-09-11

The support-relevant fact this whole file circles, stated once and checked directly.

**Fizz's Suspense-aware preamble shipped in React 19.1.0.** VERIFIED. Re-measured
2026-09-11 against seven npm installs: the five that
`packages/streaming-ssr-e2e/scripts/react-version-matrix.js` caches, plus 19.0.8 and
19.1.0, which are the two rows that carry the argument. Those two are not in
`DEFAULT_VERSIONS`, so reproduce them explicitly:
`node scripts/react-version-matrix.js 19.0.8 19.1.0` from `packages/streaming-ssr-e2e/`
installs each into `node_modules/.react-version-cache/<version>/`, which is where the
counts below were taken from.

| react-dom | `preparePreamble` | `completedPreambleSegments` | lowercase `preamble` | any case |
|---|---|---|---|---|
| 18.3.1 | 0 | 0 | 0 | 0 |
| 19.0.0 | 0 | 0 | **0** | 8 |
| 19.0.8 (last of the 19.0 line) | 0 | 0 | **0** | 8 |
| **19.1.0** | 13 | 12 | 66 | 166 |
| 19.1.1 | 13 | 12 | 66 | 166 |
| 19.2.0 | 13 | 13 | 64 | 165 |
| 19.3.0 | 13 | 13 | 82 | 162 |

All counts are `grep -o` occurrences (not matching lines — an earlier version of this
table counted lines, which is why its `completedPreambleSegments` column ran one lower)
over `cjs/react-dom-server.node.development.js`.

Read the last two columns carefully, because the earlier phrasing here overstated them.
The *lowercase* string `preamble` does not occur in a 19.0.x server build at all.
Case-insensitively there are eight occurrences, and every one of them belongs to React
19.0's stylesheet-resource code rather than to Fizz's document preamble:
`flushStyleInPreamble` (2), `flushStylesInPreamble` (2) and a `PREAMBLE = 2`
insertion-state constant (4) used to mark a hoisted `<link rel="stylesheet">` as already
flushed. Nothing named there participates in writing `<!doctype html>` or the `<html>` /
`<head>` open tags. So the conclusion is unchanged and now rests on what the hits *are*
rather than on their absence: this is not a rename, the mechanism is absent.

**What 19.0.x does instead, for a Suspense boundary above `<html>`/`<head>`.** VERIFIED
both in source and in the bytes. In 19.0.0's `flushCompletedQueues` the preamble is
written from `renderState.htmlChunks` / `renderState.headChunks`, which are populated when
`<html>` / `<head>` *render*. With the boundary above them the completed root segment is
written first, both are still `null`, and the doctype and the `<html>`/`<head>` open tags
are therefore never written at all. Measured against the e2e harness's own
`/streaming-head?delay=600&headDelay=200&above=1` route under react-dom@19.0.0:

```
<!DOCTYPE   0 occurrences
<html       0            </html>   1
<head       0            </head>   1
<body       1            </body>   1
```

— a response with closing tags and nothing opening them. React 18.3.1 on the same route
fails differently: it emits the boundary placeholder first and then streams the resolved
document, `<!doctype html><html>` and all, nested inside `<div hidden id="S:0">`.

**Scope of the floor, and a correction to how it was described.** The floor applies to a
boundary **above** `<html>`/`<head>`, and to nothing else. A boundary *inside* `<head>`
works on 18.3.1 and 19.0.0 as well as 19.1+ — measured: `/streaming-head?…&anchors=shell`
under 19.0.0 returns a well-formed `<!DOCTYPE html><html …><head>…` with a `<!--$?-->`
pending marker in `<head>`, and the corresponding spec passes on every version in the
matrix. So "Suspense in or above `<head>` needs 19.1" would be too broad; only "above" does.

Both preamble-less failure modes are now pinned by their own tests in
`packages/streaming-ssr-e2e/specs/streamingHead.spec.js`, and the gate for the supported
shape asks `hasSuspenseAwarePreamble(version)` (`specs/helpers.js`) rather than
`reactMajor >= 19`.

---

## Test results

All numbers below are **after** the changes in "What changed". Both suites are run from the
repo's own configs; React 19 is swapped in with nothing but a `moduleNameMapper` overlay.
**Historical:** the scratch installs behind this table no longer exist and there is no
checked-in script that reproduces it — see the reproducibility note at the top of this file.

| React | node suite | jsdom suite |
|---|---|---|
| 18.3.1 (installed) | 13 suites / 83 tests pass | 56 suites / 770 pass, 6 skipped |
| 19.0.0 | 13 / 83 pass | 56 / 770 pass, 6 skipped |
| 19.1.1 | 13 / 83 pass | 56 / 770 pass, 6 skipped |
| 19.2.0 | 13 / 83 pass | 56 / 770 pass, 6 skipped |
| 19.3.0 | 13 / 83 pass | 56 / 770 pass, 6 skipped |

Gates under the installed React 18.3.1, all green: `flow check` (0 errors), `prettier
--check` (clean), `eslint packages` (exit 0), `jest --config configs/jest.config.node.js`,
`jest --config configs/jest.config.js`.

### Where it started

For the record, the same runs before the fixes:

* **jsdom**, React 19.3.0: 1 failure —
  `ScrollView/index-test.js:33` `TypeError: (0 , _reactDom.findDOMNode) is not a function`.
* **node**, React 19.3.0, config as-is: **11 failures in 51.5 s** — 8 of them
  `styleInjection/index-test.node.js` tests timing out at 5000 ms each.
* **node**, React 19.3.0, with `queueMicrotask` unfaked: 3 failures — the AppRegistry
  element snapshot, plus `nonce reaches the shell…` and `concurrent requests each receive
  their own late rules`, both of which pass `<Suspense>` as the root element and so hit the
  19.1 preamble behaviour.

---

## Surface 1 — `StyleSheet/index.js`: `takeShellGroups` / `takeShellHTML` / `takeDeltaHTML` / `RELOCATE_SCRIPT`

### React 19 does not touch a plain `<style>`. VERIFIED.

Rendering `getStyleElements()` into `<head>` of a full document via
`renderToStaticMarkup` under React 19.3.0 produced exactly the input order, empty anchors
included, with no dedupe and no attribute rewriting:

```html
<html lang="en"><head><meta charSet="utf-8"/>
<style data-rnw-group="0">…</style>
<style data-rnw-group="1">…</style>
<style data-rnw-group="2">.r-display-xoduu5{display:inline-flex;}</style>
<style data-rnw-group="2.1"></style>
<style data-rnw-group="2.2"></style>
<style data-rnw-group="3">…</style>
</head><body><div id="root">hi</div></body></html>
```

Two empty anchors (`2.1`, `2.2`) with identical (empty) content both survived — React 19
did not collapse them. That is the property the whole relocation scheme rests on.

A `<style data-rnw-group="9" data-rnw-delta="1">` rendered *inside a late Suspense
boundary* also stayed exactly where it was rendered, inside React's hidden completion div:

```html
…<div hidden id="S:0"><div id="late">
  <style data-rnw-group="9" data-rnw-delta="1">.late{color:red}</style>
  <span>late</span></div></div>…
```

### The `precedence` trap the design comment describes is real, and worse than the comment implies. VERIFIED.

For contrast, a `<style precedence="x" href="k">` rendered from `<body>`:

```html
<head><meta charSet="utf-8"/>
  <style data-precedence="x" data-href="k">.p{}</style>   <-- hoisted here
  <style data-rnw-group="0">.a{}</style>
</head><body><div>body</div></body>
```

React hoists it to the **front** of `<head>`, above every group anchor. So the comment
above `takeShellHTML` is vindicated, and there is a corollary worth writing down: any
consumer app that adopts React 19's `precedence` stylesheets gets them placed *above* all
RNW group anchors, meaning RNW's atomic rules will win over the app's stylesheet regardless
of intent. That is a consumer-facing caveat, not a fork bug.

### `RELOCATE_SCRIPT` still works under React 19's new reveal machinery. VERIFIED *at the time*.

> **Superseded 2026-09-11 — this section verifies a mechanism that no longer exists.**
> `RELOCATE_SCRIPT`, and the relocating `<style data-rnw-delta>` delta format it belonged
> to, have been deleted: `grep -rn RELOCATE_SCRIPT packages/react-native-web/src/` returns
> **zero hits**. A delta is now a single self-removing inline `<script>` that calls
> `insertRule` on the group anchor's own `CSSStyleSheet` and leaves no DOM node behind, so
> there is no element to relocate and no node for the reveal path to collide with. See
> `packages/react-native-web/STREAMING-SSR.md` § "How it works", which calls relocation
> "the previous format". Left below as written, with this note, because the React 19
> reveal-machinery facts it records are still accurate and are part of why the replacement
> format is safe — and because the test it cites was mis-named (corrected in place below).

React 19 replaced the `$RC` inline script. It now emits, right after the shell:

```html
<script id="_R_">requestAnimationFrame(function(){$RT=performance.now()});</script>
```

and defers the boundary reveal through `$RB`/`$RV` with a `requestAnimationFrame` /
`setTimeout(..., $RT+300-now)` throttle. This does not interact with relocation: the delta
`<style>` elements are injected by the transform at top level of `<body>` (never between a
boundary's `<!--$?-->` / `<!--/$-->` markers), `RELOCATE_SCRIPT` moved them into `<head>`
synchronously at parse time, and `$RV` only walks the node range between the boundary
comments.

**Test citation corrected 2026-09-11.** This paragraph used to cite a passing test in
`styleInjection/index-test.node.js` named *"a late boundary's CSS arrives as a delta with
the relocation script"*. No test has ever had that name. The real one is
`index-test.node.js › a late boundary's CSS arrives as a delta and leaves no node`
(`index-test.node.js:181`), and it asserts the stronger property the current format has —
no `<style>` element anywhere in the parsed document, not merely none left in `<body>` —
after parsing with `runScripts: 'dangerously'`.

One knock-on for the *test harness only*: React 19's `$RC`/`$RV` call
`requestAnimationFrame`, which jsdom does not define unless `pretendToBeVisual: true`. The
node test's `new JSDOM(html, { runScripts: 'dangerously' })` therefore logs
`ReferenceError: requestAnimationFrame is not defined` to `console.error` on every parse.
Harmless today (nothing asserts on console), noisy, and it would break the moment someone
adds a "no console errors" guard.

---

## Surface 2 — `modules/styleInjection/index.js`: the Fizz flush contract

### The contract holds. VERIFIED by reading both builds.

`<scratch>/react19/node_modules/react-dom/cjs/react-dom-server.node.development.js`:

* **189–191** — `function flushBuffered(destination) { "function" === typeof destination.flush && destination.flush(); }`
* **192–249** — `writeChunk`, buffering into `currentView` with the threshold now **4096**
  (React 18.3.1 had `var VIEW_SIZE = 2048;` at line 89 of the same file in the repo's
  `node_modules`).
* **261–267** — `function completeWriting(destination)` — drains `currentView.subarray(0, writtenBytes)`, nulls the view.
* **8773** — `function flushCompletedQueues(request, destination)`; **8774** re-initialises
  `currentView = new Uint8Array(4096)` at the top of every pass.
* **9126–9150** — the `finally`. Both arms end the same way:
  * close arm, **9139–9140**: `completeWriting(destination), flushBuffered(destination),` then `destination.end()`
  * normal arm, **9149**: `: (completeWriting(destination), flushBuffered(destination));`

Production build `react-dom-server.node.production.js`: `flushBuffered` at **47–48**, 4096
threshold at **56 ff.**, `completeWriting` at **122**, and the same `finally` tail at
**7453**.

React 18.3.1 for comparison (repo `node_modules/react-dom/cjs/react-dom-server.node.development.js`):
`flushBuffered` 80–87, `VIEW_SIZE = 2048` at 89, `completeWriting` 209,
`flushCompletedQueues` 6867, `completeWriting` + `flushBuffered` at 6960–6961.

So: same primitive, same call site, same semantics; only the constant moved. The doc
comment in `styleInjection/index.js` (lines 121–133) should have its "2048-byte view"
updated to "2048 bytes on React 18, 4096 on React 19", but the reasoning and the code are
unaffected.

**Also verified empirically**, outside jest, that a `Transform` exposing a public `flush()`
still receives React 19's end-of-pass signal and that the `pipe`-forwarding trick works:

```
r19 19.3.0  injector: "<div>hello</div><!--F--><!--END-->"
```

(`<!--F-->` is pushed from the transform's `flush()`, `<!--END-->` from `_flush`.)

### PROBLEM: React ≥ 19.1 withholds the first byte when a Suspense boundary is at the top level of the root. VERIFIED.

This is the one real behavioural regression. `createStyleInjectionTransform` calls `start()`
— which calls `prelude(StyleSheet.takeShellHTML())` — from `_transform`, i.e. on React's
first `write()`. React 19.1+ can delay that indefinitely.

Bisect (identical harness, `<Suspense>` resolving after a 10 ms timer, first-`write()`
timestamps):

| root shape | 18.3.1 | 19.0.0 | 19.1.1 | 19.2.0 | 19.3.0 |
|---|---|---|---|---|---|
| `<div><Suspense/></div>` | 3 ms | 4 ms | 3 ms | 3 ms | 4 ms |
| `<Suspense/>` as root | 0 ms | 0 ms | **11 ms** | **12 ms** | **11 ms** |
| `<html><head/><body>…<Suspense/>…</body></html>` | 0 ms | 0 ms | 0 ms | 1 ms | 0 ms |

Further shapes on 19.3.0 (18.3.1 flushes all of them immediately):

| root shape | first byte | output |
|---|---|---|
| `[<div>x</div>, <Suspense/>]` | **16 ms** | `<div>x</div><!--$--><div>late</div><!--/$-->` |
| `<>{<Suspense/>}</>` | **10 ms** | `<!--$--><div>late</div><!--/$-->` |
| `<div>hdr<Suspense/></div>` | 0 ms | fallback streamed, then `$RC` |
| `<div><Suspense/><p>tail</p></div>` | 0 ms | fallback streamed, then `$RC` |

The rule: if the walk from the root segment reaches a *pending* Suspense boundary without
first passing through a host element, React holds everything. Any host element in between
stops it.

Mechanism, from the 19.3.0 dev build:

* **8472–8489** `preparePreamble` → `preparePreambleFromSegment` walks the completed root
  segment looking for `<html>` / `<head>` / `<body>`. If it hits a pending boundary it
  returns `hasPendingPreambles = true`, and unless `preamble.headChunks && preamble.bodyChunks`
  are already known it leaves `request.completedPreambleSegments === null`.
* **8783–8784** in `flushCompletedQueues`:
  `var completedPreambleSegments = request.completedPreambleSegments; if (null === completedPreambleSegments) return;`

React is waiting to find out whether `<html>`/`<head>` are going to come out of the
boundary. This is React 19.1's "Suspense-aware preamble"; 19.0.0 predates it.

End-to-end confirmation with the fork's own transform, React 19.3.0
(scratch probe, in the vanished scratch tree: react19/dbg/__tests__/rootshape-test.node.js):

```
ROOT-SUSPENSE    has delta: false | late rule in head: true
WRAPPED-IN-VIEW  has delta: true  | late rule in head: false
```

Consequences, in order of severity:

* **TTFB / streaming is lost.** Nothing — not even the doctype — reaches the client until
  the top-level boundary resolves.
* **`takeShellHTML()` fires late.** Because the shell is serialised at first-byte time, it
  now contains rules the boundary compiled, and the delta channel is empty. The rendered
  document is still correct (right groups, right order, ahead of body markup); it is just
  not streamed.
* **The `!started` guard in `emitDelta()` becomes load-bearing under React 19 and it
  works.** React calls `destination.flush()` twice at t≈1 ms with zero bytes written; the
  guard correctly suppresses a delta that would otherwise land ahead of the doctype.
  VERIFIED (`shell-timing.js` shows `React flush() at t=1ms` twice before the first write).
* Two existing tests fail purely because they use `<Suspense>` as the root element.

### PROBLEM: fake timers. VERIFIED.

`configs/jest.config.node.js:10-12` sets `fakeTimers: { enableGlobally: true }`. React 19
binds the microtask scheduler once, at module evaluation:

* dev build **9472**: `scheduleMicrotask = queueMicrotask,`
* dev build **9152–9155**: `function startWork(request) { request.flushScheduled = …; scheduleMicrotask(function () { return requestStorage.run(request, performWork, request); }); …`
* prod build **46** and **7458**: same.

React 18.3.1 had no such capture — it only used `function scheduleWork(callback) { setImmediate(callback); }`
(dev build lines 76–78), resolving the global at call time, which is why
`jest.useRealTimers()` was enough.

ES imports are hoisted above the `jest.useRealTimers()` at the top of
`styleInjection/index-test.node.js:33`, so under React 19 the module captures Sinon's fake
`queueMicrotask`; `useRealTimers()` restores the global but not the captured binding, and
`performWork` is never scheduled. Reduced to a 12-line probe with no RNW code at all:

```
FAIL probe-test.node.js  ✕ plain pipeable stream finishes (5004 ms)
     thrown: "Exceeded timeout of 5000 ms for a test."
```

and with `fakeTimers: { enableGlobally: true, doNotFake: ['queueMicrotask'] }`:

```
PASS probe-test.node.js  ✓ plain pipeable stream finishes (4 ms)
```

The TRAP comment at `styleInjection/index-test.node.js:11-15` names `setImmediate`; under
React 19 `queueMicrotask` joins it, and `jest.useRealTimers()` is no longer a sufficient
remedy for it.

---

## Surface 3 — `StyleSheet/dom/index.js` (`detectMode`) and `dom/ingestDelta.js`

**No React 19 problem found.** VERIFIED to the extent below.

`detectMode` keys off exactly two things: `rootNode.querySelector('style[data-rnw-group]')`
and `rootNode.getElementById('react-native-stylesheet')`. Everything React 19 puts into
`<head>` on its own was enumerated from real renders:

* `<link rel="preload" as="script" fetchPriority="low" href="…">` for `bootstrapScripts`
  (new in 19; React 18 emitted only the `<script async>`),
* hoisted `<title>` / `<meta>` / `<link>`,
* `<style data-precedence="…" data-href="…">` and `<link rel="stylesheet" data-precedence>`
  for `precedence`-tagged resources.

None carries `data-rnw-group`, and none carries `id="react-native-stylesheet"`, so neither
branch of `detectMode` can be tripped and the dev-mode "both formats" throw cannot
false-positive. React 19's `<script id="_R_">requestAnimationFrame…</script>` goes into
`<body>`, not `<head>`.

The whole jsdom suite — including `dom-mode-test`, `dom-delta-hydration-test`,
`dom-group-anchor-order-test`, `dom-ingestDelta-test` and `streamed-hydration-test` —
passes unchanged on React 19.

**NOT VERIFIED** *at the time*; the shape no longer exists and the surviving question is
now covered by `specs/document.spec.js` — see "Remaining gaps". As written: hydration of
the *document element* (`hydrateRoot(document, …)`) with a React-rendered `<head>` that
`RELOCATE_SCRIPT` has mutated by moving delta `<style>` elements into it. I did not build that test. React 19 is generally tolerant of unrecognised
`<head>` children, and the fork's normal flow writes `<head>` from the transform's
`prelude` (so React never owns it), but if a consumer renders the whole document through
React this is the one place I would expect a hydration warning. Worth an explicit test
before claiming support.

---

## Surface 4 — `AppRegistry/getStyleElements.js`

**No React 19 problem found.** VERIFIED — see Surface 1: the keyed array of
`<style data-rnw-group>` elements renders in order, keeps its empty anchors, and is neither
hoisted nor deduped, under both `renderToStaticMarkup` and `renderToPipeableStream`.
`packages/react-native-web/src/exports/AppRegistry/__tests__/getStyleElements-test.node.js`
passes on React 19.

The adjacent `AppRegistry/index-test.node.js` failure is a serializer artefact, not a
behaviour change:

```
- <AppContainer rootTag={{}}><NoopComponent /></AppContainer>
+ { "$$typeof": Symbol(react.transitional.element), "type": { "$$typeof": Symbol(react.forward_ref), … } }
```

React 19 changed the element brand from `Symbol.for('react.element')` to
`Symbol.for('react.transitional.element')`. `pretty-format@29.7.0`'s ReactElement plugin
delegates to `ReactIs.isElement`, and the hoisted `react-is` in this repo is **17.0.2**,
which only knows the old symbol — so the element falls through to the generic object
serializer. VERIFIED by inspecting
`node_modules/jest-snapshot/node_modules/pretty-format/build/plugins/ReactElement.js` and
`node_modules/react-is/package.json`. Affects only this one inline snapshot; the 215 DOM
snapshots in the jsdom suite go through the DOMElement plugin and are unaffected.

---

## Other checks

* `grep -rn "from 'react-dom" packages/react-native-web/src` (excluding tests) →
  `Modal/ModalPortal.js` (`createPortal`), `exports/render/index.js`
  (`createRoot`/`hydrateRoot` from `react-dom/client`), and a doc comment. All React 19
  compatible. No `ReactDOM.render`, no `ReactDOM.hydrate`, no `findDOMNode`, no
  `react-dom/test-utils` in shipped code. VERIFIED.
* `exports/unmountComponentAtNode/index.js` calls `rootTag.unmount()` on a root object, not
  the removed `ReactDOM.unmountComponentAtNode`. VERIFIED.
* `react-dom@19`'s export map resolves `./server` → `./server.node.js` under the `node`
  condition, and the bare `server.js` shim also re-exports `./server.node`, so the
  `moduleNameMapper` shortcut used here matches what a real Node consumer gets. VERIFIED.
* `.defaultProps` appears only as `forwardedProps.defaultProps` (an internal prop-allowlist
  table in `View`/`Text`/`TextInput`), not as `Component.defaultProps` on a function
  component, so React 19's removal of function-component `defaultProps` does not apply.
  VERIFIED by grep.
* `modules/styleInjection/index.browser.js` only throws; nothing to check.
* **NOT VERIFIED:** the Web Streams path (`renderToReadableStream`). The fork ships no Web
  Streams adapter (`index.browser.js` throws and tells the caller to drive
  `takeShellHTML()`/`takeDeltaHTML()` by hand), so there is nothing in-tree to test, but
  note that the Edge/Browser Fizz builds have no `destination.flush()` equivalent at all —
  a hand-rolled Web Streams adapter cannot reuse the trick documented in
  `styleInjection/index.js`.
* **NOT VERIFIED:** anything in a real browser. Everything here is Node + jsdom.
* **NOT VERIFIED:** React 19 canary / experimental builds, and React 19.4+.

---

## What changed

Five files. No runtime behaviour changes on React 18 — verified by the full gate set and by
the before/after matrix below.

### 1. `packages/react-native-web/src/modules/styleInjection/index.js` — the P1 fix

`start()` now runs from React's public `flush()` as well as from `_transform`:

```js
(stream: any).flush = function flush() {
  start();
  emitDelta();
  …
};
```

`start()` was already idempotent through `started`, so this is a one-line change plus a new
trap 5 in the module doc comment explaining the 19.1 preamble mechanism, why `_transform`
alone is insufficient, why `flush()` alone is insufficient (`_flush` still has to cover a
stream that never gets one), and why the ordering is unaffected on every version.

Why ordering is safe, confirmed against the source: inside that `finally`,
`completeWriting()` — which calls `destination.write()` — runs **before**
`flushBuffered()`. Any pass that produced bytes has therefore already been through
`_transform` and emitted the prelude by the time our `flush()` runs, so `start()` there is a
no-op and the delta it drains is empty (`takeShellHTML()` resets the watermark
synchronously). `start()` only does work on a pass that wrote nothing — exactly the case
being rescued.

`start()` is called **before** `emitDelta()`, not after. That order is load-bearing: a delta
drained first would steal rules the shell owns and put `<style>` elements ahead of the
doctype. There is a test for it.

**One accepted degradation, VERIFIED by reading `flushCompletedQueues`:** a caller who
calls `pipe()` *before* `onShellReady` (rather than from it, as the module's usage example
shows) will now get `flush()` — and therefore `takeShellHTML()` — while the shell render is
still compiling, because the `finally` runs even when the `pendingRootTasks > 0` guard skips
the whole `try` body. The shell is then serialised early and whatever the shell render
compiles afterwards arrives in the first delta, relocating into `<head>` behind the right
anchor like any other. Output stays correct; the first delta is just larger. Previously that
caller got a complete shell. This is documented in trap 5.

### 2. `configs/jest.config.node.js` — `doNotFake: ['queueMicrotask']`

With a comment explaining that React 19 binds `scheduleMicrotask = queueMicrotask` at module
evaluation, that `import` hoisting means the module captures the fake before any
`jest.useRealTimers()` can run, and that the captured binding is unreachable afterwards.

**The jsdom config deliberately did not need this**, and was left alone. VERIFIED: React
18's *client* build captures `queueMicrotask` the same way
(`react-dom.development.js:11008`), so nothing changed there, and that suite passes on all
five versions untouched.

### 3. `packages/react-native-web/src/modules/styleInjection/__tests__/prelude-ordering-test.node.js` — new

Four tests that drive the transform through explicit `write`/`flush` interleavings, standing
in for React, and pin: the prelude is emitted exactly once, before any React byte, whether
the first signal is a write or a zero-byte flush; a leading zero-byte flush does not drain a
delta ahead of the shell; and a stream that only ever flushes is still a whole document.

The file header states plainly that the installed React 18.3.1 cannot provoke the real
failure, names the 19.1 mechanism (`preparePreamble` /
`request.completedPreambleSegments` / the early `return` in `flushCompletedQueues`), and
says which interleaving corresponds to which React version and root shape.

**VERIFIED that it earns its keep:** with `start()` removed from `flush()`, the first test
fails and the other three still pass.

### 4. `packages/react-native-web/src/exports/ScrollView/__tests__/index-test.js`

Dropped the `findDOMNode` import and call. `ref.current` is already the host node — the
sibling test `node has imperative methods` asserts `node.tagName === 'DIV'`, and
`findDOMNode` returns a DOM node unchanged — so the call was a passthrough and the
assertion tests exactly what it tested before: that the scroll listener is on the node the
ref points at.

### 5. `packages/react-native-web/src/exports/AppRegistry/__tests__/index-test.node.js`

Replaced the inline element snapshot with structural assertions on `element.type`,
`element.type.displayName`, `element.props.rootTag`, `element.props.WrapperComponent` and
`element.props.children.type` — the same facts, without going through pretty-format's
`react-is` version check. The adjacent string snapshot of `getStyleElement()` is untouched.

Preferred over adding a `react-is@19` override: an override changes the resolved tree for
everyone and needs an install to take effect, whereas this is version-proof in both
directions and is the assertion the test actually wanted.

---

## Cross-version evidence for the P1 fix

Harness: the fork's own `createStyleInjectionTransform` with a `prelude`/`epilogue`, a
`<Suspense>` boundary resolving on a 30 ms timer, piped from `onShellReady`. `prelude
before boundary` records whether the doctype reached the sink before the boundary's promise
settled; `late rule` records whether the boundary's compiled CSS arrived as a delta or was
folded into the shell. Two root shapes: the boundary as the root element, and the boundary
wrapped in a `<View>`.

**Before the fix:**

| React | root `<Suspense>` | wrapped in `<View>` |
|---|---|---|
| 18.3.1 | prelude first, rule in delta | prelude first, rule in delta |
| 19.0.0 | prelude first, rule in delta | prelude first, rule in delta |
| 19.1.1 | **prelude withheld, rule in shell, no delta** | prelude first, rule in delta |
| 19.2.0 | **prelude withheld, rule in shell, no delta** | prelude first, rule in delta |
| 19.3.0 | **prelude withheld, rule in shell, no delta** | prelude first, rule in delta |

**After the fix:**

| React | root `<Suspense>` | wrapped in `<View>` |
|---|---|---|
| 18.3.1 | prelude first, rule in delta | prelude first, rule in delta |
| 19.0.0 | prelude first, rule in delta | prelude first, rule in delta |
| 19.1.1 | prelude first, rule in delta | prelude first, rule in delta |
| 19.2.0 | prelude first, rule in delta | prelude first, rule in delta |
| 19.3.0 | prelude first, rule in delta | prelude first, rule in delta |

Every cell also asserts the response is well formed: starts with the doctype, ends with the
epilogue, and contains exactly one doctype. The two tables were produced by the same
harness, differing only in whether `start()` is called from `flush()`.

The raw first-byte timings that led to the diagnosis, same harness without the transform
(10 ms boundary):

| root shape | 18.3.1 | 19.0.0 | 19.1.1 | 19.2.0 | 19.3.0 |
|---|---|---|---|---|---|
| `<div><Suspense/></div>` | 3 ms | 4 ms | 3 ms | 3 ms | 4 ms |
| `<Suspense/>` as root | 0 ms | 0 ms | **11 ms** | **12 ms** | **11 ms** |
| `[<div/>, <Suspense/>]` | 1 ms | — | — | — | **16 ms** |
| `<>{<Suspense/>}</>` | 1 ms | — | — | — | **10 ms** |
| `<html>…<Suspense/>…</html>` | 0 ms | 0 ms | 0 ms | 1 ms | 0 ms |

---

## For the docs

`STREAMING-SSR.md` is owned elsewhere; this is the text to route into it. **All of it is
now landed there** — the "React version support", "real-browser coverage" and
`<StyleSheet.Anchors />` sections.

**On React 19 support.** The package is tested against React 18.3.1 and React 19.0 through
19.3, on both the Node streaming path and the client. No application change is required to
move between them, with one floor: a Suspense boundary **above** `<html>`/`<head>` needs
**React >= 19.1** (see [the 19.1 boundary](#the-191-boundary-verified-2026-09-11)). (The
Node/jsdom 5-version figure is historical — the installs behind it no longer exist. What
is reproducible today is the real-browser matrix on all five of 18.3.1, 19.0.0, 19.1.1,
19.2.0 and 19.3.0, via `packages/streaming-ssr-e2e/scripts/react-version-matrix.js`. See
`STREAMING-SSR.md#real-browser-coverage`.)

**On React 19 stylesheet resources (`precedence`).** React 19 can hoist a
`<style precedence="…">` or `<link rel="stylesheet" precedence="…">` out of your tree and
into `<head>`. VERIFIED: it places them at the *front* of `<head>`, above every
`data-rnw-group` anchor. Anything you load that way therefore sits below react-native-web's
atomic rules in the cascade, whatever its specificity, and RNW styles will win. If you need
your own stylesheet to beat RNW's, emit it after the RNW anchors yourself rather than
through `precedence`, or raise its specificity deliberately. This is also the reason RNW's
grouped format does not use `precedence` for its own groups: React places a bucket it has
not seen before at the wrong end of `<head>`, and so does `@layer`.

**On root-level Suspense (React >= 19.1).** No longer a correctness constraint — the
transform handles it — but worth knowing: React 19.1 made Fizz's preamble Suspense-aware,
so if the element you pass to `renderToPipeableStream` has a `<Suspense>` at the top level
(the root itself, or a Fragment or array with one as a direct child), React writes nothing
at all until that boundary resolves. `createStyleInjectionTransform` still gets your
document head onto the wire immediately, but React's own markup — including the boundary's
fallback — will not stream. Putting any host element above the outermost boundary restores
full streaming. This is React behaviour, not an RNW constraint.

---

## Remaining gaps

Honest list of what is still not verified.

**Items 1 and 2 have since been CLOSED** by the Playwright harness
(`packages/streaming-ssr-e2e/`), which was built after this section was written:
`document.spec.js` covers `hydrateRoot(document, …)` over a React-rendered `<head>` that
streamed chunks have written into, reading React's own `__reactFiber$` back-pointers, and
`fouc.spec.js` audits every painted frame — React 19's `$RB`/`$RV` reveal path included —
with a negative control. Both run on all five versions in the matrix. They are left below
as written, with this note, so the original honesty split stays legible.

1. **Document-level hydration.** NOT VERIFIED *at the time*; now covered — see the note
   above. I did not build a test that calls
   `hydrateRoot(document, …)` on a document whose React-rendered `<head>` has been mutated
   by `RELOCATE_SCRIPT` moving delta `<style>` elements into it. The fork's normal flow
   writes `<head>` from the transform's `prelude`, so React never owns it and the question
   does not arise; it only matters for a consumer who renders the whole document through
   React. This is the one place I would still expect a surprise.
2. **Real browsers.** NOT VERIFIED *at the time*; now covered — see the note above.
   Everything in this file is Node plus jsdom. In particular
   React 19's new reveal path (`$RB`/`$RV`, `requestAnimationFrame`, and the
   `setTimeout($RV, $RT+300-now)` throttle) was read and reasoned about, and the relocation
   script demonstrably runs before it in jsdom, but no real paint was observed.
3. **Web Streams.** NOT VERIFIED, and structurally out of reach: the fork ships no
   `renderToReadableStream` adapter (`index.browser.js` throws), and the Edge/Browser Fizz
   builds have no `destination.flush()` equivalent at all, so the boundary trick documented
   in `styleInjection/index.js` cannot be reused there. Anyone writing such an adapter needs
   a different mechanism.
4. **React 19.4+ and canary/experimental builds.** NOT VERIFIED. Note that the preamble
   behaviour already differs between 19.0.0 and 19.1.0, so "React 19" is not a single
   target; the peer range `^19.0.0` now spans two Fizz behaviours that this package handles,
   but future minors could add a third. This is exactly the split that
   [the 19.1 boundary](#the-191-boundary-verified-2026-09-11) turns into a stated support
   floor, and it is the reason a spec gate that means ">= 19.1" must not be written as
   `major >= 19`.
5. **`jest-environment-jsdom` and `requestAnimationFrame`.** React 19's `$RC`/`$RV` scripts
   call `requestAnimationFrame`, which the `new JSDOM(html, { runScripts: 'dangerously' })`
   in `styleInjection/index-test.node.js:122` does not provide. Under React 19 this logs a
   `ReferenceError` to `console.error` on every parse. Harmless today — nothing asserts on
   console output, and the suite passes — but it would break the moment someone adds a
   "no console errors" guard. Left alone because changing it has no effect on the installed
   React 18 and I did not want to churn a test I was not otherwise touching. The fix is
   `pretendToBeVisual: true` on that JSDOM.
