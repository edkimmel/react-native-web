# Adversarial review — streaming-SSR fork of react-native-web

Scope: the uncommitted working tree at `b2e94fb6`. Everything below was checked against
the built `packages/react-native-web/dist/cjs` (rebuilt 2026-09-11, current with `src`)
or against source directly. Throwaway probes were written under a scratch directory
outside the repo; the working tree is unchanged apart from this file.

**Baseline that already passes.** `flow check` → 0 errors. `eslint configs packages
scripts` → clean. `jest --config ./configs/jest.config.js` → 16/16 suites. `jest --config
./configs/jest.config.node.js` → 16 suites / 116 tests. `packages/streaming-ssr-e2e` →
20 passed, 3 skipped. So none of what follows is caught by the existing gates.

### Index

| # | Sev | Finding |
|---|---|---|
| 1 | **CRITICAL** | Injection transform splices `<script>` mid-tag under stream backpressure |
| 2 | HIGH | Two `<StyleSheetAnchors/>` duplicate every anchor, no warning |
| 3 | HIGH | "Two shells warns but is otherwise safe" is false |
| 4 | HIGH | `STREAMING-SSR.md` documents the removed missing-anchor fallback |
| 5 | HIGH | `StyleSheetAnchors` undocumented; docs call its use case unsupported |
| 6 | MED | `AccessibilityInfo.addEventListener` — unsubscribe kills a sibling (regression) |
| 7 | MED | `<StyleSheetAnchors>` reads its own output back on the client |
| 8 | MED | Runtime creates the `<head>` node shape the delta script refuses to create |
| 9 | MED | `STREAMING-SSR.md` wrong about out-of-scope behaviour |
| 10 | MED | Docs claim 13 specs / React 19 green; 23 specs, no React 19 in tree |
| 11 | MED-LOW | Transform: `unpipe` listener leak; throwing downstream `flush()` escapes into Fizz |
| 12 | LOW-MED | `takeHydrationStateHTML` misses the U+2028/U+2029 escape |
| 13 | MED-LOW | Delta seq restarts per request → composed documents silently drop CSS |
| 14 | LOW | `npm test` is red (`prettier` on untracked `repro/`) |
| 15 | LOW | New exports miss the babel-plugin module map → whole-barrel imports |
| 16 | LOW | Five stale comments describing replaced mechanisms |
| S1–S4 | — | Suspected, not reproduced |
| T1–T8 | — | Test quality: assertions that cannot discriminate, plus coverage holes |

---

## CONFIRMED

### 1. CRITICAL — the injection transform pushes deltas out of order under stream backpressure, splicing `<script>` into React's markup

`packages/react-native-web/src/modules/styleInjection/index.js:327-341`

**Mechanism.** `flush()` — the method React's `flushBuffered()` calls — writes its delta
with `stream.push()` (via the local `push()` at `:259-264`), directly onto the Transform's
**readable** side. React's HTML goes in through `write()` onto the **writable** side and
only reaches the readable side when `_transform` runs.

Node's `Transform.prototype._write` defers `_transform` (stores the callback in
`kCallback`) once the readable buffer reaches `readableHighWaterMark` — 65536 on Node ≥22,
16384 before. From that point React's chunks are parked in the writable queue while
`flush()` keeps pushing **ahead of them**.

Fizz's Node destination writes one fixed-size view at a time (`VIEW_SIZE` 2048 on React 18,
4096 on 19); those views end mid-element by construction and only the final
`completeWriting()` write lands on an element boundary. So a delta pushed between view *k*
and view *k+1* lands inside whatever the tokenizer was in the middle of.

The module's own "trap 1" (`:126-161`) claims this is exactly what the design prevents:

> append there and you get `<di<style>…</style>v>`

**Measured, with real `renderToPipeableStream` in the loop**
(`scratchpad/probe/real-react.js`, react-dom 18.3.1, real `http.createServer`, real socket,
slow client). `_readableState.length` and the writable queue depth captured at the instant
each delta buffer is pushed:

```
push #  from        readableLength  HWM    writableBuffered  writing
    0   flush                   0   65536                 0    false
   ...                          0   65536                 0    false
   14   flush               49776   65536                 0    false
   15   flush               66770   65536                21     true
   16   flush               67382   65536                50     true
   17   flush               66787   65536                56     true

bytes: 1393297 | delta scripts: 18 | {"between-elements":16,"inside-text":2}
   inside-text: ..."class=\"row-171\">boundary 15 row 171 payload pa<script>(function(){var "...
   inside-text: ..."<div data-b=\"17\" data-row=\"21\" class=\"row-21\">boundary<script>(function(){var "...
```

Once `readableLength` crosses 65536, **21 → 56 React chunks are sitting unprocessed in the
writable queue** at the moment the delta is pushed past them. Three of the eighteen pushes
land in that window, and two of them land in the middle of a text node — splitting it, so
after the script self-removes the element has two adjacent text nodes where React rendered
one. That is a hydration mismatch on that subtree.

**The in-tag splice, also with real React.** Which *class* of splice you get is decided by
where the view boundary happens to fall, which is a property of the document, not of the
bug. The text-heavy tree above gives text-node splices (21 across 8 runs, 0 in-tag). Make
the markup attribute-heavy instead — same transform, same React, same slow client
(`scratchpad/probe/real-react-tagheavy.js`) — and the splice lands inside a start tag:

```
bytes: 2257243 | delta scripts: 12 | {"between-elements":10,"INSIDE-A-TAG":2}
   INSIDE-A-TAG: ..."49\">x</div><div data-b=\"9\" data-row=\"50\" data-k1=\"abcde<script>(function(){var "...
   INSIDE-A-TAG: ..."defghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuv<script>(function(){var "...
pushes with readableLength >= HWM: 3 of 12
pushes with React chunks still queued on the writable side: 3
```

`data-k1="abcde<script>(function(){…` — the delta script is spliced inside an attribute
value of an open `<div>`. That is `<di<style>…</style>v>` with React driving every byte.

**So, precisely — all three confirmed with real `renderToPipeableStream`:**
- *Out-of-order delta emission under backpressure.* Certain.
- *Splice into a text node, splitting it* (hydration mismatch on that subtree). Certain.
- *Splice inside a start tag / attribute value* (markup corruption). Certain.

Details:

- **Inputs → wrong behaviour:** a response large enough that the client consumes slower than
  Fizz produces. Text-heavy tree: 24 Suspense boundaries × 600 rows ≈ 1.39MB, client reading
  2048 bytes every 60ms. Attribute-heavy tree: 24 × 120 rows ≈ 2.26MB, client reading 1024
  bytes every 25ms. **At 16KB/8ms the readable side never filled and nothing went wrong** —
  which is why an under-loaded harness reports a clean `P0 D P1 D …` interleave with
  `readableLength` pinned at 0. The load, not the wiring, is what creates the condition.
- **Why the suites miss it:** `packages/streaming-ssr-e2e` runs on loopback with Chromium
  reading as fast as the server writes; the node jest tests drive the transform synchronously
  with no consumer at all. See T1 — the test that claims to cover this passes against a
  transform that injects on every write.
- **Verified:** Node 24.18.0, react-dom 18.3.1; deterministic across 8 runs.

The fix shape (not applied): the delta must be enqueued through the same ordering point as
React's bytes — buffer it and emit from `_transform`'s callback, or push only when
`_writableState.buffered.length === 0 && !_writableState.writing`, or forward the flush
signal while queueing the payload. Do not simply guard on `write()`'s return value: the
damage happens *within* a pass, after React has already handed over several views.

---

### 2. HIGH — two `<StyleSheetAnchors/>` duplicate every anchor with no warning at all

`packages/react-native-web/src/exports/StyleSheet/StyleSheetAnchors.js:103-113`

`readServerGroups()` returns the request-scoped cache **before** reaching
`StyleSheet.takeShellGroups()`, and `takeShellGroups()` is what calls `markShellEmitted()`
(`exports/StyleSheet/index.js:461`). So the duplicate-shell guard never runs for the
second instance.

```
2. two <StyleSheetAnchors/> -> duplicate-shell warnings: 0 | anchors for group 3 in document: 2
3. takeShellHTML + <StyleSheetAnchors/> -> warnings: 1
4. <StyleSheetAnchors/> + takeShellHTML -> warnings: 1
```
(`scratchpad/probe/shell.js`, `renderToStaticMarkup`)

The guard fires for every mixed spelling and misses the one that is a **component** — the
only one that composes, and therefore the only one that can be duplicated by accident (a
layout and a page both rendering it, a shared `<Head>`, a copy-pasted route). The source
comment at `:78-82` records the behaviour but calls it a "consequence"; the code's own
`DUPLICATE_SHELL` text (`exports/StyleSheet/index.js:399-412`) calls the resulting document
a cascade inversion that "is never safe".

- **Confidence:** certain.

---

### 3. HIGH — "emitting two shells warns but is otherwise safe" is false

Same probe, case 5:

```
5. rule compiled between two shells -> delta emitted: EMPTY (rule only in 2nd shell)
```

A rule compiled between `takeShellHTML()` #1 and #2 exists **only in the second shell's
text**, because `takeShellGroups()` → `resetRequestDelta()` (`index.js:463`) moves the
watermark past it. The document then contains two copies of every group anchor; that rule
lives in the *second* copy of its group, which sits after the *first* copy of every higher
group. A group-2 rule from shell #2 therefore outranks a group-3 rule from shell #1 — the
exact inversion `DUPLICATE_SHELL` describes.

The warning is also dev-only (`markShellEmitted:426`), so in production two shells are
silent and mis-cascading.

- **Confidence:** certain for the mechanism (probe shows the rule reaching only shell #2 and
  producing no delta); the visual mis-cascade follows from DOM order and is not separately
  reproduced in a browser.

---

### 4. HIGH — `STREAMING-SSR.md` documents a fallback that no longer exists

`packages/react-native-web/STREAMING-SSR.md:304-309`:

> a missing anchor means the document never carried a shell — which also means it is not
> the React-owns-`<head>` case the CSSOM path exists for. **Rather than drop the rules, the
> script creates the anchor itself**, ordered ascending among whatever group elements are
> in `<head>` …

`exports/StyleSheet/index.js:373-375` — the actual emitted script:

```js
// No anchor: mark the bucket pending and hand it to the runtime. See
// "The missing anchor" above — creating the element here is the one
// thing that reintroduces the hydration skew.
'else{b.p=1;}' +
```

The source's own heading 70 lines above is `## The missing anchor: queue, never create`
(`:305`), and it names the doc's *reasoning* as the hole that was fixed. Second site:
`STREAMING-SSR.md:570` — "`nonce` applies to the script (and to the element the
missing-anchor fallback creates)"; `index.js:504-506` says the `<script>` "is the only
element this emits".

**Why it matters:** a reader following the doc believes a shell-less streaming setup
self-heals at parse time with no JS dependency. It does not — those rules sit in
`window.__RNW_DELTA__` until RNW's runtime boots.

- **Confidence:** certain.

---

### 5. HIGH — `StyleSheetAnchors` is shipped, exported and e2e-tested, but both docs say the case it exists for is unsupported

`src/index.js:39` exports it. `packages/streaming-ssr-e2e` has a dedicated route
(`server.js:390`), an app (`app/StreamingHeadApp.js`) and five specs
(`specs/streamingHead.spec.js:144,206,260,295,331`).

`STREAMING-SSR.md:405-409`:
> **A Suspense boundary inside `<head>` is therefore not supported today.**

`STREAMING-SSR.md:960-963` repeats it under Known limitations. Neither
`STREAMING-SSR.md` nor `README.md` contains the string `StyleSheetAnchors` at all (grep:
zero hits in both).

This is the single largest doc/source gap: the newest, least-soaked, publicly exported
component is undocumented, and the docs actively steer readers away from it.

- **Confidence:** certain.

---

### 6. MEDIUM — `AccessibilityInfo.addEventListener` regression: unsubscribing one listener kills a sibling

`packages/react-native-web/src/exports/AccessibilityInfo/index.js:53-65, 90-110`

The change replaces `handlers[handler]` (which stringified the function — a real bug) with
a `WeakMap` keyed by identity. But the adapter is now **memoised per handler**, and
`addChangeListener` passes the *same* function to `MediaQueryList.addEventListener`. Real
`EventTarget` semantics dedup by `(type, listener, capture)`, so two subscriptions register
**one** DOM listener, and the first `remove()` detaches it for both.

```
DOM listeners registered for 2 subscriptions: 1
after A unsubscribes, DOM listeners left: 0 -> B still subscribed? false
```
(`scratchpad/probe/misc.js`, with an `EventTarget`-accurate `matchMedia` mock)

This is a **regression**: before the change each `addEventListener` built a fresh closure,
so two DOM listeners were registered and removing one left the other working. The old bug
was "leak + double-fire"; the new one is "silent loss of a live subscription", which is
worse. The comment at `:56-63` presents the WeakMap as the fix.

`Appearance.addChangeListener` (`exports/Appearance/index.js:176-207`) has the identical
shape and the same result (also confirmed in the probe). It is not reachable through
`useColorScheme`, which allocates a fresh arrow per subscribe, but it is reachable from the
public API.

- **Confidence:** certain.

---

### 7. MEDIUM — `<StyleSheetAnchors>` reads its own output back on the client

`StyleSheetAnchors.js:115-126` → `findShellAnchors(document)` →
`style[data-rnw-group]:not([data-rnw-delta]):not([data-rnw-runtime])`
(`dom/createCSSStyleSheet.js:78`).

The elements `<StyleSheetAnchors>` renders match that selector exactly — nothing
distinguishes "an anchor the server sent" from "an anchor this component rendered a moment
ago". Any client render in which a new instance's `useState` initializer runs while a
previous instance's anchors are still in the DOM reads 2N anchors and renders 2N.

Reproduced (`scratchpad/probe/anchors-client.js`): a second `root.render` with a different
root element type renders the new tree before unmounting the old, and React reports

```
Warning: Encountered two children with the same key, `rnw-group-0`.
Warning: Encountered two children with the same key, `rnw-group-2`.
Warning: Encountered two children with the same key, `rnw-group-3`.
#root innerHTML: <style data-rnw-group="0">…</style><style data-rnw-group="0">…</style>…
```

A plain unmount-then-remount is fine (count returns to 3 before the remount). The reachable
trigger is a concurrent transition / offscreen pre-render / error-boundary reset, where
React renders the replacement before committing the removal.

- **Confidence:** reproduced for the shape; the real-world trigger (concurrent transition)
  is inferred, not reproduced in a browser.

---

### 8. MEDIUM — the runtime creates the exact `<head>` node shape the delta script refuses to create

`dom/index.js:171-173` runs `initialRules.forEach(rule => sheet.insert(rule, 0))` at
**module evaluation** of `exports/StyleSheet/index.js`. When the shell anchors have not
arrived yet — which is the whole streaming-`<head>` case — `createGroupStyleElement`
inserts at `container.firstChild` (`dom/createCSSStyleSheet.js:221`):

```
head children after RNW boots into a shell-less streaming <head>:
  0 <style data-rnw-group="0" data-rnw-runtime=""></style>
  1 <style data-rnw-group="3" data-rnw-runtime=""></style>
  2 <meta charset="utf-8">
  3 <title>t</title>
```

`createCSSStyleSheet.js:129-140` and `ingestDelta.js:60-76` both refuse to let a *delta*
create a `<style>` in `<head>` because it is "the single DOM shape measured to silently
mis-bind `hydrateRoot(document, …)`". The bootstrap does it unconditionally, on every page
load in that configuration, and puts the node ahead of everything React rendered.

`specs/streamingHead.spec.js:24-32` acknowledges the consequence — "React 18 does not [skip
it], and the document falls back to client rendering" — and gates the spec on React ≥19.
So this is a known limitation, but it is (a) not in any user-facing doc, (b) not warned
about at runtime, and (c) a direct contradiction of the invariant two other modules are
built around.

- **Confidence:** DOM shape certain; hydration consequence taken from the project's own e2e
  spec rather than re-measured.

---

### 9. MEDIUM — `STREAMING-SSR.md:545-546` is wrong about scope behaviour

> For adapters that do their own stream plumbing … **All of these are no-ops or return `''`
> outside a request scope.**

```
takeShellGroups() OUTSIDE a scope -> 6 groups, shell bytes: 707
takeDeltaHTML() outside a scope -> ""
```

Only `takeDeltaHTML` is. `takeShellGroups`/`takeShellHTML` have no scope guard on their
return value (`index.js:460-491`) — and must not, since the entire non-streaming AppRegistry
SSR path documented at `:613-642` depends on them working outside a scope. The document
contradicts itself at `:881-883`.

- **Confidence:** certain (measured).

---

### 10. MEDIUM — both docs claim 13 Playwright specs and React 19 coverage; there are 23 specs and no React 19 in this tree

`STREAMING-SSR.md:69` and `README.md:20`:
> **13 specs on Chromium, green on React 18.3.1 and React 19.3.0**

`playwright test` in this tree: **23 tests in 7 files**, of which **3 skip** because
`reactMajor` is 18. `node -p "require('react/package.json').version"` → `18.3.1`, and the
e2e harness resolves React from the monorepo root
(`require.resolve('react', {paths:[packages/streaming-ssr-e2e]})` →
`<root>/node_modules/react`).

Everything the design rests on that is React-19-specific is therefore **unverified in this
tree**: trap 5 (React 19.1's Suspense-aware preamble withholding all bytes, which is the
entire reason `start()` is called from `flush()` as well as `_transform`), trap 6, the
`anchors=shell` / `above=1` head shapes, and the `doNotFake: ['queueMicrotask']` change in
`configs/jest.config.node.js` whose stated reason is a React 19 behaviour.

- **Confidence:** certain.

---

### 11. MEDIUM-LOW — transform: listener accumulation, and a throwing downstream `flush()` escapes into Fizz

`styleInjection/index.js:346-357` adds an `unpipe` listener to the destination on **every**
`pipe()` call and never removes it:

```
1. unpipe listeners on destination after 12 pipe/unpipe cycles: 12
(node:…) MaxListenersExceededWarning: 11 unpipe listeners added to [PassThrough]
```

`:337-340` forwards React's flush to each destination with no `try`/`catch`:

```
2. flush() THREW: boom from compression middleware
   the healthy destination received the delta: true
```

The exception unwinds into React's `flushCompletedQueues` `finally` block. The delta itself
is already pushed so nothing is lost, but one misbehaving compression middleware takes the
render down at an arbitrary point mid-response. Both are cheap to guard.

Also confirmed: `destroy()` (abort path) skips `_flush`, so the `epilogue` is never emitted
and the response ends unterminated. That is inherent to `destroy` and probably fine, but it
is not stated anywhere.

- **Confidence:** certain (all three measured, `scratchpad/probe/transform-edges.js`).

---

### 12. LOW-MEDIUM — `takeHydrationStateHTML` does not escape U+2028/U+2029

`modules/hydrationState/index.js:234`:

```js
const json = JSON.stringify(collect()).replace(/</g, '\\u003c');
```

The payload is emitted as a **JS object literal**, not parsed from a string. `StyleSheet`'s
`escapeForScriptTag` (`exports/StyleSheet/index.js:254-259`) escapes U+2028/U+2029 and
documents exactly why:

> U+2028/U+2029 are legal in JSON strings but were line terminators in JS before ES2019, so
> they are escaped too rather than relying on the engine being new enough.

The same reasoning applies verbatim here and was not carried across. Built-in sources emit
numbers and a two-value enum, so this needs a consumer-registered source with a
user-controlled string — but `registerHydrationState` exists precisely to accept those, and
the comment at `:161-163` ("Deliberately a local copy of the helper in `StyleSheet/index.js`")
shows the divergence was a copy, not a decision.

- **Confidence:** certain (the escape is absent); exploitability depends on a consumer source.

---

### 13. MEDIUM-LOW — delta sequence numbers restart at 1 per request, so a composed document silently drops one stream's CSS

`exports/StyleSheet/index.js:204-215` — `nextDeltaSeq()` reads a **request-scoped** counter.
The replay guard it feeds is a **page-scoped** global (`w.__RNW_DELTA_SEEN__`,
`:357-358`).

```
request A delta seqs: [ '1', '2' ]
request B delta seqs: [ '1', '2' ]
```

One document assembled from two `runInRequestScope` render streams — ESI/SSI, a
micro-frontend composition, a shell-plus-island architecture, any framework that
concatenates two Fizz outputs — gets two chunks claiming `k[1]`. The second is treated as a
replay: `if(!k[1])` is false, so it inserts nothing **and** does not queue, so the runtime
never applies it either. Those rules are lost outright, silently, in production.

The comment at `:205-208` says the sequence "is purely a uniqueness handle … and doesn't
need cross-request semantics", which is true for the one-request-per-document assumption but
is not stated as a requirement anywhere a composing caller would see it. A random or
process-wide-monotonic component in the seq would remove the hazard entirely.

- **Confidence:** the collision is certain (measured). The drop follows directly from
  `if(!k[seq])`; I did not assemble a two-stream document in a browser.

---

### 14. LOW — `npm test` is currently red

`npm run test` = `flow && format && lint && unit`. `npm run format` fails:

```
[warn] repro/nextjs-head-hydration/.next/dev/static/chunks/…
[warn] Code style issues found in 52 files. Forgot to run Prettier?
```

The untracked `repro/` tree (including its `.next` build output) is not in
`configs/.prettierignore` and not in `.gitignore`. Every `.js` outside `repro/` passes.

- **Confidence:** certain.

---

### 15. LOW — none of the fork's new exports reach `babel-plugin-react-native-web`'s module map

`scripts/createBabelReactNativeWebModuleMap.js:19-22` generates the map from **directory
names** under `src/exports/`. `StyleSheetAnchors` is a *file* inside `exports/StyleSheet/`,
and `createStyleInjectionTransform` / `registerHydrationState` / `takeHydrationStateHTML` /
the five `asyncContext` exports live under `src/modules/`. None of the nine appear in
`packages/babel-plugin-react-native-web/src/moduleMap.js` (grep: zero hits).

`packages/babel-plugin-react-native-web/src/index.js:56-64`: an unknown named import falls
back to `react-native-web/dist/index` — the whole barrel. So in a project using the plugin,
`import { View } from 'react-native-web'` gets a deep import while
`import { StyleSheetAnchors } from 'react-native-web'` pulls in the entire library. See the
API section below.

- **Confidence:** certain (read the generator and the plugin; map verified empty of all nine).
- **Status:** partially fixed with the API-coherence changes. `StyleSheetAnchors` became
  `StyleSheet.Anchors`, and `StyleSheet` *is* in the map, so it now deep-imports; the six
  server-only names moved to `react-native-web/server`, which the plugin does not touch at
  all (it only rewrites bare `react-native` / `react-native-web` sources). `runInRequestScope`
  and `configureRequestScope` still fall through to `dist/index` — see the LANDED note in the
  API section below.

---

### 16. LOW — stale comments (mechanism replaced, comment not updated)

Each verified against the source line quoted.

| Comment | Claim | Contradicting source |
|---|---|---|
| `exports/AppRegistry/getStyleElements.js:94-97` | "a missing anchor sends that delta to the end of `<head>`, where it outranks every group above it" | Nothing appends to the end of `<head>`. A missing anchor queues (`StyleSheet/index.js:375`); the runtime later inserts in ascending position (`dom/createCSSStyleSheet.js:207-222`). "End of `<head>`" is the `@layer` failure mode described elsewhere. |
| `dom/createCSSStyleSheet.js:44-48` | "a streamed chunk can slot into [element order] with a two-line `insertBefore` … no runtime required" | The chunk does `h.insertRule(r[j], h.cssRules.length)` (`StyleSheet/index.js:370-371`) and the no-anchor case *does* require the runtime. The very next comment in the same file (`:75-76`) was updated; this header was missed. |
| `exports/Appearance/index.js:246-253` | "Unlike the Dimensions counterpart this notifies change listeners… A resize eventually re-syncs Dimensions on its own" | `Dimensions.unstable_restoreFromHydration` now notifies too (`Dimensions/index.js:341-346`), and its own comment says "Same reasoning as `Appearance.unstable_restoreFromHydration`". |
| `dom/ingestDelta.js:71-76` | "An entry whose anchor is still missing **stays in the queue** rather than being dropped or applied somewhere arbitrary" | `:224-232` — once `parserFinished()` the entry is applied, via `insert` → `createGroupStyleElement`, which synthesises an element. The in-body comment at `:160-176` describes this correctly; the header is the stale half. |
| `exports/StyleSheet/index.js:390-392` | "an absent anchor forces that chunk onto the fallback path, which has to synthesise an element React never rendered" | The chunk has no synthesising fallback (`:375`). The outcome is reachable, but by the runtime after `DOMContentLoaded`, not by the chunk. |

Also, `StyleSheet.hasEmittedShell()` is on the published `IStyleSheet` type
(`index.js:714`) and is the exact question `STREAMING-SSR.md:543-603`'s stated audience
("adapters that do their own stream plumbing") needs, but it is not documented there.

---

## SUSPECTED

### S1. `hasEmittedShell()` reports "rendered", not "written"

`styleInjection/index.js:291` gates the pre-shell delta on `StyleSheet.hasEmittedShell()`,
which becomes true when `<StyleSheetAnchors>` **renders** (`takeShellGroups()` →
`markShellEmitted()`), not when its bytes are written. Under Fizz those are separate phases.
In the ordinary path `flushCompletedQueues` writes the segment before calling
`flushBuffered`, so the order is fine. A pass in which React renders the anchors but
returns from `flushCompletedQueues` before writing that segment (the backpressure early-return)
still reaches `flushBuffered` in the `finally`, so `emitDelta` would run with the gate open
and the anchors not yet on the wire. Those rules would find no anchor, queue as pending, and
need JS. Not reproduced — it needs a real Fizz render under precise backpressure.

> **CONFIRMED AND FIXED (2026-09-11).** It was reproduced, with a real
> `renderToPipeableStream`. The mechanism is exactly as suspected: React 18.3.1's
> `completedBoundaries` loop does `if (!flushCompletedBoundary(...)) { request.destination
> = null; return; }`, and that `return` sits inside a `try` whose `finally` calls
> `flushBuffered` unconditionally — so a boundary queued behind a backpressured one is
> rendered but unwritten when our `flush()` runs. Two same-promise boundaries (so both
> complete in one pass, in tree order), the first ~400KB so `write()` returns `false`, the
> second carrying `<StyleSheet.Anchors/>`: the delta landed at byte 389,498 with its anchor
> at 389,828 — **ahead of the anchor it needs**. Fixed by replacing the `hasForwardedBytes`
> half of the gate with `sawAnchorBytes`, a byte scan in `_transform` for
> `data-rnw-group="` — the attribute the delta script's own `querySelector` already
> depends on, so it cannot be renamed without breaking the delta channel. Post-fix the
> delta lands at 391,178, behind its anchor at 389,526. `anchor-gate-test.node.js`, 6
> tests; 2 fail against the pre-fix gate, and separate mutants kill the cross-chunk carry
> and the `hasEmittedShell()` conjunction individually.

### S2. A pending entry applied after `parserFinished()` can land in a mispositioned anchor

`ingestDelta.js:224-232` treats `document.readyState !== 'loading'` as "no shell anchor is
ever coming". With `hydrateRoot(document, …)` and React 18's `$RC` relocation, a `<head>`
boundary's anchors are physically in the document before `DOMContentLoaded`, so the reasoning
holds for the shapes I could construct. I could not build a case where a React anchor
genuinely arrives after `DOMContentLoaded`, but nothing in the code makes that impossible
(a boundary revealed by a late `$RC`, a framework that streams after `load`). If it happens,
the pending rules go into a runtime anchor whose DOM position is not the cascade bucket.

### S3. `detectMode` throws from module evaluation

`dom/index.js:70-78` throws in development when a document contains both formats. That
`throw` runs inside `createSheet()`, which runs at module scope of
`exports/StyleSheet/index.js:20` — before any React root exists, so no error boundary can
catch it and the whole bundle fails to evaluate. The intent (fail loudly) is right; the
placement means the diagnostic is an unhandled module-eval exception rather than a render
error. I did not build a page in both formats to confirm the user-visible result.

### S4. The `<script>` has no outer `try`/`catch`

`exports/StyleSheet/index.js:344-382`. Every `insertRule` is wrapped (`:370-371`) — that
claim holds — but `d.querySelector(...)` and the loop are not, and
`if(s&&s.parentNode)s.parentNode.removeChild(s)` sits **after** the `if(!k[seq]){…}` block.
Any throw inside leaves the `<script>` node in the DOM permanently, which is precisely the
foreign-node-skews-hydration shape the rest of the design is built to avoid. I could not
make `querySelector` throw with a numeric group, so this is theoretical — but it is one
`try`/`catch` to make it impossible.

---

## SURFACES I TRIED HARD TO BREAK AND COULD NOT

Stated specifically, per the brief.

**Escaping — sound.** `escapeForScriptTag` (`index.js:254-259`), `escapeForStyleTag`
(`:221-223`) and `escapeForAttr` (`:227-234`). I fed hostile values through real CSS
compilation: `fontFamily: '</script><img src=x onerror=alert(1)>'`,
`'</style><script>alert(2)</script>'`, and a literal U+2028. Delta payload came out with
every `<` as `<` and U+2028 as ` `; the shell came out with `<\/style>`, which the
HTML tokenizer does not accept as a RAWTEXT terminator, so the following `<script>` stays
inert text. No breakout on either path. (`scratchpad/probe/escape.js`)

**Request-scope isolation — sound.** Three interleaved `runInRequestScope` renders with
different viewports, colour schemes and staggered awaits. Each got its own `Dimensions`,
`Appearance`, hydration snapshot and delta watermark; no cross-talk. The one cross-request
effect that exists is deliberate and documented: a request's delta can carry rules only a
concurrent request needed, because the sheet is process-wide. (`scratchpad/probe/concurrent.js`)

**AsyncLocalStorage across backpressure — sound.** I specifically expected context loss on
the `'drain'`-resumed path over a real HTTP socket, since the socket's async resource
predates the scope. It does not happen on Node 24: 60 passes, 5 drains,
`hasRequestScope() === true` throughout, all 59 deltas delivered.
(`scratchpad/probe/als.js`)

**`getSnapshot` / `getServerSnapshot` identity — sound.** `getSnapshot() ===
getSnapshot()`, `getServerSnapshot() === getServerSnapshot()`, and a real
`useWindowDimensions` render under `react-dom/client` produced no React warnings. The
comment's reasoning (`Dimensions/index.js:187-192`) is correct: `update()` and `set()`
replace `window`/`screen` wholesale, never mutate them. `Appearance` returns a string, which
is free. (`scratchpad/probe/snapshot.js`)

**The delta script itself — sound.** Executed in jsdom with `runScripts: 'dangerously'`:
inserts into the correct group anchor's CSSOM, removes itself (0 `<script>` left in the
DOM), leaves `<head>` byte-identical to the server output, queues with `p:1` when the anchor
is missing, and the queue is drained and applied when RNW boots with
`readyState !== 'loading'`. `var` hoisting, the hand-escaped `:not()` selector and the
`k[seq]` replay guard all parse and behave as written. The "byte-identical after the script
runs" claim holds for the parser-driven path. (`scratchpad/probe/dom.js`, `pending.js`)

**"Queued and never applied" — no such path found** within the documented flow. The four
drain triggers are real and the requeue condition is narrow. The only never-applied case is
"RNW's runtime never evaluates", which means there is no RNW on the page at all.

**Legacy `getStyleElement()` — byte-for-byte unchanged**, as claimed: the inline snapshot in
`AppRegistry/__tests__/index-test.node.js` is untouched by the diff and still passes. The
one behavioural addition is `recordStyleFormat('legacy')`, which can throw in development if
`getStyleElements()` was also called — deliberate, and the output bytes are unaffected.

---

## Test quality — what the suites do not catch

The suites are large (116 node tests, 826 jsdom tests, 23 e2e specs) and several files are
genuinely excellent — `hydrationState/__tests__/store-test.js`, `asyncContext/__tests__/esm-test.node.js`
(compiles the real module to ESM and runs it in a real Node child process, which is exactly
what the `eval('require')` bug needed), `StyleSheet/__tests__/streamed-hydration-test.js`,
and `useWindowDimensions/__tests__/progressive-hydration-test.js` (real
`renderToPipeableStream`, real `<!--$?-->`, real `$RC`, with a positive control so it cannot
pass vacuously). **No test mocks away its subject.** The problems below are assertions that
cannot discriminate, verified by mutation.

### T1. The test for finding #1 cannot fail for the reason it names

`modules/styleInjection/__tests__/index-test.node.js:228-264`, titled
`'injection lands between React chunks, never inside one'`, with the comment
"Splicing after each of them would land inside a tag and mangle the DOM."

```js
expect(stats.writes).toBeGreaterThan(4);
expect(deltaChunks(html).length).toBeLessThanOrEqual(2);
expect(deltaChunks(html).length).toBeLessThan(stats.writes);
```

None of the three observes *position*. A replica transform that drains the delta from
`_transform` on **every** write — the implementation this test exists to forbid — passes all
three (`writes = 20, deltaChunks = 1` for both mutant and real), because `takeDeltaHTML()`
returns `''` once drained, so per-write injection still yields exactly one non-empty
injection.

A discriminating test has to record *where* the push happened: wrap `injector.flush` and
`Transform.prototype._transform`, tag each injected buffer with the call it was pushed from,
and assert `pushedFrom` is `['flush']` for every one. Written that way it would also have
caught finding #1, since under backpressure the push happens from `flush()` at a byte offset
React's writable queue has not reached.

### T2. `getServerSnapshot` for `useColorScheme` is deletable

`exports/useColorScheme/__tests__/index-test.js:50-62` uses `render()` from
`@testing-library/react` — i.e. `createRoot()`, which **never calls `getServerSnapshot`**.
The test reads `'dark'` only because `unstable_setForHydration` also moves the live value.
Replacing the third argument of `useSyncExternalStore` with `getSnapshot` passes this file
and all of `Appearance/__tests__/index-test.js`. The right test is a real `hydrateRoot`
against markup that disagrees with the live media query — the `useColorScheme` analogue of
the `useWindowDimensions` progressive-hydration test, which is the best test in the change
set and has no counterpart here.

### T3. The `useWindowDimensions` unsubscribe test is incapable of failing

`exports/useWindowDimensions/__tests__/index-test.js:137-152` — `expect(spy).not.toHaveBeenCalled()`
on a `console.error` spy after `unmount()` + a dispatched `resize`. Two independent reasons
it cannot fail: React 18.3.1 emits no "update on unmounted component" warning at all, and
`afterEach` has deleted `window.visualViewport` while jsdom's `clientWidth/Height` are
immovable, so the dispatched event changes nothing. Contrast the `'tracks resizes'` test 30
lines above, which does install `visualViewport`.

### T4. A dead `if` in the most load-bearing ordering test

`modules/styleInjection/__tests__/prelude-ordering-test.node.js:141-144`, in
`'the leading zero-byte flush does not drain a delta ahead of the shell'`:

```js
const firstDelta = html.indexOf('data-rnw-delta');
if (firstDelta !== -1) {
  expect(firstDelta).toBeGreaterThan(headEnd);
}
```

`firstDelta` is `-1` here (the rule is compiled before the scope opens, so the shell owns it
and no delta script is emitted). The body never runs. The test asserts nothing about delta
ordering — and this is the assertion guarding trap 5, the reason `start()` is called from
`flush()` at all.

Related, `:124`: `expect(html).toContain('data-rnw-delta')` reads as "a delta element was
streamed". No such element is emitted. The match comes from the script's own selector text,
which I confirmed directly:

```
emitted delta contains data-rnw-delta: true
...as part of: :not([data-rnw-delta]):not([data-rnw-runtime])
emits any <style data-rnw-delta> element: false
```

Assert on `__RNW_DELTA__` instead; the current assertion breaks silently if that selector is
ever reworded.

### T5. The concurrency test does not pin the change set's headline design

`modules/styleInjection/__tests__/index-test.node.js:338-378` asserts each request's delta
contains its own rule. With 10ms/20ms delays the drains never overlap, so a process-wide
watermark satisfies both. The observable consequence of the branch's top commit ("Derive the
SSR delta from a sheet revision log, not from who inserted") is that **B's delta also carries
the rule A compiled** — which the real implementation does, and which a shared watermark
would not. That assertion is missing. (My own concurrency probe shows the same effect: B's
delta carried 2 rules for 1 created.)

### T6. Coverage holes in the transform, all on paths I found defects in

No test exercises: **backpressure** (every sink calls `callback()` immediately — this is why
finding #1 survived), **`unpipe`** (zero occurrences in `__tests__/`; the listener-removal
code at `styleInjection/index.js:351-356` is uncovered — see finding #11), **multiple
destinations** (`injector.pipe(...)` appears twice in the whole suite, both single-destination,
so the `downstream` loop only ever runs with length 1), or **a destination whose `flush()`
throws**. `ingestDelta.js:332`'s `DOMContentLoaded` listener is also dead code as far as the
suite is concerned — deleting the line leaves every test passing, because
`dom-ingestDelta-test.js:411-434` drives the hook by hand.

Trap 6 (`styleInjection/index.js:291`) is only ever exercised in its always-return-early
mode: in `'without a prelude…'` the shell is never emitted, so the only delta comes from the
`isFinal` exemption in `_flush`. Nothing tests the guard *flipping* — no prelude, app emits
its shell mid-stream via `<StyleSheetAnchors>`, deltas then start flowing — which is the
entire React-rendered-`<head>` story and the case behind my suspected finding S1.

Also uncovered: `<StyleSheetAnchors>` is never combined with the transform, never rendered
into `<head>`, and never hydrated (its own docblock says hydration byte-equality is the
point); a `runInRequestScope` callback that throws (76 call sites, none throwing, and
`createAsyncContext.js:85-98` has no `try/finally`); `unstable_setForHydration` called twice
(all 18 call sites call it once, though "first write wins" is documented as load-bearing);
and there is no `src/__tests__/` asserting that the four new top-level exports resolve at all.

### T7. Assertions to tighten (mutation-verified, each one survives a real weakening)

- `hydrationState/index.js:174` — changing `nonce != null && nonce !== ''` to `nonce != null`
  leaves all 249 module tests passing and emits `<script nonce="">`, which a
  `script-src 'nonce-…'` policy blocks. **The identical untested branch exists in
  `exports/StyleSheet/index.js`'s `nonceAttr`.**
- `escapeForAttr`'s `&` replacement: the adversarial nonce in the test
  (`'a"><script>alert(1)</script>'`) contains no `&`, so deleting `.replace(/&/g,'&amp;')`
  passes.
- `store.js:120-123`'s `parsedGlobal` latch and `:149-151`'s `if (!values.has(key))` are both
  deletable with all tests passing.
- `streaming-test.node.js:469-471` is a tautology: line 468 already asserted
  `second === first`, so `anchors(A+A) === anchors(A)*2` holds for any string.
- Four `toContain('nonce="…")` checks pass when 5 of 6 anchors lose their nonce; the repo
  already has the right pattern at `getStyleElements-test.node.js:102`
  (`toHaveLength(orderedGroups.length)`).
- `AppRegistry/__tests__/index-test.node.js:35-47` — the replacement for the inline element
  snapshot dropped the snapshot's *absence* guarantees (no extra props); add
  `expect(Object.keys(element.props).sort()).toEqual(['WrapperComponent','children','rootTag'])`.

The `ScrollView` and `streaming-test.node.js` modifications are both **strengthenings**, not
weakenings, and the `dom-ingestDelta-test.js` changes are purely additive. No snapshot in the
change set was regenerated to match new output.

### T8. `configs/jest.config.node.js` hides nothing

The only change is `fakeTimers.doNotFake: ['queueMicrotask']`; no ignore patterns were added
and `testMatch` is unchanged. The stated rationale is accurate. Separately, and more
important: **`packages/streaming-ssr-e2e` is matched by neither jest config, is not a
workspace, and is not in `.github/workflows/tests.yml` or `npm run test`.** It is the only
place `hydrateRoot(document, …)` and `<StyleSheetAnchors>`-in-`<head>` are exercised at all,
and CI never runs it.

---

## API coherence

> **LANDED.** All five recommendations in this section are in the tree; the old spellings
> are gone from source, tests, docs and the e2e harness. `getShellGroups()` →
> `StyleSheet.takeShellGroups()`; `unsafe_*` → `unstable_*`; `StyleSheetAnchors` →
> `StyleSheet.Anchors`; the six server-only names moved to a `react-native-web/server`
> subpath (a checked-in `server/package.json` directory shim, **not** an `exports` map —
> adding one would break the deep `dist/…` imports this package has always allowed);
> `runInRequestScope` and `configureRequestScope` stayed top-level. The mechanical problem
> below is fixed for seven of the nine and is **not** fixed for those two — they are still
> rewritten to `react-native-web/dist/index`, with the options and their cost recorded in
> `SUSPENSE-TODO.md` → "API coherence — landed". The section below is left as written.

Upstream's top-level surface is 62 exports, every one of which mirrors `react-native`, plus
exactly one prefixed name in the entire source (`unstable_createElement`). The fork adds
nine with no RN counterpart. My honest read: **it does not read as one library.** It reads
as `react-native-web` with an SSR framework bolted onto the same barrel — and the barrel is
the wrong place for it, for a mechanical reason as much as an aesthetic one.

**The mechanical problem first.** `packages/babel-plugin-react-native-web` rewrites
`import { X } from 'react-native-web'` into a deep import *only* for names in its generated
module map, and that map is generated from directory names under `src/exports/`
(`scripts/createBabelReactNativeWebModuleMap.js:19-22`). None of the nine is a directory
there. Every one of them therefore falls through to
`react-native-web/dist/index` — the whole barrel (`babel-plugin-react-native-web/src/index.js:56-64`).
So a consumer who imports `StyleSheetAnchors` loses the plugin's deep-import benefit for
that file entirely. That is not a style opinion; it is a regression in the package's own
tree-shaking story, and it applies to all nine.

**Naming.** Three separate conventions are in play at one level of the namespace:

- `get*` vs `take*`. The intent is clear and good — `take` mutates, `get` does not. It is
  then broken by the most important function on the surface: `getShellGroups()` calls
  `markShellEmitted()` **and** `resetRequestDelta()` (`index.js:460-463`). It is the single
  most side-effecting call in the whole design — it decides what every subsequent delta
  contains — and it is spelled `get`. `takeShellGroups()` is the honest name and costs
  nothing to change; `getShellGroups` has one in-tree caller
  (`AppRegistry/getStyleElements.js:124`) plus `StyleSheetAnchors`. **Worth the breaking
  change.**
- `unsafe_` (`Dimensions.unsafe_setForHydration`, `Appearance.unsafe_restoreFromHydration`)
  matches neither React's `UNSAFE_` nor RN's `unstable_` — and the same diff uses
  `unstable_` correctly two lines away (`Dimensions.unstable_hydrationStore`). Two prefixes
  on one class, neither of which is the ecosystem's. These are pre-`1.0` escape hatches, so
  renaming to `unstable_setForHydration` / `unstable_restoreFromHydration` is cheap.
  **Worth it**, and it makes the pair consistent with `unstable_hydrationStore`.
- `createStyleInjectionTransform` is the only `create*` factory at top level that is not an
  RN API. Fine in isolation, but see below.

**Does `StyleSheetAnchors` belong next to `View` and `Text`?** No. It is the only React
component in the barrel that is not an RN component, and a user scanning the export list
cannot tell it from one. It is also a *StyleSheet* concern — it renders the StyleSheet
shell, it lives at `exports/StyleSheet/StyleSheetAnchors.js`, and the three other spellings
of the same emission are all on `StyleSheet` or `AppRegistry`. `StyleSheet.Anchors` (or
`StyleSheet.unstable_Anchors`) puts it where its three siblings already live, keeps the
component-looking name out of the component list, and — because `StyleSheet` *is* in the
module map — restores the babel plugin's deep import. **Worth the breaking change; it is
undocumented today so nobody can be depending on the current spelling.**

**How many of the nine need to be top-level?** By my count, two.

| Export | Recommendation |
|---|---|
| `runInRequestScope` | Keep. It is the entry point; everything else is called inside it. |
| `configureRequestScope` | Keep, but it is startup-only and could fold into an options bag. Low value either way. |
| `getScopedState`, `getProcessState`, `hasRequestScope` | **Demote.** These exist for "downstream SSR helpers", which is a real but narrow audience, and `getProcessState` in particular has no caller outside RNW. Three of the nine additions are internals promoted to the front door. A `react-native-web/ssr` (or `/server`) subpath keeps them available without putting them beside `View`. Not worth a breaking change on its own — do it when the subpath happens. |
| `createStyleInjectionTransform` | **Move to a server subpath.** It is Node-only, it throws in the browser build (`styleInjection/index.browser.js:35-41`), and it is currently kept safe by a `browser` field map that covers `dist/…` paths only — not the published `src/`, which `files` also ships. A `react-native-web/server` entry makes the constraint structural instead of conditional. Worth doing before this is depended on. |
| `registerHydrationState`, `takeHydrationStateHTML` | Same subpath. `takeHydrationStateHTML` is server-only in fact if not in type; `registerHydrationState` is explicitly "call once at server entry". |
| `StyleSheetAnchors` | **Move onto `StyleSheet`** (above). |

The shape I would land on: `runInRequestScope` (and maybe `configureRequestScope`) stay
top-level because they wrap the render; `StyleSheetAnchors` becomes `StyleSheet.Anchors`;
the remaining six move to `react-native-web/server`. That takes the fork's addition to the
top-level surface from nine to one or two, and none of the six that move is documented yet,
so the cost is close to zero **now** and rises with every consumer.

**One thing the surface gets right,** worth saying: hiding the `useSyncExternalStore`
triple behind `Dimensions.unstable_hydrationStore` / `Appearance.unstable_hydrationStore`
rather than adding `Dimensions.subscribe` next to `Dimensions.addEventListener` is the
correct call, and the reasoning recorded at `Dimensions/index.js:157-173` (including the
`babel-plugin-add-module-exports` constraint) is exactly the kind of thing that should be
written down.

---

## What I did not cover

- No real-browser verification of findings 2, 3, 7 or 8 — all four were established in
  jsdom / `renderToStaticMarkup` plus source reading.
- React 19 was not exercised at all, because it is not installed in this tree (finding 10).
- `packages/streaming-ssr-e2e/specs/fouc.spec.js`'s frame-sampling methodology was not
  audited; it passes and its self-check ("the frame sampler catches a deliberate flash")
  does fire, which is a good sign.
- I did not review `PRIOR-ART.md`, `REACT19-FINDINGS.md` or `repro/`.
