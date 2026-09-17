# Where React's hydration tolerates out-of-band DOM nodes

Measured, not inferred. Next.js **16.3.4**, React / React DOM **19.3.0**, App Router,
a single root layout rendering `<html>`/`<head>`/`<body>` so `hydrateRoot(document, …)`
owns the whole document — App Router's own entry point
(`packages/next/src/client/app-index.tsx`: `const appElement: HTMLElement | Document = document`).

Measurement is React's own `__reactFiber$` back-pointer on each node: DOM node → which
fiber React believes it is. Every run also captures `console.error`, `pageerror`, and
whether node identity survived (React reused the node vs. discarded and recreated it).

## Verdict

**One case skews. Everything else is clean.**

> A foreign `<style>` interleaved **between React-rendered `<style>` siblings in `<head>`**.

**Byte-splicing does not avoid it.** Splicing into the raw HTTP response bytes before the
browser's parser ever runs — Next's own `createHeadInsertionTransformStream` mechanism —
skews *identically* to mutating the DOM by script after parse. The insertion route is
irrelevant; only what the node is and where it sits matter.

## The mechanism

React matches hydration candidates **by tag type**. A foreign node whose tag differs from
what React expects at that position is skipped. A foreign node whose tag *matches* is
indistinguishable from the real one — empty `<style>` anchors are textually identical — so
React binds its fiber to the intruder and every subsequent sibling shifts by one.

This is why Next.js survives its own out-of-band injections: flight data goes in as
`<script>`, and its other head content is `<link>`/`<meta>`. None of them collide with a
same-tag React-rendered sibling. `useServerInsertedHTML` output is React-owned and in the
fiber tree, so it never arises there.

Position matters for the same reason: **after** the last sibling there is no expected node
left to mis-match against, so it is clean.

## Results — production build

Prod matters because React gates hydration warnings behind a dev-only flag: the skew below
is **completely silent in production**, and React *reuses* the mis-bound node rather than
discarding it, so nothing visibly breaks at hydration time. The damage is latent.

### Script-driven insertion (after parse)

| Scenario | Result | Console |
|---|---|---|
| `<style>` in `<head>`, **between** anchors | **SKEWED** (1→2, 2→3, 3→unowned) | silent |
| `<style>` in `<head>`, after last anchor | clean | silent |
| `<script>` in `<body>`, between siblings (mimics flight push) | clean | silent |
| `<script>` in `<body>`, after last sibling | clean | silent |
| `<style>` in `<body>`, between `<div>` siblings | clean | silent |
| `<style>` in `<body>`, after last sibling | clean | silent |
| `<script>` in `<head>`, between anchors | clean | silent |
| `<script>` in `<head>`, after last anchor | clean | silent |
| control: `useServerInsertedHTML` (React-owned) | clean | silent |
| control: React 19 `<style precedence>` (React-hoisted) | clean | silent |

Note `<style>` in `<body>` among `<div>` siblings is **clean** while the same tag among
`<style>` siblings in `<head>` skews. That isolates the mechanism to tag matching rather
than to `<head>` being special.

### Byte-spliced into the response (before parse)

| Scenario | Result | Console |
|---|---|---|
| `<style>` in `<head>`, **between** anchors | **SKEWED** (2→3, 3→unowned) | silent |
| `<style>` in `<head>`, after last anchor | clean | silent |
| `<script>` in `<head>`, between anchors | clean | silent |
| `<meta>` in `<head>`, between anchors | clean | silent |
| `<link>` in `<head>`, between anchors | clean | errors (unrelated: href fetch) |
| `<style>` in `<body>`, between siblings | clean | silent |
| `<script>` in `<body>`, between siblings | clean | silent |

## What this means for react-native-web's streaming fork

Our per-priority-bucket anchors **are** `<style>` elements, so a foreign `<style>` placed
among them is the one configuration React silently mis-binds.

1. **A Fizz head-insertion transform does not rescue the `<head>`-suspends case.** Splicing
   anchors into head as bytes skews exactly as inserting them by script does.
2. The fix already shipped — emitting no DOM node at all and calling `insertRule` on the
   existing anchor's CSSOM — remains correct, and is now correct for a measured reason
   rather than an assumed one.
3. Anchors interleaved in a React-owned `<head>` must be **React-owned**, which is what the
   `/document` route in `packages/streaming-ssr-e2e` already does.
4. Appending strictly **after** all React-rendered head children is clean — but that is not
   a stable position once `<head>` itself streams, which is the open case.

## Reproduce

```
cd repro/nextjs-head-hydration
npm install
node scripts/run-probe.js --mode=prod              # script-driven insertion
node scripts/run-byte-splice-probe.js --mode=prod  # byte-spliced insertion
```

`--mode=dev` hangs on this machine at `next dev` startup (the readiness check never
resolves); prod is the mode that matters anyway, since it is the silent one. Not
investigated further — flagged rather than hidden.
