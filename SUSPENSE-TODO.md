# Suspense / streaming-SSR support — remaining work

Untracked working file. Not for commit.

Baseline as of 2026-09-10 (`master` @ b2e94fb6, tree clean, `feat/streaming-ssr-css-and-request-scoping` identical):

- 157 tests pass — 13 jsdom suites (`configs/jest.config.js`) + 8 node suites (`configs/jest.config.node.js`)
- `flow check --flowconfig-name ./configs/.flowconfig` → 0 errors
- `eslint configs packages scripts --config ./configs/.eslintrc` → clean

## Status — all findings resolved

| # | Finding | Status |
|---|---|---|
| 1 | No streaming adapter | Resolved — `createStyleInjectionTransform()` |
| 2 | No documentation | Resolved — `STREAMING-SSR.md` |
| 3 | No React-level test | Resolved — server + client halves |
| 4 | Shell payload growth | Resolved — measured, design kept |
| 5 | React 19 unvalidated | Resolved — validated, one regression fixed |
| 6 | Only Dimensions was scoped | Resolved — `Appearance` too |
| 7 | Legacy-only AppRegistry SSR | Resolved — `getStyleElements()` |
| 7a | Shell string round-trip | Resolved — `takeShellGroups()` |
| 8 | Group-anchor insertion order | Resolved (reworked once after review) |
| 9 | Duplicate shell inverts cascade | Resolved — dev warning |
| 10 | Web-Streams rationale unrecorded | Resolved — written into source |
| 11 | Restore timing under progressive hydration | Resolved — documented guidance |
| 12 | `Dimensions` restore did not notify | Resolved — found while writing #11 |
| 13 | Hooks capture device state per-component, not per-hydration | Resolved — raised by the user |
| 14 | `AccessibilityInfo` is not request-scoped | **Withdrawn** — out of scope for the library |
| 15 | Nothing has run in a real browser | Resolved — Playwright harness, 13 specs |
| 16 | `hydrateRoot(document)` skews `<head>` fiber bindings | Resolved — no DOM node emitted at all |
| 17 | Suspense inside/above `<head>` is unsupported | Resolved — `<StyleSheet.Anchors />`, React-owned anchors |

Findings 9–12 were discovered during the work, not in the original review.

### Adversarial review (`ADVERSARIAL-REVIEW.md`)

A hostile review of the whole change set found **16 confirmed defects + 4 suspected**, the headline one
critical. All fixed except where noted.

**#1 CRITICAL — the transform spliced `<script>` into the middle of React's tags under backpressure.**
`flush()` emitted its delta with `stream.push()`, straight onto the Transform's *readable* side, while
React's already-accepted `write()` chunks sat unprocessed on the *writable* side. Once the readable buffer
hits `readableHighWaterMark`, `Transform._write` parks the callback in `kCallback` and every subsequent
delta jumps the whole queue. Reproduced with real `renderToPipeableStream`: a 2.26MB response gave
`data-k1="abcde<script>(function(){...` — inside an attribute of an open tag, with React driving every
byte. Three distinct corruptions confirmed (reordering, text-node splitting, in-tag), the variant decided
by where the 2048/4096-byte view boundary lands.

**Fixed by sending injected bytes through the same door React's go through.** Not a barrier or a counter:
`push()` is used only when already inside `_transform`/`_flush` — which *are* the ordering point — and
`originalWrite` otherwise, so a delta queued at `flush()` sits behind everything React has written. FIFO
does the rest. Verified: `als3.js` 4 spliced → **0**, ORDER now a clean `P0 P1 D P2 D … P39 D`; real-React
attribute-heavy 1 in-tag → `{"between-elements":12}`. New `backpressure-ordering-test.node.js` fails 5 of
6 against the pre-fix source.

*I was wrong about this twice and it is worth recording why.* I first doubted the finding because my own
probes wrote **one chunk per flush**, where ordering cannot break — Fizz writes several views per pass and
flushes once. Then I wrongly downgraded the "vacuous test" claim, because my mutant kept `emitDelta()` in
`flush()` and was near a no-op; the real mutant removes it, and the **entire 17-test suite passed against
the forbidden implementation**. Both errors were reasoning about stream behaviour instead of measuring it
under load. Earlier in the session I had also reviewed this exact code and asserted reordering was
impossible because `_transform` calls back synchronously — which ignores `kCallback` parking.

Other fixes of note: two `<StyleSheet.Anchors/>` no longer duplicate anchors silently (`useId` distinguishes
a Fizz retry from a second instance); the duplicate-shell report now fires in production, and only the
first shell moves the watermark so a rule compiled between two shells still reaches the *first* anchor;
`AccessibilityInfo`/`Appearance` listener collapse fixed (the WeakMap now maps a handler to an array of
adapters — note the `Appearance` case was **upstream's bug, not a fork regression**); delta handles are now
process-wide with a random prefix so composed documents (ESI, micro-frontends) cannot collide;
U+2028/U+2029 escaped in `takeHydrationStateHTML`; `npm test` green again.

**S4 — the emitted chunk script had no outer `try`/`catch`** (fixed by me). The reachable thrower is
`__RNW_INGEST_DELTA__`; a throw there skipped `removeChild` and stranded the `<script>` in the DOM — in a
React-rendered `<head>`, precisely the foreign-sibling shape this whole format exists to avoid. The script
would have traded a bookkeeping failure for the corruption it was designed to prevent. Body is now
`try`/`catch` with the self-removal in `finally`; rules are inserted and queued *before* the hook, so
swallowing costs only bookkeeping. `delta-script-robustness-test.js` proves it (1 stranded node without).

**S1's residual — now closed.** `hasEmittedShell()` means "the anchors rendered", not "the anchors are on
the wire", and the cheap half (also require *some* bytes forwarded) only ruled out the zero-byte passes.
The fix stops asking `StyleSheet` a question it cannot answer and **observes the stream instead**: with no
`prelude`, `_transform` scans the bytes it forwards for `data-rnw-group="` — the same attribute the
streamed chunk's own `querySelector` uses to find its anchor, so it is already load-bearing on the client
and needs no new marker — carrying `marker.length - 1` bytes across chunk boundaries (Fizz's view splits
land mid-attribute routinely) and stopping for good at the first hit. The gate now reads literally "a shell
was serialised **and** an anchor's bytes have been through this transform".

**Reproduced with real React, not just modelled.** `styleInjection/__tests__/anchor-gate-test.node.js`, 6
tests: four hand-driven in Fizz's own pass shape, one negative control, and one real
`renderToPipeableStream` under induced backpressure — two Suspense boundaries throwing the *same* promise
so `performWork` completes both into one `completedBoundaries` pass, the first ~400 KB so
`destination.write()` returns false and `flushCompletedQueues` returns before writing the second, whose
content is `<StyleSheet.Anchors/>` plus a component that compiles a rule after it. `finally` still calls
`flushBuffered` → our `flush()`. Against the pre-fix gate the delta lands at byte 389,498 and the anchors
at 389,828 — the delta ahead of its anchor, on a real render. Both S1 tests fail against the pre-fix
source; a no-carry-over mutant and a drop-`hasEmittedShell()` mutant are each killed by one further test.

Cost of a false positive is bounded by design: page content that happens to contain the literal opens the
gate early, which is exactly the old behaviour (rules queue as pending), and `hasEmittedShell()` is still
required alongside it so no amount of matching text can drain a delta — the *whole cumulative sheet* —
before a shell exists. The emitted delta `<script>` contains the literal too, and cannot open the gate,
because a delta is never emitted until the gate is already open.

One deliberate narrowing, with no in-tree caller: omitting `prelude` *and* writing the shell somewhere the
transform never sees it (`res.write()` ahead of `injector.pipe(res)`) leaves no anchor bytes in this
stream, so deltas are withheld to `_flush` instead of streaming. They all still arrive, in order, before
the epilogue; `injector.write(head)` or a `prelude` restores streaming. Worth a sentence in
`STREAMING-SSR.md` next to "Omit `prelude` if you would rather write the document head yourself".

The API-coherence recommendations are now **landed** — see [API coherence](#api-coherence-landed) at the
end of this file. Finding 13 was raised by the user after it, and supersedes part of #11.

Final gate run: node **18 suites / 138 passed**, jsdom **65 suites / 836 passed / 6 skipped**,
`flow check` **0 errors**, eslint clean, prettier clean, `npm test` exit 0. Nothing committed — the whole
change set is working-tree only.

**Known, deliberate asymmetry: the emitted script covers the hooks and nothing else.** `getServerValue` is
consulted from exactly one place per device module — its `getServerSnapshot` — so
`window.__RNW_HYDRATION__` landing in the document does not redirect `Dimensions.get()` or
`Appearance.getColorScheme()`, which keep returning the live client value. Leaving the live value alone is
what lets React reconcile to it in a passive effect after hydration, and that is what retired #11;
forcing it from the wire would reinstate the problem. Consequence a consumer must know: a component
reading `Dimensions.get('window').width` directly in render, rather than through `useWindowDimensions`,
is not covered by the emitter alone and still wants `unstable_setForHydration`. Pinned by
`hydrationState/__tests__/imperativeReaders-test.js` so the asymmetry cannot be "fixed" silently, and
documented on the `unstable_setForHydration` entry.

Companion file: `REACT19-FINDINGS.md` (untracked) holds the full React 19 investigation with its
VERIFIED / NOT VERIFIED split.

---

## Verified working

A throwaway probe (`renderToPipeableStream` + a real Suspense boundary + a `Writable` sink) confirmed the
core mechanism end-to-end:

- the `AsyncLocalStorage` request scope **survives into the stream's write callbacks**, so
  `hasRequestScope()` is true at chunk boundaries;
- `takeDeltaHTML()` at the post-shell chunk returned exactly the boundary's new rule
  (`.r-marginTop-1kqmjzq`, group 3) and nothing else.

That was the main open design risk. It is not a problem. Everything below is integration and packaging.

---

## Findings

### 1. No adapter — nothing in the repo calls `takeShellHTML` / `takeDeltaHTML`

Every consumer has to hand-roll the Writable/Transform that injects the shell before `</head>` and a
delta at each chunk boundary, and know to wrap the whole `renderToPipeableStream` call in
`runInRequestScope`. This is the one thing standing between "it works" and "someone else can use it".

**Shipped** as `createStyleInjectionTransform()` in new `packages/react-native-web/src/modules/styleInjection/`
(`index.js` + `index.browser.js`, mirroring the `asyncContext` Node/browser split), exported from
`src/index.js`. `package.json` gained the two matching `browser` field mappings — mandatory, or the browser
bundle resolves `node:stream`.

```js
createStyleInjectionTransform(options?: {
  prelude?: ?(shellHTML: string) => string,  // returns everything before React's first byte
  epilogue?: ?string,
  nonce?: ?string
}): stream.Transform
```

`prelude` is a *function of* the shell rather than a string, so the caller cannot take the shell at the
wrong moment: `takeShellHTML()` is only serialisable at one instant — after the shell render finished
compiling CSS, before any body byte is on the wire — and only the transform knows when that is.

**The important discovery: my original premise was wrong, and so was the brief I wrote.** I had assumed
React writes one complete HTML unit per `write()`, which my early probe appeared to confirm — that was an
artifact of a render small enough to fit one view. It does not. Fizz encodes into a 2048-byte
`currentView` (`VIEW_SIZE = 2048`) and flushes whenever it fills, so a single `destination.write()`
routinely ends mid-tag; appending after each chunk yields `<di<style>…</style>v>`. I verified this in
`node_modules/react-dom/cjs/react-dom-server.node.development.js` myself.

What React *does* guarantee is `completeWriting(destination)` then `flushBuffered(destination)` in the
`finally` of every `flushCompletedQueues()` pass (lines 6959–6961). `flushBuffered` calls
`destination.flush()` if present — React's own "safe to put on the wire" signal, the one Express
compression middleware hooks. So the transform exposes a public `flush()` and injects **only** there,
never from `_transform`. Test: a 400-row boundary produces many writes but ≤2 delta elements, every row
intact on jsdom re-parse.

Consequence handled: React calling *our* `flush()` means it no longer reaches a downstream gzip `res`,
which would buffer the whole response and silently kill streaming. `pipe` is overridden to remember
destinations and forward the flush, with `unpipe` cleanup.

Other traps handled: `_flush` takes one final delta before the epilogue; chunks are never decoded
(`callback(null, chunk)` forwards the original `Uint8Array`, injected HTML is its own Buffer) with a
4000-byte multi-byte regression test asserting no U+FFFD; no request scope degrades to pass-through with a
one-time dev warning; a delta can never precede the shell; backpressure is preserved by forwarding through
the callback rather than `push`.

**Web-Streams variant deliberately skipped** — not build friction but a correctness gap. The Node
destination contract hands us an exact clean-boundary signal; `renderToReadableStream` has no equivalent, so
a `TransformStream` could only guess, and guessing wrong splices `<style>` into the middle of a `<script>`.
The honest edge story is for the framework to call `takeShellHTML`/`takeDeltaHTML` from its own boundary
hooks. Recorded as a known limitation.

Also added `flow-typed/node_stream.js` (Flow 0.148 does not know `node:`-prefixed builtins; mirrors the
existing `node_async_hooks.js`).

- Status: **RESOLVED**

### 2. No documentation

README is 6 changelog bullets. Nothing documents `takeShellHTML`, `takeDeltaHTML`, `runInRequestScope`,
`configureRequestScope` (required on workerd/Deno/Bun or it throws in dev), or
`Dimensions.unstable_setForHydration`.

Related: `takeRequestDelta` / `resetRequestDelta` are a second, marker-delimited public API with zero
consumers. Decision: **keep and document** (they are already in the published `IStyleSheet` type;
removing is a breaking change for `@edkimmel/react-native-web` consumers).

**Done.** New `packages/react-native-web/STREAMING-SSR.md` (740 lines), linked from a rewritten fork
section in `README.md`; everything below that section is untouched upstream content. Structure: React
version support → end-to-end example (server + client) → how it works → per-request scoping → the adapter
→ the lower-level CSS API → AppRegistry SSR → per-request device state → gotchas → known limitations.

Leads with the complete working example, because that is what people copy. Every documented signature was
grepped against source; all 11 code blocks parse under `@babel/parser` with the jsx + flow plugins.

Deliberately undocumented, and right to leave out: the wire details (`data-rnw-group`, `data-rnw-delta`,
`window.__RNW_DELTA__`, `__RNW_INGEST_DELTA__`, `installDeltaIngest`, `createStyleFormatGuard`). The source
declares the emitted HTML opaque to adapters and free to change; the guide explains the mechanism but tells
callers to treat the string as an inert blob rather than promoting those names to API.

- Status: **RESOLVED**

### 3. No React-level test

All streaming tests hand-assemble HTML. `dom-mode-test.js:112` gets closest but builds the
post-relocation `<head>` by hand.

**Server half done** as part of #1: `modules/styleInjection/__tests__/index-test.node.js` is 11 tests
against real `renderToPipeableStream` with a real async Suspense boundary, replacing the throwaway probe.
(Gotcha worth remembering: the node jest config sets `fakeTimers.enableGlobally`, which fakes
`setImmediate` — the primitive Fizz schedules every flush pass with — so `jest.useRealTimers()` is
mandatory or the suite hangs.)

**Client half done:** `StyleSheet/__tests__/streamed-hydration-test.js`, 5 tests. Each runs two phases —
the document is produced by the real `takeShellHTML()`/`takeDeltaHTML()` inside `runInRequestScope`
(nothing hand-writes a `<style>`), streamed in chunk by chunk with the relocation scripts genuinely
executing, then RNW boots against the finished document in a second `jest.isolateModules`. Covers: no
duplicate insertion, cascade order surviving hydration (including the direction only the client can break
— a *runtime* shorthand still losing to a streamed longhand), no hydration warnings, a delta arriving
after boot, and idempotence under replayed relocation.

Validated by mutation: 9 source mutants, every test killed by at least one. No bugs found in the source.

Three things learned that are worth keeping:
- **`insertRule` never writes back to the element's text.** Re-parsing `outerHTML` silently loses every
  runtime-inserted rule — the assertion returns `""` rather than a wrong value. The helper rebuilds each
  `<style>`'s text from its live `cssRules` first. `streaming-test.node.js` is safe today only because it
  reads server-emitted styles exclusively; anyone extending its technique to runtime rules will hit this.
- **Delta hydration is doubly covered**, so a regression in either path alone is invisible: excluding
  deltas from `collectGroupSheets` changes nothing observable, because `installDeltaIngest` drains the
  queue at boot and registers them anyway. Not a bug, but single-point breaks are undetectable.
- **A client/server renderer divergence cannot be produced by mutating RNW source**, since both renders
  run in one process off the same files. The hydration-warning test was falsified by keying a mutation on
  `hasRequestScope()`, true only during the server render — so it is load-bearing against the realistic
  SSR-only/client-only divergence, but blind to a bug that affects both renderers identically.

- Status: **RESOLVED**

### 4. Shell payload grows with process uptime — MEASURED, no fix needed

`takeShellHTML()` dumps the entire cumulative process sheet to every request. Measured against the
21 renderable routes in `packages/react-native-web-examples/pages`, rendering each in its own
`runInRequestScope` inside one warming process (script kept at
`<scratchpad>/measure-shell-payload.js` + `jest.measure.js`):

| | raw | gzip -9 |
|---|---|---|
| cold shell (1st route) | 13,456 B | 4,144 B |
| warm shell (21st route) | 20,179 B | 5,595 B |
| growth across 21 routes | +6,723 B (1.50x) | **+1,451 B** |

Average new CSS contributed per route: 961 B. Five routes (`app-state`, `dimensions`,
`progress-bar`, `switch`, `text`) contributed **zero** new bytes.

**Verdict: keep the current design.** The curve saturates rather than growing linearly, because
atomic CSS dedups by (property, value) — the shared sheet converges on the app's total distinct
declarations, which is bounded and small, not on route count. The whole cost of over-sending after
full warm-up is ~1.4 KB gzipped, against a fully warm shell of 5.6 KB gzipped. That is not worth
trading for a route-scoped shell, which would reintroduce exactly the "which request inserted this
rule?" question that `b2e94fb6` removed by switching to the revision log.

Caveat worth keeping in mind: the examples app is homogeneous, so this understates a large app with
genuinely divergent design per route. The saturating shape should hold regardless — that is a
property of atomic CSS, not of this corpus — but re-run the script against a real app before
treating the number as final.

- Status: **RESOLVED (measured, design kept)**

### 5. React 19 — validated, and one real regression fixed

Investigated against 19.0.0 / 19.1.1 / 19.2.0 / 19.3.0 with React installed into an isolated scratch dir
and mapped in via `moduleNameMapper`, so the repo's own `node_modules` was never touched. Full write-up in
the untracked `REACT19-FINDINGS.md`, which keeps a VERIFIED / NOT VERIFIED split. That scratch dir no
longer exists and this Node/jsdom pass is not reproducible as it stands — see the reproducibility note at
the top of `REACT19-FINDINGS.md`. The real-browser matrix (below, and in `STREAMING-SSR.md`) covers the
same versions except 19.0.0 and is reproducible via `packages/streaming-ssr-e2e/scripts/react-version-matrix.js`.

**Verdict: supported.** Both assumptions the design rests on were checked against the Fizz source and hold:
- React 19 does **not** hoist, dedupe or reorder the `<style data-rnw-group>` anchors, and does not hoist a
  plain `<style>` out of a streamed chunk.
- The `completeWriting()` + `flushBuffered()` → `destination.flush()` contract is unchanged, same place,
  dev and prod. Only the buffer size moved, 2048 → 4096; the transform never depended on the number, but
  the comment citing it has been corrected.

Bonus confirmation of the design note above `takeShellHTML`: a `<style precedence>` emitted from `<body>`
lands at the **front of `<head>`, above every anchor** — measured, no longer just asserted.

> **Corrected by #17:** the claim below that React ≥19.1 withholds output until "a top-level `<Suspense>`
> resolves" is too broad. It withholds only for a boundary **above `<html>`**. A boundary *inside* `<head>`
> flushes immediately on both React majors.

**The regression, now fixed.** React ≥19.1 writes zero bytes until a top-level `<Suspense>` resolves
(19.1's Suspense-aware preamble: `preparePreamble` leaves `completedPreambleSegments === null` and
`flushCompletedQueues` bails). Because the transform emitted its prelude from `_transform` — React's first
*byte* — the whole document was withheld, `takeShellHTML()` ran late, and the boundary's rules folded into
the shell leaving an empty delta. Output stayed correct; streaming stopped. Bisected precisely: 18.3.1 and
19.0.0 flush at 0 ms, 19.1.1+ wait.

Fix: `start()` is now called from the public `flush()` before `emitDelta()`. React calls `flush()` twice
with zero bytes before the first write on 19.1+, so the shell goes out there; on 18, writes precede the
flush so `started` is already set and it is a strict no-op. Order within `flush()` matters and is pinned by
test — a delta drained ahead of the shell would steal rules the shell owns and put `<style>` above the
doctype.

| React | root `<Suspense>` before | after |
|---|---|---|
| 18.3.1 / 19.0.0 | prelude first, rule in delta | unchanged (no-op) |
| 19.1.1 / 19.2.0 / 19.3.0 | prelude withheld, rule in shell, **no delta** | prelude first, rule in delta |

New caveat, documented rather than fixed: a caller who pipes *before* `onShellReady` now gets
`takeShellHTML()` while the shell is still compiling, because React's `finally` runs even when its
`pendingRootTasks > 0` guard skips the work. Degrades gracefully (shell early, remainder in the first
delta, still relocating behind the right anchor) but is strictly worse than piping from `onShellReady`,
which the documented example already does.

Also fixed along the way:
- `configs/jest.config.node.js` now sets `doNotFake: ['queueMicrotask']`. React 19 captures
  `queueMicrotask` into a module-scope binding at import time, so `jest.useRealTimers()` — sufficient for
  React 18, which looked the global up per call — no longer is. Without it, 11 node suites hang under 19.
  The jsdom config does not need it.
- `ScrollView/__tests__/index-test.js` used `findDOMNode`, removed in React 19. `findDOMNode` appears
  nowhere in `src/`, so this was test-only; rewritten against `ref.current`, which is already the host node.
- `AppRegistry/__tests__/index-test.node.js` inline element snapshot replaced with structural assertions
  (preferred over a `react-is` override, which would change the resolved tree for everyone).

New test `modules/styleInjection/__tests__/prelude-ordering-test.node.js` (4 tests) pins the ordering under
the installed React 18 by driving explicit write/flush interleavings; verified that removing `start()` from
`flush()` fails the first test and only that one.

**Not verified:** document-level hydration (`hydrateRoot(document, …)` with a `RELOCATE_SCRIPT`-mutated
`<head>`) — the one place a surprise is still plausible; real browsers (Node + jsdom only); Web Streams,
which is structurally out of reach since the Edge/Browser Fizz builds have no `destination.flush()` at all;
19.4+/canary. Worth noting the `^19.0.0` peer range now spans two distinct Fizz preamble behaviours.

- Status: **RESOLVED**

### 6. Dimensions is the only per-request-scoped state

`Appearance.getColorScheme()` was hardcoded to `light` on the server with no per-request override — the
same class of bug Dimensions had, for anyone SSR-ing per-user dark mode. (`I18nManager` is a no-op stub,
so it is genuinely fine.)

**Fixed**, mirroring the Dimensions precedent exactly (`getScopedState('Appearance', …)` seeded from
`getProcessState`, so a fresh scope inherits a module-scope default). No `src/index.js` change needed —
the methods ride on the already-exported `Appearance` object:

```js
Appearance.set({ colorScheme })                      // server only; invariant() in the browser
Appearance.unstable_setForHydration({ colorScheme })   // browser only
Appearance.unstable_restoreFromHydration()
```

State is `{ colorScheme: ?ColorSchemeName }` where `null` means "nobody declared one" — the only state the
browser is ever in — so `getColorScheme()` falls through to the same `matchMedia` read as before and
nothing about client behavior changes.

The hydration override has a *stronger* rationale here than in Dimensions: Dimensions needs it because the
server cannot know the viewport; Appearance needs it because the client **can** answer and will answer
differently. `matchMedia` only ever reports the OS setting, while the point of `Appearance.set` is to
render a per-user preference (cookie, account setting) — exactly the case that mismatches on hydration and
flashes the wrong theme.

Two deliberate deviations from Dimensions, both commented in place:
- media-query change events are suppressed while a forced value is in effect;
- `unstable_restoreFromHydration()` **notifies** listeners when the query disagrees with the forced value.
  A resize eventually re-syncs Dimensions on its own, but nothing re-fires a media query that never
  changed — we merely stopped ignoring it — so every `useColorScheme()` consumer would otherwise hold the
  forced scheme forever. Needed a `Set` of live subscriptions alongside the non-enumerable `WeakMap`.

`useColorScheme` needed no change; its `useState(Appearance.getColorScheme())` initializer already runs
inside the request scope, and it already subscribes to changes, which is what makes the restore land.
Tests: `Appearance/__tests__/asyncContext-test.node.js` (9), `Appearance/__tests__/index-test.js` (9),
`useColorScheme/__tests__/index-test.js` (2, proving the hook is correct unchanged).

- Status: **RESOLVED**

### 7. `AppRegistry.getApplication().getStyleElement()` still emits the legacy single sheet

Mixing it with the grouped format throws in dev (`StyleSheet/dom/index.js:66`) but silently mis-cascades
in prod.

**Fixed** by adding a sibling accessor in new `AppRegistry/getStyleElements.js`, surfaced on
`AppRegistry.getApplication()`:

```js
getStyleElements: (?{ nonce?: ?string, ... }) => Array<Node>
```

`renderToStaticMarkup(getStyleElements({ nonce }))` is byte-identical to
`StyleSheet.takeShellHTML({ nonce })` — there is a test pinning exactly that.

Decisions:
- **Array of keyed elements**, not a fragment: an SSR pipeline can count them (nonce audit), slice them,
  or interleave them when splitting `<head>` across chunks. Each carries `key="rnw-group-<G>"`.
- **Routes through `takeShellHTML()`**, not `getGroupTextContent()`. `takeShellHTML` owns three things a
  reimplementation would have to duplicate and could drift from: every group including empties, the
  synchronous `resetRequestDelta()`, and `</style` escaping. Cost is a string round-trip (see follow-up).
- **Props spread onto every element; `id` rejected** — N duplicate ids, and `id="react-native-stylesheet"`
  would additionally trip the client's both-formats `detectMode` throw. `data-rnw-group` and
  `dangerouslySetInnerHTML` are applied after the spread so props cannot override group or CSS.
- **Mixing is prevented** by a per-`getApplication()` `createStyleFormatGuard()`, dev-only throw, matching
  the `detectMode` precedent. Uses `getScopedState` when a request scope is open, so it catches mixing
  across two `getApplication()` calls in one request and never leaks between concurrent requests.

Accepted consequence: `getStyleElement`'s signature and output are untouched, but it now records its
format, so it *can* throw in development if `getStyleElements` already ran on the same request. Symmetry
is required — otherwise "grouped then legacy" is undetectable server-side — and the condition is already a
guaranteed dev-time throw on the client, so this only moves the failure earlier with a better message.
Existing inline snapshots for `getStyleElement` pass unchanged, which is the regression proof.

17 new tests in `AppRegistry/__tests__/getStyleElements-test.node.js`.

- Status: **RESOLVED**

### 7a. Follow-up: remove the shell string round-trip

`getStyleElements` called `takeShellHTML()` and tokenized the HTML back into `[group, cssText]` pairs — a
string round-trip between two things that both want structured data.

**Done.** Added `StyleSheet.takeShellGroups(): Array<[number, string]>` — the structured shell, ascending,
every group including empties, watermark reset synchronously, `cssText` pre-escaped for `<style>`
embedding (every consumer embeds it, and `dangerouslySetInnerHTML` does no escaping of its own, so one
source of truth for the escape is right). `takeShellHTML` is now a thin string renderer over it, and
`getStyleElements` consumes it directly; `parseShellHTML` and its regex are deleted.

Verified by the byte-equality test the AppRegistry work had already written — `getStyleElements` output
still matches `takeShellHTML()` exactly. Node suite 62/62, flow 0 errors, eslint clean, prettier applied.

- Status: **RESOLVED**

### 8. Latent: new highest group is inserted before that anchor's relocated deltas

`createGroupStyleElement` inserted a brand-new highest-numbered group at `last.nextSibling`, which landed
it *before* the last anchor's relocated delta elements. Unreachable today — `orderedGroups` is a closed
set and the shell emits all of them, including empties — but it would bite the moment a group is added.

**Fixed.** `createGroupStyleElement` now computes its insertion point from `findGroupElements(rootNode, true)`
(deltas included) instead of anchors only, and compares `>= group` rather than `> group`. The `>=` also
fixes a second case I had not spotted: an anchor created for a group that already has deltas but no anchor
now lands *ahead* of its own deltas, reproducing the shell's anchor-then-deltas shape so runtime rules
yield to server rules within a group.

Review caught a regression in the first attempt: scanning *all* grouped elements let a `<body>`-resident
delta (the deliberate "no anchor, so don't relocate" fail-safe) supply the `parentNode`, creating the new
anchor in `<body>`. Reachable two ways — a stranded higher-group delta, and `detectMode` returning
`'grouped'` for a document that has only body deltas and no anchors at all. Final version resolves the
container (`document.head` / the `ShadowRoot`) *first*, filters candidates to `el.parentNode === container`,
and inserts into `container` in all three branches, so nothing outside it can define parent or position.

New test `StyleSheet/__tests__/dom-group-anchor-order-test.js`, 8 cases. Verified against both broken
versions: the unfixed file fails 3 of the original 6 (highest-group, ShadowRoot, end-to-end `createSheet`),
each showing the transposition — expected `["0","1","2","2:delta1","3"]`, got `["0","1","2","3","2:delta1"]`;
the intermediate version fails both new container tests.

- Status: **RESOLVED**

---

## Findings discovered during the work

### 9. A second shell emission silently inverts the cascade

Surfaced by the docs pass, confirmed by probe: `takeShellHTML()` called twice in one request returns the
**identical** string both times (it is the whole cumulative sheet, not a diff), so a document holding both
has two of every group anchor — 12 instead of 6 in the probe.

That is not merely redundant, it is wrong. A streamed delta relocates after the **first** anchor for its
group, so with anchors `[0,1,2,3][0,1,2,3]` a group-2 delta lands at position 3 — ahead of the second copy
of group 3 — while the second copy of group 2 lands *after* the first copy of group 3. Group 2 then
outranks group 3, the exact inversion the ascending-anchor scheme exists to prevent.

**Fixed** with a development-only `console.error` in `takeShellGroups` — the single funnel every spelling of
the shell now passes through, which is a direct payoff of the #7a refactor. Warn rather than throw: a
deliberate re-emit after an aborted response, where the first shell never reached the wire, is legitimate,
and the existing "repeat calls are fine" contract in the AppRegistry tests stays true. Guarded by
`hasRequestScope()` so a long-lived client or test process does not trip it. 4 tests in
`streaming-test.node.js`.

- Status: **RESOLVED**

### 10. The Web-Streams rationale existed only in an agent's report

The decision to ship no `TransformStream` / `renderToReadableStream` variant is a good one, but a repo-wide
grep for `ReadableStream` found nothing: the reasoning lived only in a transcript, so the next person would
have read the omission as an oversight and "fixed" it into a silent-corruption bug.

**Fixed** — written into the `modules/styleInjection/index.js` header: React's Web Streams path exposes no
equivalent of the Node destination's `flush()` clean-boundary signal, so a `TransformStream` could only
guess, and a wrong guess splices a `<style>` into the middle of a `<script>`. The honest answer on those
runtimes is to drive `takeShellHTML`/`takeDeltaHTML` from the framework's own boundary hooks.

- Status: **RESOLVED**

### 11. When is it safe to call `unstable_restoreFromHydration` under progressive hydration?

Genuinely open, and neither Dimensions nor Appearance addresses it. `runApplication`'s `callback` is passed
as a `ref` on the root `AppContainer`, so it fires when the **root** commits — but streamed Suspense
boundaries hydrate later. Restoring real viewport / color-scheme values at root commit means a late
boundary hydrates against different values than the server rendered it with, which is precisely the
mismatch the forced values exist to prevent. No test or source comment covers this.

Not a code bug so much as missing guidance, and the right answer is partly app-specific (React exposes no
"all boundaries hydrated" signal).

**Documented**, in a new "Handing control back after hydration" section, with the two device APIs split
rather than given one blanket rule:

- **`Appearance`: usually do not restore at all.** When the scheme came from a deliberate user preference
  the forced value *is* the truth — `matchMedia` only reports the OS setting, so handing control back
  flips the page away from the user's own choice. Restore only when the server was guessing, and then on
  the first media-query change rather than a timer. The app must listen on `window.matchMedia` itself for
  that, because RNW suppresses `addChangeListener` callbacks while the override is in force.
- **`Dimensions`: restore on the first real `resize`.** The server can never know the viewport, so
  restoring is eventually necessary; a resize is strictly later than root commit and ties the switch to a
  change the user is causing. Preferred over "when fully interactive" because React exposes no
  all-boundaries-hydrated signal, so any deadline fails exactly when boundaries hydrate late.

Root-commit restore (what the first draft of the example did) is now called out as wrong for any app whose
boundaries read either value. The end-to-end client example was rewritten accordingly.

- Status: **RESOLVED**

### 12. `Dimensions.unstable_restoreFromHydration()` did not notify subscribers

Found while writing up #11. `handleResize` was the only notifier, so restoring updated the stored value
silently — and in the very flow #11 now recommends this is worst-case: the app restores from its own
`resize` listener, RNW's handler has already run for that same event as a no-op (`update()` returned early
with `setForHydration` still set), and the restore then changes the value with nobody told. Every
`useWindowDimensions` consumer keeps the server's forced size until some *later* resize happens to arrive.

Asymmetric with `Appearance.unstable_restoreFromHydration`, which notifies deliberately (see #6).

**Fixed**: extracted `notifyChange()`, added a `sameMetrics()` value comparison (`update()` always assigns
fresh objects, so identity proves nothing), and restore now notifies iff the numbers actually moved.
5 tests in `Dimensions/__tests__/hydration-test.js`, deriving expectations from a never-forced module
instance rather than hardcoding jsdom values. Verified the key test fails against the old three-line
implementation and passes against the fix.

- Status: **RESOLVED**


### 13. Device-state hooks capture per-component, so late boundaries hydrate against a moved value

Raised by the user, confirmed in source. `useWindowDimensions` is
`useState(() => Dimensions.get('window'))` plus a `useEffect` subscription, and `useColorScheme` is the
same shape over `Appearance`. `useState`'s initialiser captures module state **at the moment that
particular component first renders**.

Under progressive hydration that is the wrong unit. A late Suspense boundary's first client render happens
well after the root's, so any change to the module value in between — an `unstable_restoreFromHydration`, a
resize, anything reaching `update()` — makes that boundary hydrate against different values than the
server rendered it with. #11 treated this as a *timing* problem to be documented; it is really a
*mechanism* problem, and documenting a hazard was the weaker fix.

`useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)` is the right primitive: React calls
`getServerSnapshot` for every subtree it hydrates, whenever it hydrates, then reconciles to `getSnapshot`
as an ordinary post-hydration update rather than a mismatch.

**Design decided** (user's call on the wire question: explicit, parallel to the CSS shell, deliberately
*not* coupled to it — so it does not live on `StyleSheet` and the streaming transform does not emit it):

- `modules/hydrationState/store.js` — the frozen server snapshot. Lazily parses `window.__RNW_HYDRATION__`
  on first read, deep-freezes it, first-writer-wins. Imports nothing from RNW, so no cycle. Lazy rather
  than a boot side effect because `package.json` sets `"sideEffects": false`.
- `modules/hydrationState/index.js` — `takeHydrationStateHTML({ nonce })`, emitting a `<script>` the app
  places itself, next to the CSS shell but independent of it. Reads through public API so
  `runInRequestScope` scopes it for free.
- `Dimensions` / `Appearance` — `unstable_setForHydration` also records the frozen snapshot (keeping its
  existing live-value behavior, so imperative `Dimensions.get()` during hydration is unchanged);
  `unstable_restoreFromHydration` must never touch it.
- Both hooks move to `useSyncExternalStore`, with a client `getServerSnapshot` that falls back to the live
  value when nothing was wired up, so apps using neither the emitter nor `unstable_setForHydration` behave
  exactly as today.

**Consequence: this retires #11 rather than documenting it.** Restore becomes safe at any moment, because
a boundary that has not hydrated yet reads the frozen snapshot regardless. It also makes #12's
notify-on-restore load-bearing — that notification is now what drives the post-restore re-render through
`useSyncExternalStore`.

Incidental: `useColorScheme`'s `useEffect` has no dependency array and re-subscribes every render.
`useSyncExternalStore` removes it.

**Done.** Both hooks are now one line: `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`.

Regression test `useWindowDimensions/__tests__/progressive-hydration-test.js` — real `renderToPipeableStream`
output split at the shell, a genuine `<!--$?-->` dehydrated boundary, the late chunk's `$RC` script
re-created so it executes. Independently re-verified against the old `useState` hook:

```
✕ a boundary that hydrates after the viewport moves does not mismatch
  + "Error: Text content does not match server-rendered HTML.",
  + "Error: There was an error while hydrating this Suspense boundary. Switched to client rendering."
```

The second line is the real cost: React does not merely warn, it discards the server markup for that
boundary and re-renders it on the client.

`useSyncExternalStore` semantics verified in `react-dom@18.3.1` source rather than assumed:
`mountSyncExternalStore` branches on `getIsHydrating()`, true for a boundary hydrating late — the basis of
the whole fix; it calls `getServerSnapshot()` **twice and errors if the two results differ by `!==`**,
which is exactly why the store caches and freezes rather than rebuilding per call; a post-hydration mount
(route change) correctly uses `getSnapshot`; and reconciliation to the live value is a passive-effect
`checkIfSnapshotChanged`, not a mismatch.

`getSnapshot` identity stability held with no extra caching — `Dimensions.get('window')` returns an object
that `update()`/`set()` only ever replace, never mutate. React would have caught otherwise: it calls
`getSnapshot()` twice per render in dev and warns.

Three resolution rules worth keeping, all decided against real failure modes rather than in the abstract:

- **The page global outranks a later `setServerValue`.** Both describe the same render, and the global is
  what boundaries that already hydrated saw — so it is the one that must win.
- **Duplicate registry key: first source kept, dev error, not fatal.** A duplicate can legitimately come
  from a bundler instantiating a module twice, which is not the consumer's bug to crash on.
- **A source that throws is skipped, reported, and the response continues.** Every key is independently
  optional — its client side falls back to the live value — so skipping degrades exactly one subsystem to
  today's behaviour. Aborting would convert one consumer's bug into a page-wide mismatch for subsystems
  that were working, halfway through a response already on the wire.

Test-structure gotcha, documented in the test: the subscriber and the boundary must be **siblings**, not
ancestor/descendant. A component re-rendering *above* a dehydrated boundary hands React a fresh
`<Suspense>` element, which counts as an update and makes React discard the server HTML for a different
reason ("received an update before it finished hydrating") — masking the failure under test.

API placement note: the store triple sits on each module's **default export** as
`unstable_hydrationStore`, not as named exports. That was forced rather than preferred —
`babel-plugin-add-module-exports` collapses `module.exports` to the default only while a module has no
named exports, so adding one changes the CJS shape of `dist/cjs/exports/Appearance` from the object to
`{default}` and breaks every deep `require` downstream.

- Status: **RESOLVED**

#### 13a. The snapshot must be a registry, not a hardcoded pair

User's follow-up: the frozen snapshot should cover everything that needed AsyncLocalStorage scoping, not
just Dimensions and Appearance. Correct — `react-native-web/server` exports `getScopedState` / `getProcessState`
precisely so downstream SSR helpers can add their own per-request state, and every one of those has this
same hydration problem with no way to participate in a hardcoded record.

So: `registerHydrationState(key, read)`, exported publicly; `takeHydrationStateHTML()` iterates the
registry rather than naming Dimensions and Appearance.

Built-ins are registered **inside `modules/hydrationState/index.js`'s own module scope**, not from within
each device module. That file can import them directly (they only import `store.js`, so no cycle), and it
keeps correctness off module-level side-effect ordering, which `"sideEffects": false` makes fragile.
Deterministic built-ins, extensible for consumers.

Audit of every current `getScopedState` user, so the exclusions are on record as deliberate:

| State | In the snapshot? | Why |
|---|---|---|
| `Dimensions` | yes | server cannot know the viewport |
| `Appearance` | yes | client can answer, and can answer *differently* |
| `AccessibilityInfo` | no — see #14 | nothing renders from it, so it cannot mismatch |
| `PixelRatio` | no, rides on Dimensions | derives from `.scale` / `.fontScale` |
| `StyleSheet` delta buffer | no | has its own wire channel: shell + streamed deltas |
| `AppRegistry` style-format guard | no | development-only, never leaves the server |

**Registration is a precondition, not a hazard.** `registerHydrationState` is the SSR shell/harness's job:
called once, at server-entry module scope, before any render. Registering later — from a module lazily
imported inside a Suspense boundary, say — is outside the contract and unsupported. A later/streamed
registration channel is a deliberate non-goal; it would rebuild the CSS delta mechanism this was meant to
stay uncoupled from.

For the record on why late registration cannot work: the server sequence is shell renders →
`takeHydrationStateHTML()` runs in the prelude → the boundary resolves and the lazy module registers →
its markup streams out. The key never entered the snapshot, but the markup exists and will be hydrated,
so the client falls back to the live value and can mismatch.

Note the risk is on the *server*, at emit time — not the client. Client-side registration timing is
irrelevant, because `store.getServerValue(key)` reads the parsed global by key and does not care whether
anything registered locally. The three built-ins cannot hit it at all, since
`modules/hydrationState/index.js` imports them directly and registers at its own module scope.

Backed by a development-only warning when a hook asks for a key during hydration and the store has the
global but no entry for it — worded as a contract violation naming the key. Silent when the global is
absent entirely (the legitimate not-using-the-emitter case) and when the key arrived via
`setServerValue`; once per key.

### 14. `AccessibilityInfo` — raised, then withdrawn as out of scope

I flagged this while auditing for #13a: `exports/AccessibilityInfo/index.js` evaluates
`window.matchMedia('(prefers-reduced-motion: reduce)')` at module scope with no request scoping, which
looked like the same class of bug as #6.

**Withdrawn on the user's call: reduce-motion is not this library's concern to carry over the wire.** The
implementation work that had been done for it was removed.

The evidence supports the call, and it came out of building the thing: `prefers-reduced-motion` is **not
reachable from render** in this codebase — the only reader is the async `isReduceMotionEnabled()`. Nothing
renders from it, so it cannot produce a hydration mismatch, and a snapshot entry buys nothing. Its
`true`-without-a-media-query default made it worse, emitting `reduceMotion: true` as a positive assertion
the server never made.

Worth recording so this is not re-raised as a regression: before this session touched it,
`AccessibilityInfo` held **no per-request state at all** — the module-scope `matchMedia` is `null` on the
server, so `isReduceMotionEnabled()` returns the default. The cross-request leak I described only became
possible *because* the work added a setter. Removing the setter removes the leak; there was never
anything to scope. My original framing of this as a #6-style gap was wrong.

Now listed in the registry's exclusions alongside `PixelRatio`, the `StyleSheet` delta buffer and the
`AppRegistry` dev-only guard, so the omission reads as deliberate.

**Two genuine pre-existing bugs found along the way are being kept**, both unrelated to SSR:
`handlers` was keyed by the listener *function*, so two listeners with identical source text collided and
unsubscribing one detached the other; and `addEventListener` returned `undefined` rather than `{remove}`
when there was no media query, so `.remove()` threw.

- Status: **WITHDRAWN** (two incidental bug fixes retained)

### 15. Nothing has ever run in a real browser

Every test in this change set is Node or jsdom. Four things are structurally untestable there, and all
four are load-bearing claims of the design:

- **Whether the cascade actually works.** jsdom caches computed styles and does not invalidate them when a
  `<style>` is moved by script, which is why every cascade assertion routes through re-parsing
  `dom.serialize()`. A real browser removes the workaround and tests the real CSSOM.
- **FOUC.** That nothing flashes unstyled between chunks is the product claim this whole design exists to
  deliver, and nothing tests it.
- **React 19's `$RB` / `$RV` / rAF reveal path**, read and reasoned about during #5 but never painted.
- **Document-level `hydrateRoot(document, …)`** against a `RELOCATE_SCRIPT`-mutated `<head>` — flagged in
  #5 as the most likely place for a surprise.

**The existing examples app cannot be used.** `packages/react-native-web-examples` is Next 12, pages
router, and fails on three independent counts: its `_document.js` uses
`AppRegistry.getApplication('rn').getStyleElement()`, the legacy single-sheet path this work deliberately
left unchanged; `_document.getInitialProps` + `renderPage()` is a two-pass render-to-string model with no
streaming and nowhere to put a Transform; and it depends on `react-native-web@0.21.2` from npm, which no
longer resolves to this workspace since the fork renamed itself `@edkimmel/react-native-web`. Retrofitting
it would mean migrating it to streaming *and* re-pointing its dependency, and it would still be a poor
fit. Building a purpose-built harness instead.

Prerequisites verified before starting:
- `npm run build` in `packages/react-native-web` succeeds and emits `hydrationState` and `styleInjection`
  to both `dist/` and `dist/cjs/` — the build pipeline had never been run against this session's new
  files.
- The built CJS bundle is consumable from Node: every new export resolves, `runInRequestScope` scopes
  `Dimensions.set`, the shell emits its 6 anchors, and `takeHydrationStateHTML()` carries the
  request's values.

- Status: **RESOLVED**

`packages/streaming-ssr-e2e/` — private, non-workspace, no `__tests__` directory (the repo jest configs
would otherwise collect the Playwright specs). Plain `node:http` server following the guide's own example,
esbuild client bundle, 13 specs on Chromium. Server declares **1024x768 / dark** against Playwright's
**1280x720 / light**, so the hydration assertions have something to prove. Repo gates unchanged: jsdom 62
suites / 810 passed, node 15 / 99.

Two harness problems worth recording, both non-obvious:
- **`React.lazy` cannot produce a late boundary per request.** Its loader runs once per process; after
  request 1 the module is resolved and the boundary never suspends again. The real delay is a
  request-scoped promise in RNW's own `getScopedState`.
- **The delta channel goes quiet once warm** — deltas come from the sheet revision log, so a rule an
  earlier request compiled arrives in the *next* request's shell. Every request therefore uses unique
  style values, and the cascade spec asserts a group-2 delta element actually exists so a wrap-around
  fails loudly instead of passing for the wrong reason.

**The FOUC spec is a measurement, not a race.** A flash is by definition a *painted* frame; animation-frame
callbacks are the first step of "update the rendering" and the parser cannot insert nodes between that
callback and the paint that follows, so what the callback sees is what that frame paints. The assertion is
exhaustive over sampled frames, with vacuity guards (shell painted in >5 frames; late probe painted at
least once; first-paints separated by >½ the boundary delay), a max-gap ceiling so a stalled sampler fails
rather than passes, and a **negative control** — `?broken=400` blanks the group-3 anchor and a fourth test
asserts the sampler catches it. Measured 65 frames over 1084 ms, median gap 17 ms.

Structural fact the byte stream made obvious: the delta `<style>` is written **after** React's `$RC` reveal
script for the same boundary, so no-FOUC does depend on the browser not painting between the two. Now
actually checked rather than assumed; held on React 18 and 19.

**React 19.3.0: all 13 specs pass**, so the `$RB`/`$RV`/rAF reveal path that #5 could only reason about has
now been observed in a real paint.

Not covered: Firefox/WebKit, Web Streams (no adapter, deliberately), concurrent isolation under real load,
CSP enforcement (a nonce is emitted and asserted but no header is sent), JS-disabled (a streamed boundary
never leaves its `<div hidden>` without `$RC`).

### 16. `hydrateRoot(document, …)` binds `<head>` fibers to the wrong DOM nodes — OPEN

The bug the browser harness existed to find, and exactly where #5 predicted a surprise. **Independently
reproduced**, not taken on report.

React hydrates a parent's children by walking DOM siblings in order. When the relocation script has already
run, each non-empty delta has inserted a `<style data-rnw-delta>` after its anchor, so every anchor past the
first insertion has shifted by one. Read directly off React's `__reactFiber$` back-pointers at
`/document?delay=200&boot=900`:

```
DOM node     -> React fiber believes
anchor g0    -> 0
anchor g1    -> 1
anchor g2    -> 2
delta  g2    -> 2.1     WRONG
anchor g2.1  -> 2.2     WRONG
anchor g2.2  -> 3       WRONG
anchor g3    -> (unowned)
delta  g3    -> (unowned)
```

**Ordering is what decides it, and the harmful order is the common one.** With the client bundle held back
(`boot=900`) the deltas land before hydration and the head skews. Without it the client hydrates first and
the deltas arrive after — 0 skewed nodes, 0 console errors, which is what my first check accidentally
measured. Streaming means HTML routinely outruns JS, so the skewed ordering is the normal case on a real
network, not a corner.

Impact is latent rather than immediate: React does not rewrite `dangerouslySetInnerHTML` on a mismatch, so
the DOM and the cascade survive and the boundary still hydrates against the server snapshot. But React's
group-3 fiber now points at the element sitting in group 2.2's slot, so **any later render of the head
writes group-3 rules into a group-2.2 element** — the exact inversion the anchors exist to prevent — and the
real group-3 anchor is orphaned. React 18 dev logs one warning (`didWarnInvalidHydration` is a single
module-level flag, so one however many elements are affected); production logs nothing. Identical on 19.3.0.

Only affects apps that render the whole document through React and call `hydrateRoot(document, …)` — a
legitimate and increasingly common pattern (Remix, and app-router-shaped frameworks).

**Fixed by removing the node entirely.** A streamed chunk no longer emits a `<style>` at all — it emits one
self-removing inline `<script>` that calls `insertRule` on the existing anchor's own sheet and then
removes itself, leaving the DOM byte-identical to React's server output. Nothing for React's sibling walk
to trip on.

Why this is stronger than relocation, not just a workaround: rules land in the anchor's own sheet, so
cascade position *is* the anchor's position. The old scheme depended on inserting the element at the right
offset relative to other anchors — precisely the thing that broke. Intra-group order stays irrelevant
because styleq dedupes by property. And it is `O(delta)`: the original `O(n²)` warning applies to appending
to `textContent`, which re-parses the sheet, not to `insertRule`.

Details: escaping moved from `</style` to `JSON.stringify` + `<` → `\u003c` (plus U+2028/9);
`document.currentScript` captured at the top of the IIFE; each `insertRule` in try/catch so one rejected
rule cannot drop the rest; a per-chunk seen-guard makes replay a no-op.

> **Superseded.** This paragraph originally ended "the missing-anchor fallback creates the anchor **in
> ascending position** so even that path keeps the cascade." That fallback was later **deleted** — see
> finding #17 below, which is the accurate account: a chunk with no anchor now queues its rules (flagged
> `p`) and never creates a node. The two statements contradicted each other in this file until
> `ADVERSARIAL-REVIEW-2.md` #2 caught the same contradiction in `STREAMING-SSR.md`; `src/__tests__/
> docs-drift-test.node.js` now fails on any prose describing the deleted fallback.

Client ingest: `window.__RNW_DELTA__` now carries `{g, r:[rules]}` objects consumed straight by
`registerExisting`. The legacy id-string element path is kept verbatim for pages served by an older server.
Boot-time hydration needed no queue at all — verified, not assumed: `collectGroupSheets` reads each
anchor's live `element.sheet` and `hydrateGroup` iterates `cssRules`, which includes `insertRule`d rules
(they never appear in `textContent`). Pinned by a test with no queue entry present.

**Verified independently under the exact conditions that reproduced the bug** (`?delay=200&boot=900`):
every anchor binds to its own fiber, 0 skewed nodes, 0 console errors, and the document ends with
0 delta nodes / 0 body styles / 0 stray scripts / 6 head anchors. Browser suite 13/13 on React 18.3.1 and
19.3.0, with `test.fail()` and the `/did not match/` warning filter both removed and console errors
asserted to be exactly `[]`. FOUC did not regress across 3 runs × 2 React versions, negative control still
firing.

Prior art (`PRIOR-ART.md`) supports the shape: this is the userland equivalent of React 19's hoistable
resources, which live in `<head>` *outside* the fiber walk. The one cited objection — that no CSS-in-JS
library uses `insertRule` on the SSR path, citing DevTools/source-map/silent-rejection downsides — is
already ours: `createOrderedCSSStyleSheet.js:387` inserts every runtime-compiled rule that way, with the
same swallow-on-failure try/catch. This makes the streaming path consistent with the client path rather
than introducing a new class of problem.

**One honest narrowing.** A caller who serialises the shell *before* the shell render (the e2e `/document`
route does, because React owns `<head>` there) pushes shell-render rules into the first delta, and those
now need JS. That flow already departed from the documented one and was already giving up cascade
position, but the no-JS degradation is genuinely narrower than before, not identical.

- Status: **RESOLVED**

### 17. Suspense inside — or above — `<head>` is not supported

Raised by the user. The `/document` route proves React can own `<html>`/`<head>`/`<body>`, but only with a
**static** head: anchors are React elements built from `takeShellGroups()` snapshotted *before* the render.
If `<head>` itself contains a Suspense boundary, or content suspends above it, head is still streaming when
the first delta script runs.

`StyleSheet/index.js:342` is where that breaks. When the anchor lookup fails, the fallback does
`d.createElement('style')` — creating a node React never rendered, inside a `<head>` React owns.
That reintroduces the exact fiber skew #16 removed, and puts the anchor at an arbitrary cascade position.

**The user's proposal — a transform in the Fizz byte stream, which is how Next.js does its injections — is
right for this case, and is a second mechanism rather than a replacement.** Established from Next's source:
`createHeadInsertionTransformStream` scans the byte stream and splices **before `</head>`**; once `</head>`
is flushed it falls back to enqueuing ahead of the current chunk, i.e. into the body.

The consequence is a clean split by window:

| Window | Mechanism |
|---|---|
| `<head>` still open in the stream | byte transform splices anchors as head streams |
| `<head>` closed (all deltas, by definition) | CSSOM script — what #16 built |

A Fizz transform cannot help late deltas: they are discovered after the shell flushed, so head is closed
and the transform degrades to body insertion, which is where we already are. Next hits the same wall.

**Measured — and the answer is no.** Next.js 16.3.4 / React 19.3.0, App Router, root layout rendering the
whole document so `hydrateRoot(document, …)` owns it. Full writeup in `repro/nextjs-head-hydration/FINDINGS.md`.

**Byte-splicing skews identically to script insertion.** Splicing into the raw response bytes before the
parser runs — Next's own `createHeadInsertionTransformStream` mechanism — gives the same misbinding. The
insertion *route* is irrelevant; only the node's tag and position matter.

Exactly one configuration skews, and it is ours:

> a foreign `<style>` interleaved **between React-rendered `<style>` siblings in `<head>`**

Everything else measured clean: `<style>` after the last anchor; `<script>`, `<meta>`, `<link>` between
anchors; `<style>` and `<script>` in `<body>`; `useServerInsertedHTML`; React 19 `<style precedence>`.

**Mechanism: React matches hydration candidates by tag type.** A foreign node whose tag differs from what
React expects is skipped. One whose tag *matches* is indistinguishable — empty `<style>` anchors are
textually identical — so React binds to the intruder and every later sibling shifts by one. The decisive
control is `<style>` in `<body>` among `<div>` siblings coming back clean while the same tag among `<style>`
siblings skews: the mechanism is tag matching, not `<head>` being special. This is also why Next survives
its own out-of-band injections — flight data is `<script>`, its head content is `<link>`/`<meta>`, none of
which collide with a same-tag React sibling.

Silent in production (React gates the warning behind a dev-only flag) and React *reuses* the mis-bound node
rather than discarding it, so nothing visibly breaks — the damage stays latent.

Consequences:
1. A Fizz head-insertion transform does **not** rescue the `<head>`-suspends case.
2. The #16 fix — emit no DOM node, `insertRule` into the existing anchor — is now correct for a *measured*
   reason rather than an assumed one.
3. Anchors interleaved in a React-owned `<head>` must be React-owned, which `/document` already does.
4. Appending strictly after all React-rendered head children is clean, but that position is not stable once
   `<head>` itself streams — which is the open case.

**Fixed.** New `<StyleSheet.Anchors />` renders the per-group anchors as React elements wherever
the app puts them — including inside a streaming `<head>` — so they are React-owned by construction and the
one skewing configuration cannot arise. The node-creating fallback in the delta script is **deleted**: a
chunk with no anchor now queues its rules (flagged `p`) instead, drained at sheet bootstrap, by later
chunks, by the component's `useInsertionEffect` commit, and at `DOMContentLoaded`. Pending buckets apply
through `sheet.insert()` — the same call a runtime `StyleSheet.create` makes — so both dedupe through one
selector map.

**Additive, not a replacement.** All three pre-existing consumer shapes verified unregressed:
`takeShellHTML()` (raw HTML, the only option for a non-React `<head>`) and `takeRequestDelta()`;
`getStyleElements()` / `takeShellGroups()` for a static React `<head>`; the new component for a streaming one.
`takeShellGroups()` keeps its exact semantics and `takeShellHTML` stays a thin renderer over it.

**Two things the browser forced that the design did not anticipate:**

- **Correction to finding #5.** Neither React major withholds `<head>` for a boundary *inside* it — both
  flush immediately with `<!--$?-->`. The Suspense-aware preamble withholds only for a boundary **above
  `<html>`**. Verified: `above=1` on 19.3.0 has TTFB ≈ the boundary delay; a boundary in `<head>` flushes at
  ~0 ms on both. So the queue is the **common** path, not belt-and-braces. Consequence: with no `prelude`,
  `emitDelta` now waits for a shell to have been emitted — without it React 19 drained a delta on its empty
  preamble passes (a `<script>` before the doctype → quirks mode) and React 18 shipped the whole sheet twice.
- **RNW's own boot creates anchors.** `createSheet()` runs at bundle evaluation, which on a streaming
  `<head>` is before the server's anchors land. Those are now marked `data-rnw-runtime`, and shell anchors
  win for placement, delta writes and client mirroring.

**Support matrix, measured on both React majors:**

| Shape | React 18.3.1 | React 19.3.0 |
|---|---|---|
| Boundary in `<head>`, anchors **in the shell** (recommended) | clean, no FOUC | clean, no FOUC |
| Boundary in `<head>`, anchors **inside it** | falls back to client rendering | clean, but **flashes** until anchors land |
| Boundary **above** `<head>` | pathological — nested document | clean (19.1+ preamble) |

The flash in row 2 is not fixable by any delivery mechanism: the CSS is behind the boundary. That test
asserts the flash exists and that every bad frame is one where `<head>` held zero shell anchors.

The "React 19.3.0" column's last row is really "19.1+": 19.0.0 predates the Suspense-aware preamble (see
finding #5) and the spec that covers this shape times out on 19.0.0 rather than passing — confirmed by
running `packages/streaming-ssr-e2e/scripts/react-version-matrix.js` against it. See the note below.

**Verified independently** at `/streaming-head?anchors=shell&delay=200&boot=900` (bundle held back so deltas
land before hydration): 6 head styles, all React-rendered, 0 runtime anchors, 0 skew, 0 delta nodes,
0 console errors. Browser suite (`npm run e2e:matrix:all` in `packages/streaming-ssr-e2e/`, which is what
makes these numbers reproducible): React 18.3.1 — 20 passed / 3 skipped; React 19.1.1, 19.2.0 and 19.3.0 —
21 passed / 2 skipped each, the skips being version-gated shapes; React 19.0.0 — 20 passed / 2 skipped /
**1 failed** (the boundary-above-`<head>` spec above), so 19.0.0 is excluded from the "supported"
real-browser claim. Unit: 826 jsdom / 116 node, flow 0, eslint clean.

FOUC frame-audited on `/document` (never audited before) and the new route, each with its own negative
control that fires.

- Status: **RESOLVED**


---

## <a id="api-coherence-landed"></a>API coherence — landed

The `## API coherence` section of `ADVERSARIAL-REVIEW.md` argued the fork's nine top-level additions were
the wrong shape, chiefly for a mechanical reason: `babel-plugin-react-native-web` deep-imports only names
that are directories under `src/exports/`, so every one of the nine fell through to the whole barrel. All
five recommendations are in the tree.

| Was | Is | Why |
|---|---|---|
| `StyleSheet.getShellGroups()` | `StyleSheet.takeShellGroups()` | It marks the shell emitted and moves the delta watermark. `take` is this module's spelling for that; `get` is the pure read. |
| `Dimensions.unsafe_setForHydration` | `Dimensions.unstable_setForHydration` | `unsafe_` was neither React's `UNSAFE_` nor RN's `unstable_`, and the same class already had `unstable_hydrationStore`. |
| `Appearance.unsafe_restoreFromHydration` | `Appearance.unstable_restoreFromHydration` | Same. |
| top-level `StyleSheetAnchors` | `StyleSheet.Anchors` | It is the fourth spelling of an emission whose other three are on `StyleSheet` / `AppRegistry`, and it was the only React component in the barrel with no RN counterpart. |
| top-level `createStyleInjectionTransform`, `registerHydrationState`, `takeHydrationStateHTML`, `getScopedState`, `getProcessState`, `hasRequestScope` | `react-native-web/server` | They run where the app *serves*, not where it renders. The transform wraps `node:stream`, so its absence from the barrel is now structural rather than something the `browser` field map has to catch. |

`runInRequestScope` and `configureRequestScope` stay top-level: they wrap the render, and everything else
is called inside them. The fork's addition to the top-level surface is two, from nine.

**The subpath is an `exports` map. It was a directory shim, and the shim did not work.**
`packages/react-native-web/server/package.json` carries `main` / `module` / `browser` pointing into `dist`,
and `server` is in the package's `files`; it still ships, but only as the fallback for toolchains that
ignore `exports`. The shim alone is *unresolvable from native Node ESM*: Node's ESM resolver does no
directory and no `main`-field resolution for a bare-specifier subpath, so
`import … from '@edkimmel/react-native-web/server'` in a `"type": "module"` project throws
`ERR_UNSUPPORTED_DIR_IMPORT`. See `ADVERSARIAL-REVIEW-2.md` #1.

**Correction to the original verification recorded here.** It read
"`require('@edkimmel/react-native-web/server')` resolves to `dist/cjs/server/index.js`". That is true, and
it is the one form that works under a directory shim — `require` does directory and `main`-field
resolution, ESM `import` does neither. Checking only `require` is what let the bug ship. Any future claim
about a subpath must be measured against a real `npm pack` tarball installed into a clean project, from
**both** `import` and `require`, because the workspace and every bundler mask exactly this failure.

What `exports` costs, and how the deep-import surface is kept: an `exports` field is package-wide
encapsulation, and Node uses pattern targets literally — a fallback array's later entries are tried only
when a target is *invalid*, never when the file is *missing* (measured: `"./dist/*": ["./dist/*.js",
"./dist/*/index.js", "./dist/*"]` breaks `require('…/dist/cjs/exports/View')`, which works today). So the
extensionless deep paths that consumers and this repo's babel plugin emit are enumerated per directory —
`./dist/exports/*` → `*/index.js`, likewise `dist/modules`, `dist/cjs/…` and `src/…`, all of which are
100% directories-with-`index.js` — with `./dist/*.js` passthroughs for fully-specified paths. `.` and
`./server` carry identical condition ladders (`browser` → `module` → `node` → `import`/`require`) so that
no resolver can ever put the root on `dist/` and the server entry on `dist/cjs/`; that mismatch would put
two `StyleSheet` modules in one bundle (measured with a root `server.js` facade: 2 copies under
webpack `target: 'node'` and Vite SSR, 1 with the matched ladder).

Verified against a packed tarball installed into a clean `"type": "module"` project, on Node 24.18.0:
ESM and CJS both resolve `/server` and the package root; extensionless deep imports
(`dist/exports/View`, `dist/index`, `dist/cjs/…`, `src/exports/View`) still resolve from CJS and through
esbuild, webpack and Vite; and a browser-target bundle of the subpath pulls
`modules/styleInjection/index.browser.js` and `modules/asyncContext/index.browser.js`, with no Node
builtin in the graph, under all three bundlers.

**`StyleSheet.Anchors` is a static property, not a named export**, for the reason recorded on
`Dimensions.unstable_hydrationStore`: `babel-plugin-add-module-exports` collapses `module.exports` to the
default only while a module has no named exports, and deep `require`s of `dist/cjs/exports/StyleSheet`
depend on that collapse. Confirmed on the built output — `typeof require(…exports/StyleSheet) === 'function'`
with no `.default`. The resulting import cycle (`index.js` ⇄ `StyleSheetAnchors.js`) resolves in both
directions because Babel hoists a default-exported function declaration above the module's requires; both
orders are pinned by a test (`StyleSheetAnchors-test.js` enters the component first,
`StyleSheetAnchors-test.node.js` enters `StyleSheet` first).

**What is NOT fixed: the babel module map still misses the two that stayed.** Evidence, running the plugin
on a probe file:

```
import { StyleSheet, View, runInRequestScope, configureRequestScope } from 'react-native-web';
  ->  import StyleSheet from "react-native-web/dist/exports/StyleSheet";
      import View from "react-native-web/dist/exports/View";
      import { runInRequestScope } from "react-native-web/dist/index";
      import { configureRequestScope } from "react-native-web/dist/index";
```

So `StyleSheet.Anchors` is fixed (it rides `StyleSheet`, which is in the map) and the six on
`react-native-web/server` are fixed (the plugin only rewrites bare `react-native-web` / `react-native`
imports, so a subpath import is already specific). The last two still pull the barrel.

The map is generated from directory names under `src/exports/` and the plugin emits a *default* import for
each hit, so closing this needs one of:

1. directories `src/exports/runInRequestScope/` and `src/exports/configureRequestScope/`, each a one-function
   default export — which games the map by putting two functions in the namespace otherwise reserved for
   react-native's components and APIs. Not done deliberately; it would trade a real structural lie for a
   tree-shaking nicety.
2. a second, hand-maintained map in `scripts/createBabelReactNativeWebModuleMap.js` (`{ runInRequestScope:
   'modules/asyncContext' }`) plus a branch in the plugin that emits a *named* import for those entries.
   ~30 lines across the plugin and its snapshot tests, and it extends the plugin's contract.

Worth noting what the residue actually costs: both are called from server entry code, which is bundled (if
at all) for Node, where pulling `dist/index` costs startup rather than shipped bytes, and an ESM bundler
still tree-shakes the barrel through `"sideEffects": false`. Recorded rather than fixed.

---

<!-- BEGIN: React version-gate granularity / support boundary (appended 2026-09-11) -->

## React version gating and the one real support floor — landed

Appended section. Nothing above this line was edited.

**The bug: the harness's own gates asked the wrong question.** `specs/helpers.js` exposed
only `reactMajor()`, and four gates in `streamingHead.spec.js` plus one in `fouc.spec.js`
branched on `>= 19` / `< 19`. One of those five was really asking *"does this React have
Fizz's Suspense-aware preamble?"* — which is a **19.1** question, not a 19 question. So the
boundary-above-`<head>` spec ran on 19.0.0, where the page can never reach the state it
waits for, and timed out at 60 s. That is the whole of the previously-recorded
"19.0.0 fails one spec and is excluded from the supported set".

**The boundary, verified rather than taken on report.** `preparePreamble` and
`request.completedPreambleSegments` appear in `react-dom/cjs/react-dom-server.node.development.js`
from **19.1.0** onwards and in no 19.0.x build — checked against 18.3.1, 19.0.0, 19.0.8
(the last of that line), 19.1.0, 19.1.1, 19.2.0 and 19.3.0. The word "preamble" does not
occur at all in 19.0.x's Node server build, so the concept is absent, not renamed.

**What the floor actually covers is narrower than "Suspense in or above `<head>`."**
Measured on the harness's own routes:

| Shape | 18.3.1 | 19.0.x | >= 19.1 |
|---|---|---|---|
| Boundary **in** `<head>`, `<StyleSheet.Anchors />` above it | works | works | works |
| Boundary **in** `<head>`, anchors inside it | client-render fallback | works, flashes | works, flashes |
| Boundary **above** `<html>`/`<head>` | broken | **broken** | works |

Only the last row has a version floor, and it is **React >= 19.1**. A boundary *inside*
`<head>` needs no preamble — both majors flush `<head>` immediately with `<!--$?-->`.

**And 19.0.x breaks differently from 18, which the old single "React 18" negative test hid.**
19.0.0 emits no doctype and no `<html>`/`<head>` open tag at all: `renderState.htmlChunks` /
`headChunks` are still `null` when `flushCompletedQueues` writes the completed root segment,
so the preamble is never written and only the stray `</head>` and `<body>` come out. React 18
instead streams the whole resolved document, `<!doctype html><html>` and all, nested inside a
`<div hidden>`. Both are now pinned by their own test.

### What changed

- `specs/helpers.js` — added `reactVersion()` (the full `React.version` string from `/env`),
  a pure `atLeast(version, target)` comparator, and a named
  `hasSuspenseAwarePreamble(version)` over `SUSPENSE_AWARE_PREAMBLE = '19.1.0'` carrying the
  source evidence in its comment. `reactMajor()` is **kept**, not replaced: three gates
  genuinely ask a major question.
- `specs/streamingHead.spec.js` — the boundary-above-`<head>` gate now asks
  `hasSuspenseAwarePreamble`; the single 18-only negative test split into one for 18.3.1 and
  one for 19.0.x, each asserting that version's own measured shape. The two anchors-in-the-
  boundary gates stay `reactMajor` with a comment saying why (hydration tag-matching is a
  major change; measured to pass on 19.0.0).
- `specs/fouc.spec.js` — the one gate there stays `reactMajor`, likewise commented.
- `scripts/react-version-matrix.js` — comment recording why 19.0.0 earns its place in
  `DEFAULT_VERSIONS`: it is the only line without the preamble, so it is the only version
  that can catch a `>= 19` gate that meant `>= 19.1`.

### Post-fix matrix (`npm run e2e:matrix:all`, exit 0)

| React | passed | skipped | failed |
|---|---|---|---|
| 18.3.1 | 20 | 4 | 0 |
| 19.0.0 | **21** | 3 | **0** |
| 19.1.1 | 21 | 3 | 0 |
| 19.2.0 | 21 | 3 | 0 |
| 19.3.0 | 21 | 3 | 0 |

24 specs. 19.0.0 does not merely stop failing — it gains a passing test (the 19.0.x negative
shape), so the version that exposed the bug is now the one holding the evidence.

### Docs reconciled

`README.md` (the stale "13 Playwright specs … 18.3.1 and 19.3.0" line, now the floor plus the
five-version matrix), `STREAMING-SSR.md` (a "one version floor" callout in React version
support, the rewritten real-browser table with a per-shape gating table, a new
`<StyleSheet.Anchors />` section carrying its own support-boundary box, the corrected Fizz
buffer-size claim, and the deleted "a Suspense boundary inside `<head>` is not supported"
limitation), and `REACT19-FINDINGS.md` (a dated correction at the top plus a
"The 19.1 boundary — VERIFIED" section).

One incidental correction worth keeping: the Fizz `currentView` size is **2048 on 18.3.1,
19.0.0, 19.1.1 and 19.2.0, and 4096 only from 19.3.0**. `REACT19-FINDINGS.md` had recorded
"2048 → 4096" as a React 19 change; it was measured against 19.3.0 and over-generalised.
Nothing depends on the number.

### Evaluated, deliberately NOT implemented: a dev-only `React.version` warning

Recommendation: **do not add it.** See the reasoning in the session report; the short form is
that it would make RNW read `React.version` for the first time anywhere in the library, to
catch a failure mode (a 60 s hang / an obviously broken document) that is loud rather than
silent, on a shape the app author chose explicitly. `StyleSheetAnchors.js` was not touched.

<!-- END: React version-gate granularity / support boundary -->

<!-- BEGIN: ADVERSARIAL-REVIEW-2 findings #4, #5, #10, #11 (appended 2026-09-11) -->

## Adversarial review 2 — findings #4, #5, #10 and #11

### #4 — `IStyleSheet` now type-checks something

`const stylesheet: IStyleSheet = StyleSheet` is vacuous and always was: Flow 0.148 treats a
function's statics as unsealed, so the annotation holds however many members are missing. The
fourteen `StyleSheet.x = x` assignments are now one object literal checked against
`type StyleSheetStatics = $Exact<$Diff<IStyleSheet, {||}>>` — `IStyleSheet` minus its call
signature, exactly — and `Object.assign` puts them on the function. The member list is written
once, in `IStyleSheet`, so the type and the implementation cannot drift.

Both mutants from the review now error (measured, tree restored):

| Mutant | Before | After |
|---|---|---|
| add `bogusMember: number` to `IStyleSheet` | No errors! | `property bogusMember is missing in object literal` |
| delete the `Anchors` static, keep it in the type | No errors! | `property Anchors is missing in object literal` |

An extra member in the literal and a member whose type drifted are errors too.

The cycle comment moved onto the `Anchors` member and was corrected: the hoist that resolves
`StyleSheet` ⇄ `StyleSheetAnchors` is `exports.default = StyleSheetAnchors` at the top of the
built **`StyleSheetAnchors.js`**, not in `StyleSheet/index.js` (which ends with
`exports.default = stylesheet`, after everything).

### #5 — the tests that could not fail

- **T3, `StyleSheetAnchors-test.js` "the snapshot is frozen"** — repaired, not deleted. It now
  starts from the *un-latched* read (a client-only `<head>`: `readClientGroups` memoises only a
  non-empty result), which is the only arrangement in which `useState` is load-bearing. The
  latched arrangement is kept as a second test that says in its own comment that it cannot fail
  to a missing `useState`, because it is the shape a real server-rendered page is in.
- **`warnIfRuntimeAnchorsSkewHydration`** — 10 new tests in
  `__tests__/StyleSheetAnchors-warning-test.js`. Every test resets the module registry and
  re-requires React, ReactDOM and the component, so the `warnedRuntimeAnchors` once-latch starts
  unlatched in each one and no other test in the process can reach it: suite order cannot decide
  the result. The React-major gate is pinned by redefining `React.version` on the freshly
  required instance (the gate reads it at call time).
- The old unasserted firing in `StyleSheetAnchors-test.js` is now explicit: that file spies on
  `console.error`, tolerates exactly the runtime-anchor warning (asserted in the file above) and
  **fails on anything else**, so no new unasserted output can accumulate there either.
- **T1 and T2** (`anchor-gate-test.node.js`) are in `src/modules/styleInjection/`, owned by
  another agent this session. Not touched.

### The `major !== 18` gate: keep it, and the review's suggested improvement is worse

S3 proposed `major < 19` because `!== 18` "fails open" on React 20. Measured with coverage in
place: `major < 19` is a **false positive on the experimental channel**. React's experimental
build reports `React.version` `19.3.0-experimental-…` today, but any `0.0.0-…` reading — and any
build off main whose numerals are a placeholder — lands below 19 and would make the warning fire
on a build that skips foreign nodes exactly like 19 does. Silence on a hypothetical React 20
hydration regression is cheaper than noise on every experimental build, so the gate stays
`major !== 18`. A test pins the decision: `is silent on an experimental build, which is not
React 18` fails under the `major < 19` mutant and passes under every other one.

### #10 — the premise is false; `react@experimental` was installed and run

The review reasoned from the *published* version. The two strings differ:

```
package.json version : 0.0.0-experimental-019019be-20260911
React.version        : 19.3.0-experimental-019019be-20260911
```

`/env` reports `React.version`, so every gate already classified the experimental channel
correctly. Reproduced: `npm install react@experimental react-dom@experimental`, `E2E_REACT_DIR`
pointed at it, **full suite green — 26 passed, 3 skipped** (the three React-18/19.0-only specs
skipped, as intended). No spec ran the wrong branch.

The classification was still made robust, because the *published* string is the one a person
handles (`npm view react dist-tags`, a matrix argument, a workflow pin) and reading it as major 0
puts the newest React there is below React 18. `majorOf` returns `Infinity` for a `0.0.0-…`
build and `atLeast` returns true unconditionally; `NaN` for an unreadable version, so a garbage
`/env` can only ever run specs, never silently skip them all.

### #11 — the matrix runner's missing checks

`scripts/react-version-matrix.js` now refuses to report a row it cannot attribute:

- **cache validity covers the trio.** `validateInstall` checks `react` and `react-dom` against
  the requested version and both couplings `react-dom` itself declares
  (`peerDependencies.react`, `dependencies.scheduler`), using a small exact/`^`/`~` comparator
  that treats an unrecognised range as unsatisfied. Both of the review's poisonings are caught
  at the cache check and the directory is reinstalled rather than reused; a third
  (right react + react-dom, `scheduler@0.27.0` under `^0.28.0`) is caught too.
- **the React that ran is cross-checked** against `React.version` of the install, read back out
  of the run's own `[WebServer] [e2e] listening on … (react X)` line. No line, or a different
  version, is a `FAILED TO RUN` row and exit 1.
- **`passed > 0` floor.** `0 passed, N skipped` exits 0 in Playwright; it is now a
  `FAILED TO RUN`.
- **`flaky` is parsed** and counts against `ok`. `retries: 0` means it cannot appear today.
- `main()` is behind `require.main === module` so the checks are requirable and tested.

### New spec: `specs/versionGates.spec.js`

Eight pure tests (no browser, no server, no install) covering both the spec gates and the matrix
runner's arithmetic — the only way to cover dist-tags this repo cannot afford to install and
cache poisonings it should not construct. It respects the package's deliberate "no `__tests__`
directory" rule by living with the specs.

Spec counts move: **28 passed / 4 skipped on 18.3.1**, **29 passed / 3 skipped on 19.3.0**,
26 passed / 3 skipped on `experimental`. Any documentation table quoting 24 specs needs the +8.

<!-- END: ADVERSARIAL-REVIEW-2 findings #4, #5, #10, #11 -->


<!-- BEGIN: doc-truth findings #2, #3, #8, #9, #14 + a drift check (appended 2026-09-11) -->

## Documentation truth: the repeats, and the mechanism that ends them

`ADVERSARIAL-REVIEW-2.md` #2 and #8 were both *repeats* — found by the first review, then
reintroduced by a careful full rewrite of the same file, because the rewrite never re-checked
the previous review's doc findings against its own new prose. #3 was the inverse: the source
carries a heading reading "Why this reports in production too" and the rewrite called the same
warning development-only. Prose passes have now failed twice running on `STREAMING-SSR.md`, so
the fix is half text and half test.

### What was verified before each rewrite

| # | Claim | What I ran | Verdict |
|---|---|---|---|
| 2 | the delta script "creates the anchor itself" | read `src/exports/StyleSheet/index.js:407` (`'else{b.p=1;}'`) and generated a real script through `takeDeltaHTML()` — it contains no `createElement`/`appendChild`/`insertBefore` | doc wrong; source right |
| 3 | the duplicate-shell `console.error` is development-only | `markShellEmitted` (`:487-501`) has no `NODE_ENV` read; provoked a second `takeShellGroups()` in a scope with `NODE_ENV=production` and the warning fired | doc wrong; source right |
| 8 | "all of these are no-ops or return `''` outside a request scope" | called all four accessors outside a scope against `dist/cjs`: `takeShellHTML` **12898 bytes** with no user styles (12979 with two), `takeShellGroups` 6 groups, `takeDeltaHTML` and `takeRequestDelta` both `''` | doc wrong; the shell accessors must not be gated (AppRegistry SSR depends on it) |
| 9 | `RELOCATE_SCRIPT` present tense + a cited test | `grep -rn RELOCATE_SCRIPT src/` → 0 hits; the cited test name does not exist, the real one is `index-test.node.js:181` "a late boundary's CSS arrives as a delta and leaves no node" | doc wrong, marked superseded rather than deleted |
| 14 | "the string 'preamble' does not occur in 19.0.x at all" | `grep -o` over `react-dom-server.node.development.js` in fresh installs: lowercase 0, case-insensitive **8** — `flushStyleInPreamble`, `flushStylesInPreamble`, and a `PREAMBLE = 2` stylesheet-resource state, none of them Fizz's document preamble | claim overstated, conclusion correct and now rests on what the hits *are* |

Also corrected while there: `REACT19-FINDINGS.md`'s item 5 was marked **FIXED — comment
corrected** and is not fixed (see "Left for other owners" below), and the preamble table's
counts were matching *lines*, not occurrences, which is why its `completedPreambleSegments`
column ran one low.

### The 19.0.8 / 19.1.0 installs now exist

The docs cited two React installs "made for the purpose" that were nowhere in the tree.
Restored, in the shape `scripts/react-version-matrix.js` produces:
`packages/streaming-ssr-e2e/node_modules/.react-version-cache/{19.0.8,19.1.0}/`. They are not
in `DEFAULT_VERSIONS`, so the reproduction is explicit and is now written into the docs:
`node scripts/react-version-matrix.js 19.0.8 19.1.0`. Full re-measured grid (occurrences):

| react-dom | `preparePreamble` | `completedPreambleSegments` | `VIEW_SIZE` |
|---|---|---|---|
| 18.3.1 | 0 | 0 | 2048 |
| 19.0.0 | 0 | 0 | 2048 |
| 19.0.8 | 0 | 0 | 2048 |
| 19.1.0 | 13 | 12 | 2048 |
| 19.1.1 | 13 | 12 | 2048 |
| 19.2.0 | 13 | 13 | 2048 |
| 19.3.0 | 13 | 13 | 4096 |

### The mechanism: `src/__tests__/docs-drift-test.node.js`

11 assertions, in `npm test`. Two kinds, and the difference matters:

- **Measured** (the load-bearing ones). The scope-gating claim is now a table in
  `STREAMING-SSR.md` inside `<!-- drift-check: scope-gating -->` markers; the test parses the
  rows and *calls each API outside a scope*. The missing-anchor claim is checked against a
  freshly generated delta script. The duplicate-shell claim is checked by provoking the warning
  with `NODE_ENV=production`. Each pairs a measurement with a constraint on the prose, so
  neither side can drift alone.
- **Textual** (rot, not wrongness). Every `StyleSheet.*` / `Dimensions.*` / `Appearance.*` /
  `AppRegistry.*` symbol named in the docs exists on the real object; the Entry-points example's
  named imports exist on `src/index.js` and `src/server/index.js`; every `file › test name`
  citation names a test that exists; every repo-local file citation resolves; every `file:line`
  citation is inside the file; every fenced JS example in the guide parses; the guide's spec
  **file** count matches `specs/*.spec.js`.

Verified by reverting each defect and watching it fail:

| Reverted | Test that failed |
|---|---|
| #2, the "missing-anchor fallback" paragraph | *the delta script queues rather than creating a missing anchor* |
| #2, only the `nonce` parenthetical at the other end of the file | same test — the ban is document-wide |
| #3, the development-only paragraph | *the duplicate-shell warning fires in production…* |
| #8, one table row flipped to `''` | *the scope-gating table matches what the APIs do outside a scope* (reports the 1509-byte string it actually got) |
| #8, the whole table replaced by the old sentence | same test — a deleted `drift-check` region is a failure, not a pass |
| #9, the fabricated test name | *every cited test name exists in the file it is cited from* |

**Ceiling, stated plainly.** It cannot check the Playwright pass/skip counts (only the number of
spec files), the React-version preamble claims (seven npm installs), anything a browser does, or
any sentence of reasoning. A paragraph that avoids every forbidden phrase while saying something
else untrue still passes. It buys exactly this: those specific claims cannot come back, and a
renamed API or deleted test stops being citable.

### `src/__tests__/packageExports-test.node.js` — the `exports` map trap

7 assertions. The map replaced a directory shim that native Node ESM could not resolve, and
brought package-wide encapsulation with it: a new top-level directory under `src/` (hence
`dist/`) silently stops resolving, because the catch-all `"./src/*"` fallback array is *not* a
search path — Node takes the first shape-valid target without checking the file exists, so
`./dist/exports/View` would become `./dist/exports/View.js`. Confirmed by deleting the pair from
a copy of the map.

It models Node's pattern selection (longest base wins; first array entry wins) and asserts:
every directory under `exports/`/`modules/` resolves to its own `index.js` across `./src`,
`./dist` and `./dist/cjs`; the measured invariant that every entry there **is** a directory with
an `index.js` (a bare `.js` file breaks the pattern's assumption); every top-level `src/`
directory is either mapped or in a `NOT_EXPORTED` list *with a written reason*
(`__tests__`, `server`, `types`, `vendor` today); the three trees carry mirrored patterns; every
name the repo's babel plugin rewrites resolves to a real file; every literal target exists; and
the `.` and `./server` condition ladders agree, since a split there would put two `StyleSheet`
modules in one bundle. Verified by adding `src/newthing/Widget/index.js` (fails), adding a bare
`src/exports/Bare.js` (fails), and removing a pattern pair (resolves to the wrong target).

`dist/` is only walked when built, since `npm test` does not build; the src walk plus the
mirroring assertion is what runs in CI.

### Left for other owners

- **`src/modules/styleInjection/index.js:166-167`** still reads "The view is 2048 bytes on
  React 18 and 4096 on React 19". Measured above: 2048 through 19.2.0, 4096 only from 19.3.0.
  `REACT19-FINDINGS.md` item 5 now says NOT FIXED and points here; the comment itself belongs to
  the styleInjection owner.
- **`SUSPENSE-TODO.md:859` vs `:950`** still disagree about whether the missing-anchor fallback
  exists (`:950` is right: it is deleted). Not touched, since this file is shared.
- The two constraints relayed from the styleInjection owner are now in the guide: the head must
  be written as **UTF-8** if `prelude` is omitted (the anchor scan matches ASCII bytes and the
  encoding is unrecoverable by `_transform`; costs streamed deltas, not CSS), and **emit the
  last delta before `end()`** — stated precisely, since bytes after `end()` are delivered iff
  the writable queue was still parked at that moment, and lost iff it had drained.

<!-- END: doc-truth findings #2, #3, #8, #9, #14 + a drift check -->
