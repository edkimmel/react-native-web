# Streaming SSR

This fork adds the pieces React Native for Web needs to work under React's
streaming server renderer: per-request isolation for module-level state, a CSS
format that can be streamed across Suspense boundaries without a flash of
unstyled content, and a frozen device-state snapshot every boundary hydrates
against however late it hydrates.

Upstream RNW compiles CSS at runtime and keeps it in one process-wide sheet
that is serialised once, after the render finishes. Neither half of that
survives streaming. A Suspense boundary that resolves after `</head>` is on the
wire compiles rules that have nowhere to go, and `renderToPipeableStream`
interleaves concurrent renders through the same module-level state, so one
request's viewport or color scheme lands in another's markup.

Everything here is additive. A client-only or `renderToString` app that never
calls these APIs behaves exactly as upstream does.

- [Entry points](#entry-points)
- [Quickstart](#quickstart)
- [React version support](#react-version-support)
- [End-to-end example](#end-to-end-example)
- [How it works](#how-it-works)
- [Per-request scoping](#per-request-scoping)
- [The streaming adapter](#the-streaming-adapter)
- [Worker threads](#worker-threads)
- [The lower-level CSS API](#the-lower-level-css-api)
- [AppRegistry SSR](#appregistry-ssr)
- [Per-request device state](#per-request-device-state)
- [Hydration state](#hydration-state)
- [Gotchas](#gotchas)
- [Known limitations](#known-limitations)

## Entry points

There are two, and the split is by _where the code runs_, not by what it does:

```js
// Anywhere: these wrap the render, so they are imported where the app is.
import { runInRequestScope, configureRequestScope } from 'react-native-web';

// Server only: the response's business — the stream transform, the hydration
// payload, and the scoped-state accessors downstream SSR helpers build on.
import {
  renderToStreamingResponse,
  createStyleInjectionTransform,
  createWorkerResponse,
  pipeWorkerResponse,
  isWorkerResponseMessage,
  registerHydrationState,
  takeHydrationStateHTML,
  getScopedState,
  getProcessState,
  hasRequestScope
} from 'react-native-web/server';
```

`createStyleInjectionTransform` wraps a `node:stream` Transform, so nothing in
the server entry belongs in a browser bundle; keeping it out of the top-level
barrel makes that structural rather than something the `browser` field map has
to catch. The rest of this fork's additions hang off the APIs they belong to —
[`StyleSheet.Anchors`](#stylesheet-anchors), `StyleSheet.takeShellHTML()`,
`Dimensions.unstable_hydrationStore` — so the top-level surface stays
react-native's.

`react-native-web/server` resolves through the package's `exports` map. It has
to: Node's ESM resolver does no directory resolution and no `main`-field
resolution for a bare-specifier subpath, so the pre-`exports` trick of checking
in a `server/package.json` — the way `react-dom/server` did it — fails with
`ERR_UNSUPPORTED_DIR_IMPORT` from a native `"type": "module"` server, which is
exactly this entry point's audience. `require()` and every bundler resolve the
shim fine, which is why it survived review; an `exports` map is the only
mechanism that also satisfies Node ESM. (The shim is still shipped, as the
fallback for toolchains that do not read `exports` at all.)

The cost is that `exports` is package-wide encapsulation: once it exists, a
subpath not named in the map is _blocked_. Stock react-native-web ships no
`exports` map at all, so every deep path resolved by ordinary directory
lookup; adding one to reach `/server` from Node ESM means every deep path now
has to be named, and the map is generated rather than hand-written —
`node scripts/generateExportsMap.js`, with `--check` to fail a stale one.

Two things rule out doing it with patterns alone. A pattern's `*` matches
across slashes, so `dist/exports/*` catches both `dist/exports/View` (a
directory with an `index.js`) and `dist/exports/Text/TextAncestorContext` (a
file) — which need different targets. And a fallback array does not
disambiguate them: **the next array entry is tried only when a target is
invalid, never when the file is merely missing**. That is true of Node, and —
measured, after assuming otherwise and being wrong — equally true of rspack.
The mixed cases are real, not hypothetical: `dist/exports/StyleSheet` is a
directory, `dist/exports/StyleSheet/dom` is also a directory, and
`dist/exports/StyleSheet/dom/ingestDelta` is a file, all under one pattern.

What does work is that an exact key outranks a pattern. The generator emits an
exact key for every directory holding an `index.js` (371 of them) plus one
`*` pattern per tree root mapping everything else to `<path>.js`. Every real
file is then reachable at any depth, extensionless or not, with nothing left
to guess.

This is not theoretical tidiness: `@expo/html-elements` imports
`react-native-web/dist/exports/Text/TextAncestorContext` extensionless, and it
fails the consuming app's build outright under any single-target arrangement.
Verify any change against a real `npm pack` tarball installed into a clean
project — the workspace and every bundler resolve paths the published package
does not.

Conditions: the `node` condition sends real Node to `dist/cjs/`, because the
`dist/` ESM tree's own relative imports are extensionless and Node ESM cannot
load them; `module` (which Node never matches) keeps ESM-capable bundlers on
the tree-shakeable `dist/`. Root and `/server` carry the _same_ condition
ladder on purpose — if one resolved to `dist/` and the other to `dist/cjs/`, a
bundle would contain two `StyleSheet` modules and the transform would read a
different sheet registry than the components write to.

## Quickstart

For the common shape — React renders the app, you supply `<head>` as a string
— `renderToStreamingResponse` is the entire server side. It opens the request
scope, applies this request's device state, assembles the document around the
stylesheet shell and the hydration snapshot, and pipes React into the response
in the order the transform needs.

```jsx
// server.js
import express from 'express';
import { AppRegistry } from 'react-native-web';
import { renderToStreamingResponse } from 'react-native-web/server';
import App from './App';

AppRegistry.registerComponent('App', () => App);

const app = express();

app.get('/*', (req, res) => {
  renderToStreamingResponse({
    element: AppRegistry.getApplication('App', {}).element,
    response: res,
    head:
      '<title>App</title>' +
      '<meta name="viewport" content="width=device-width">',
    bootstrapScripts: ['/client.js'],
    colorScheme: req.cookies.theme === 'dark' ? 'dark' : 'light',
    viewport: { fontScale: 1, height: 800, scale: 1, width: 1024 }
  });
});

app.listen(3000);
```

```jsx
// client.js
import { AppRegistry } from 'react-native-web';
import App from './App';

AppRegistry.registerComponent('App', () => App);
AppRegistry.runApplication('App', {
  hydrate: true,
  rootTag: document.getElementById('root')
});
```

That is the whole integration. Everything in [How it works](#how-it-works)
still happens — the shell goes out in `<head>`, each late boundary's CSS
follows as a delta at its own chunk boundary, and every boundary hydrates
against the device state this request rendered with — but none of the
orderings that make it work are yours to get right. See
[`renderToStreamingResponse`](#rendertostreamingresponseoptions) for the
options, and [Gotchas](#gotchas) for the five silent failures it owns on your
behalf.

**Reach past it** — to `createStyleInjectionTransform` and the
[end-to-end example](#end-to-end-example) below, which is this same server
written out by hand — when React renders `<html>`/`<head>` itself
(`hydrateRoot(document, …)`, or a `<head>` that is [itself inside the
stream](#stylesheet-anchors)), or when your framework owns the response and
hands you its own stream.

## React version support

**React 18.3.1 and every React 19 are supported**, and no application change
is needed to move between them — with exactly one floor above that:

> ### The one version floor
>
> **A Suspense boundary above `<html>`/`<head>` — the whole document rendered
> inside a boundary — requires React >= 19.1.**
>
> It needs Fizz's Suspense-aware preamble, which shipped in **React 19.1.0**.
> No 19.0.x release has it (verified through 19.0.8, the last of that line);
> neither does React 18. Without it React emits something that is not a
> document at all and no library can repair it. Everything else in this guide,
> [`<StyleSheet.Anchors />`](#stylesheet-anchors) included, works from 18.3.1
> up.

Verified, not inferred: `preparePreamble` and
`request.completedPreambleSegments` appear in
`react-dom/cjs/react-dom-server.node.development.js` from 19.1.0 onwards and
in no 19.0.x build. The _lowercase_ string `preamble` does not occur in a
19.0.x server build at all; case-insensitively there are eight occurrences,
and all eight belong to React 19.0's stylesheet-resource code
(`flushStyleInPreamble`, `flushStylesInPreamble`, and a `PREAMBLE`
insertion-state constant) rather than to anything in Fizz's document preamble.
So this is not a rename — the concept is absent. (Counted with `grep -o` over
that file in fresh npm installs of react-dom 19.0.0 and 19.0.8; the same
count in 19.1.0 is 13 `preparePreamble` and 12 `completedPreambleSegments`.)
What 19.0.x does instead is visible in the bytes:
`renderState.htmlChunks` / `headChunks` are still `null` when
`flushCompletedQueues` writes the completed root segment, so the doctype and
the `<html>`/`<head>` open tags are never written, and the response carries a
stray `</head>` and `<body>` with nothing opening them. React 18.3.1 fails
differently — it streams the whole resolved document, `<!doctype html><html>`
and all, nested inside a `<div hidden>`. Both are pinned by
`streamingHead.spec.js`, one test each, so a change on either fails loudly.

So "React 19" is not one target. The `^19.0.0` peer range spans two Fizz
preamble behaviours; the package handles both for the shapes it supports (see
[root-level Suspense](#root-level-suspense-under-react-191)), and a future
minor could add a third.

An earlier investigation also ran the Node/jsdom jest suites against
**18.3.1, 19.0.0, 19.1.1, 19.2.0 and 19.3.0** (see `REACT19-FINDINGS.md`), but
those React versions were installed ad hoc into a scratch directory that was
never checked in and no longer exists, so that figure is a historical record,
not something a reader can rerun. What _is_ reproducible today is the
real-browser matrix in [real-browser coverage](#real-browser-coverage): a
checked-in script installs a given React version, rebuilds the harness against
it, and reruns the Playwright suite, printing the pass/skip/fail counts back
out.

The two assumptions this design rests on were checked against React 19's Fizz
source and hold:

- React does not hoist, dedupe or reorder the `<style data-rnw-group>`
  anchors. A streamed chunk no longer emits a `<style>` of its own, so nothing
  depends any more on what React does with a plain `<style>` inside a Suspense
  chunk.
- Fizz still guarantees a clean element boundary at `completeWriting()` +
  `flushBuffered()` → `destination.flush()`, in the `finally` of
  `flushCompletedQueues()` — same place, same shape, in both the development
  and production Node builds. The internal buffer size did move, but later
  and by less than an earlier note claimed: `currentView` is 2048 bytes on
  18.3.1, 19.0.0, 19.1.1 and 19.2.0, and 4096 only from 19.3.0. Nothing here
  depends on the number.

That verification is Node plus jsdom, and it is no longer the only kind: a
Playwright suite runs the built package in a real browser, document-level
`hydrateRoot(document, …)` included. See
[real-browser coverage](#real-browser-coverage) below for what it does and does
not cover, and [what has not been verified](#known-limitations) for the
remaining gaps — chiefly Firefox and WebKit, Web Streams, CSP enforcement,
concurrent load, and React 19.4+ / canary / experimental builds.

### Real-browser coverage

`packages/streaming-ssr-e2e/` is a Playwright harness. It is deliberately not
a workspace package: it consumes the built `dist` the way a consumer would,
through a real Node server and a real browser, so the browser bundle's
`browser`-field mapping and the Node stream plumbing are both exercised as
shipped (`E2E_REACT_DIR` points the whole harness — server, app and library —
at another React; see `build.js`).

<!-- drift-check: spec-files -->

The suite is **9 spec files** under `packages/streaming-ssr-e2e/specs/`. That
number is asserted against the directory by `npm test`; the per-version counts
below are not, and are only rechecked by rerunning the matrix.

<!-- /drift-check -->

**33 specs on Chromium, green on React 18.3.1, 19.0.0, 19.1.1, 19.2.0 and
19.3.0** — every version in the matrix. Reproduce it with
`npm run e2e:matrix:all` (or `npm run e2e:matrix -- 18.3.1 19.3.0` for a
subset) from `packages/streaming-ssr-e2e/`.
`scripts/react-version-matrix.js` installs each version into a local cache,
points the harness at it, rebuilds, reruns the suite, and prints a
passed/skipped/failed count per version. It also reads the React that actually
_ran_ back out of the run output and prints it next to the one it installed
(`React 19.3.0 (ran as 19.3.0)`), so a row can no longer describe a version
the harness quietly did not use — and it refuses to report a run where
nothing ran, where the cached install is a mismatched trio, or where a test
needed a retry:

| React  | passed | skipped | failed |
| ------ | ------ | ------- | ------ |
| 18.3.1 | 29     | 4       | 0      |
| 19.0.0 | 30     | 3       | 0      |
| 19.1.1 | 30     | 3       | 0      |
| 19.2.0 | 30     | 3       | 0      |
| 19.3.0 | 30     | 3       | 0      |

`react@experimental` is not in the default matrix — its version is a moving
target rather than something a table can pin — but the same script was pointed
at it in this round and it came back green, with the three 18-and-19.0-only
specs skipping as intended.

A skip here is a deliberate complement, not an untested shape: every skipped
spec has a sibling on the other side of the gate asserting what _that_ version
does instead. On 19.1+ the three skips are the two negative specs pinning how
18.3.1 and 19.0.x each fail without the Suspense-aware preamble, plus the
React-18-only anchor spec; 18.3.1 skips four for the mirror-image reason. No
behaviour is skipped on every version. The version-dependent shapes are all in
`streamingHead.spec.js` and `fouc.spec.js`:

| Shape                                                        | Runs on       |
| ------------------------------------------------------------ | ------------- |
| Suspense in `<head>`, `<StyleSheet.Anchors />` above it      | all five      |
| Suspense in `<head>`, anchors inside it (and its FOUC audit) | React 19+     |
| …the React 18 diagnosis for the same route                   | React 18      |
| Suspense above `<html>`/`<head>`                             | React >= 19.1 |
| …what 18.3.1 does instead                                    | React 18      |
| …what 19.0.x does instead                                    | React 19.0.x  |

The last three are why the gate for that shape asks
`hasSuspenseAwarePreamble(version)` and not `reactMajor >= 19`: the earlier
major-only gate ran the 19.1+ spec on 19.0.0, where the page never reaches the
state it waits for and the test timed out at 60 s. The distinction is not a
test detail — it is the package's one real version floor, see
[the one version floor](#react-version-support).

What they check:

- **Cascade, out of a real CSSOM.** A group-3 longhand carried by the shell
  still beats a group-2 shorthand that only reached the browser in a later
  chunk, read back through `getComputedStyle` rather than inferred from
  document order; and every streamed rule is found inside its own group
  anchor's sheet, with no `data-rnw-delta` node anywhere in the response.
- **FOUC, per painted frame.** A sampler records the styling of both probes
  on every frame the browser actually painted, from the first frame of the
  document, and asserts every one of them is correct — not just the end
  state. A negative control introduces a real flash and confirms the sampler
  catches it, so a passing audit is evidence rather than an absence of
  evidence.
- **Hydration against the server snapshot.** A late boundary hydrates with
  the `Dimensions`/`Appearance` values the server rendered with, then
  reconciles to the browser's, with the page's viewport and color scheme
  deliberately set to disagree with the server's.
- **Document-level hydration.** `hydrateRoot(document, …)` over a
  React-rendered `<head>` that streamed chunks have already written into,
  measured off React's own `__reactFiber$` back-pointers — which node React
  believes each fiber owns — rather than off the absence of a warning. See
  [rendering `<head>` through React](#rendering-head-through-react).
- **Client-bundle purity.** No Node builtin survives into the browser bundle,
  and the browser build of `createStyleInjectionTransform` throws rather than
  degrading.

Not covered: Firefox and WebKit (Chromium only); Web Streams
(`renderToReadableStream`, per [known limitations](#known-limitations)); CSP
enforcement — a nonce is threaded through and asserted on the emitted
elements, but no response carries a `Content-Security-Policy` header, so
nothing proves a real policy accepts the stream; and concurrent load, so the
per-request isolation is tested for correctness rather than under contention.

## End-to-end example

Three files: a shared app, a Node server, and a client entry. Imports are shown
from `react-native-web`; if you have not aliased the package, import from
`@edkimmel/react-native-web` instead.

The server below is the long form of
[`renderToStreamingResponse`](#rendertostreamingresponseoptions) — the same
arrangement, written out against the lower-level API. Read it when you need to
change part of it; reach for the one call when you do not.

### The app

```jsx
// App.js
import React, { Suspense, lazy } from 'react';
import {
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions
} from 'react-native-web';

// Rendered only after the boundary resolves, so its CSS is compiled after
// <head> has already been streamed. This is the case the delta channel exists
// for.
const Details = lazy(() => import('./Details'));

export default function App() {
  const colorScheme = useColorScheme();
  const { width } = useWindowDimensions();

  return (
    <View style={[styles.page, colorScheme === 'dark' && styles.pageDark]}>
      <Text style={styles.title}>Width: {width}</Text>
      <Suspense fallback={<Text>Loading…</Text>}>
        <Details />
      </Suspense>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: '#fff', flex: 1, padding: 16 },
  pageDark: { backgroundColor: '#111' },
  title: { fontWeight: 'bold' }
});
```

### The server

```jsx
// server.js
import express from 'express';
import { renderToPipeableStream } from 'react-dom/server';
import {
  AppRegistry,
  Appearance,
  Dimensions,
  runInRequestScope
} from 'react-native-web';
// Server-only: the stream transform, the hydration payload and the
// scoped-state accessors. See "Entry points" above.
import {
  createStyleInjectionTransform,
  takeHydrationStateHTML
} from 'react-native-web/server';
import App from './App';

AppRegistry.registerComponent('App', () => App);

const app = express();

app.get('/*', (req, res) => {
  // Everything — the render AND the piping it sets up — goes inside the
  // scope. The per-request CSS delta and the device state live there.
  runInRequestScope(() => {
    const colorScheme = req.cookies.theme === 'dark' ? 'dark' : 'light';
    const viewport = { fontScale: 1, height: 800, scale: 1, width: 1024 };

    Dimensions.set({ screen: viewport, window: viewport });
    Appearance.set({ colorScheme });

    const { element } = AppRegistry.getApplication('App', {});
    const nonce = res.locals.cspNonce;

    const injector = createStyleInjectionTransform({
      nonce,
      // Called once, immediately before React's first byte is forwarded.
      // `shellCSS` is the whole cumulative sheet, one <style> per group; put
      // it wherever <head> ends.
      prelude: (shellCSS) =>
        '<!doctype html><html lang="en"><head>' +
        '<meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width">' +
        '<title>App</title>' +
        // The hydration snapshot: this request's device state, as a
        // <script>. Parallel to the CSS shell, not part of it — the
        // transform does not emit it and the app decides where it goes.
        takeHydrationStateHTML({ nonce }) +
        shellCSS +
        '</head><body><div id="root">',
      epilogue: '</div></body></html>'
    });

    const { abort, pipe } = renderToPipeableStream(element, {
      bootstrapScripts: ['/client.js'],
      onShellReady() {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // Pipe the injector at its destination FIRST, then hand the injector
        // to React. React's end-of-pass flush signal only reaches `res` once
        // this transform knows where its output goes.
        injector.pipe(res);
        pipe(injector);
      },
      onShellError(error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><p>Something went wrong</p>');
      },
      onError(error) {
        console.error(error);
      }
    });

    setTimeout(abort, 10000);
  });
});

app.listen(3000);
```

### The client

```jsx
// client.js
import { AppRegistry } from 'react-native-web';
import App from './App';

// No hydration wiring. The <script> the server emitted is the frozen server
// snapshot, and `useWindowDimensions` / `useColorScheme` read it through
// React's `getServerSnapshot` for every subtree React hydrates — however
// late that subtree hydrates — then reconcile to the live value as an
// ordinary update.
AppRegistry.registerComponent('App', () => App);
AppRegistry.runApplication('App', {
  hydrate: true,
  rootTag: document.getElementById('root')
});
```

Nothing on the client needs to be told about the streaming CSS format. RNW
infers it from the DOM when its first sheet boots, and adopts the rules that
are already in the document so runtime `StyleSheet.create` calls dedupe against
them instead of re-inserting.

## How it works

The sheet is split into a **shell** and a series of **deltas**.

The shell is the whole cumulative process sheet, serialised at one instant:
after the shell render has finished compiling CSS, and before any body markup
is on the wire. It is emitted as one `<style data-rnw-group="G">` element per
compiler group, ascending — including the groups that are currently empty.
Taking the shell also moves the request's delta watermark, synchronously, so no
rule can end up in neither the shell nor a later delta.

Each delta is the set of rules recorded in the sheet since the request's last
flush. It goes out at a chunk boundary as **one self-removing inline
`<script>`, and no DOM node at all**. The script looks up each group's anchor,
calls `insertRule` on that anchor's own `CSSStyleSheet`, pushes the same rules
onto `window.__RNW_DELTA__` for RNW's runtime bookkeeping, and then removes
itself from the document. It runs synchronously at parse time, so the browser
applies the rules the moment it reaches them — that is the no-FOUC guarantee —
and it does not need RNW's runtime to have loaded; registering the rules with
the runtime is a separate step the queue defers until RNW boots. Once the
script has run, the DOM is byte-identical to what React server-rendered.

Two details of the script that are worth knowing even though its contents are
not API. Each chunk carries a sequence number and records it in a window map,
so a deliberately replayed chunk inserts nothing twice; and every `insertRule`
is wrapped, because the CSSOM throws on a rule it does not understand and one
such rule must not drop the rest of the chunk.

**Why no element.** The previous format streamed a
`<style data-rnw-group data-rnw-delta>` into `<body>` and relocated it into
`<head>` behind its group's anchor. That breaks `hydrateRoot(document, …)`.
React hydrates a parent's children by walking DOM siblings in order, so a
`<style>` React never rendered shifts every anchor after it by one, and React
binds its group-3 fiber to the element sitting in group 2.2's slot. React 18
logs a single development warning and leaves the DOM alone; production is
silent, and React reuses the mis-bound node, so nothing visibly breaks. The
damage is latent — the next render of `<head>` writes group-3 rules into a
group-2.2 element, the exact cascade inversion the anchors exist to prevent.
Inserting into the CSSOM leaves no node behind, so there is nothing for
hydration to skew against. See
[rendering `<head>` through React](#rendering-head-through-react).

**Why the cascade is stronger this way, not weaker.** The rules live in the
anchor's own sheet, so their cascade bucket _is_ the anchor's position in
`<head>`. The old format depended on landing at the right offset among the
anchor's siblings, and that dependency is what broke. Order within a group
stays irrelevant, because styleq dedupes by property key: two rules in one
group never target the same property on the same element.

**When a chunk finds no anchor: it queues, it never creates.** The script
does not synthesise the missing `<style>`. It flags that group's payload
pending — `else{b.p=1;}` in the emitted script — pushes it onto
`window.__RNW_DELTA__`, and applies nothing. Creating the element instead is
the single change that puts back the hydration skew this whole format exists
to remove: a `<style>` React did not render, sitting between `<style>`
elements it did, is textually identical to the node React expected, so React
binds its fiber to the intruder and every later sibling shifts by one.

The pending payload is drained by RNW's client runtime: on every later chunk,
at sheet bootstrap, and from `<StyleSheet.Anchors />`'s own commit — the moment
React has actually put the anchors in the document. An entry whose anchor is
still missing keeps waiting rather than landing somewhere arbitrary, until
`document.readyState` leaves `loading`; past that point no React-rendered
anchor can still be coming, so the entry is applied through RNW's ordinary
`insert`, which will create an anchor of its own. See
`StyleSheet/dom/ingestDelta.js`.

Reaching this path at all takes a `<head>` whose anchors are themselves inside
an unresolved Suspense boundary, or a caller who streams deltas having emitted
no shell. It is not reachable from the documented flow: every shell spelling —
`takeShellHTML()`, `takeShellGroups()`, `getStyleElements()`,
`<StyleSheet.Anchors />` — emits an anchor for every group, empty ones
included. What it costs is that those rules need RNW's runtime to become
visible, where a shell anchor needs only the parser.

**Why per-group `<style>` elements.** RNW's compiler assigns rules a priority
group: a longhand (`marginTop`, group 3) must beat the shorthand it overrides
(`margin`, group 2) no matter which chunk each was discovered in. Making each
group a physically separate element in `<head>`, ascending, turns priority into
plain DOM order. `@layer` is unsupported below Chrome 99 / Safari 15.4 and
fails by rendering _nothing_, and sends a bucket it has not seen before to the
end of `<head>`, where it outranks every group above it. React's own
`precedence` hoisting is not usable either, and that one is measured rather
than assumed: on React 19, a `<style precedence="…">` emitted from `<body>`
lands at the _front_ of `<head>`, above every group anchor. React places such
an element by its own scheme, never at the cascade position a given group
needs. The empty anchor elements exist for exactly that reason — they are the
sheets a later chunk inserts into.

The same measurement matters if you use React 19 stylesheet resources
yourself. A `<style precedence>` or `<link rel="stylesheet" precedence>` is
hoisted to the front of `<head>`, above the RNW anchors, so it loses to RNW's
atomic rules whatever its specificity. To beat them, emit your stylesheet after
the anchors yourself rather than through `precedence`, or raise its specificity
deliberately.

The delta is derived from the sheet's revision log, not from which rules this
request inserted. It has to be: a lazily imported module runs
`StyleSheet.create` once per process, so for every request after the first, the
rules its boundary needs were inserted by somebody else's render. The cost is
that a request can be sent rules only a concurrent request needed. That is
inert — the client dedupes by selector — and it stops happening once the app is
warm and nothing new is being compiled.

### With JavaScript disabled

The shell is plain `<style>` markup, so everything the shell render produced
applies with no script at all. The deltas need a script — and by construction
there is nothing left for them to style if it never runs.

A delta only ever carries rules recorded _after_ `takeShellHTML()`, which the
transform calls at the first flush following `onShellReady`. Rules discovered
that late can only belong to content inside a Suspense boundary that had not
resolved when the shell went out, and React streams that content into the
document inside a `<div hidden>` that nothing reveals except React's own
inline reveal script (`$RC`, and `$RB`/`$RV` on React 19). So a client that
will not run the delta script will not run the reveal script either: the
content those rules style never appears at all. The same argument covers a
Content-Security-Policy that blocks inline scripts — it blocks React's reveal
script too — and the page degrades to the shell, which is styled.

The honest caveat: that reasoning holds for the documented flow, where the
shell is serialised by the transform. A caller who serialises the shell
_before_ the shell render — which an app rendering `<head>` through React has
to do today, see below — pushes whatever the shell render compiles into the
first delta. Those rules style shell content, which is visible with no
JavaScript at all, so with scripts off that content renders unstyled. That
flow had already departed from the documented one, but the degradation is
real: the no-JS story is narrower than it was under the old format, not
identical.

### <a id="rendering-head-through-react"></a>Rendering `<head>` through React

`hydrateRoot(document, …)` over a React-rendered `<head>` that streamed chunks
have written into is **verified working**, in a real browser, on React 18.3.1,
19.0.0, 19.1.1, 19.2.0 and 19.3.0 (`document.spec.js`, via
`npm run e2e:matrix:all`). It was previously the most likely place for a
surprise; it is now
covered by a spec that reads React's own `__reactFiber$` back-pointers to
confirm each anchor is bound to the fiber that rendered it. See
[real-browser coverage](#real-browser-coverage).

One constraint comes with it, and it is load-bearing:

> **Any `<style>` in a React-rendered `<head>` that React did not itself
> render will silently mis-bind hydration.**

That was measured against Next.js 16.3.4 / React 19.3.0 — see
`repro/nextjs-head-hydration/FINDINGS.md`. React matches hydration candidates
by tag type. A foreign node whose tag _differs_ from what React expects at
that position is skipped and costs nothing; a foreign node whose tag _matches_
is indistinguishable from the real one — empty `<style>` anchors are textually
identical — so React binds its fiber to the intruder and every later sibling
shifts by one. It is completely silent in production, and React reuses the
mis-bound node rather than discarding it, so nothing looks wrong at hydration
time. The damage is latent, surfacing only when `<head>` next renders.

Byte-splicing the element into the HTTP response before the parser sees it
does not avoid this: the measurement shows the spliced case skewing
identically to the script-inserted one. The insertion route is irrelevant;
only the tag and the position matter. This is why the delta format inserts
rules into an existing anchor's CSSOM and emits no node.

What that means in practice, if React owns your `<head>`:

- Build the anchors as React elements from `StyleSheet.takeShellGroups()`, so
  every `<style>` in `<head>` is one React rendered. `packages/streaming-ssr-e2e`'s
  `/document` route is a worked example.
- Do not splice anchors — or any other `<style>` — into that `<head>` from
  outside React, by script or by bytes.
- **With `takeShellGroups()`, `<head>` must be fully rendered before the shell
  is serialised.** The shell has to exist as React elements by the time the
  tree is built, so `takeShellGroups()` is called before the render rather
  than from a `prelude`. If `<head>` itself contains a Suspense boundary there
  is no "before the render" at which that snapshot would be right — use
  `<StyleSheet.Anchors />` instead, below. Taking the shell moves the delta
  watermark synchronously, so everything a later boundary in `<body>` compiles
  still arrives as a delta; what it costs is the no-JS caveat described above.

### <a id="stylesheet-anchors"></a>`<StyleSheet.Anchors />` — a `<head>` that is itself inside the stream

> ### Support boundary
>
> `<StyleSheet.Anchors />` itself works on **React 18.3.1 and every React 19**,
> with one shape excepted and one caveat:
>
> | Shape                                                                                    | Needs                                   |
> | ---------------------------------------------------------------------------------------- | --------------------------------------- |
> | A Suspense boundary **inside** `<head>`, `<StyleSheet.Anchors />` above it (recommended) | React 18.3.1+                           |
> | A Suspense boundary **inside** `<head>` with `<StyleSheet.Anchors />` _inside_ it        | React 19.0+, and it flashes — see below |
> | A Suspense boundary **above** `<html>`/`<head>`                                          | **React >= 19.1**                       |
>
> The last row is a hard floor, not a degradation: it needs Fizz's
> Suspense-aware preamble, which shipped in React 19.1.0 and is in no 19.0.x
> release. Without it React writes a document that is not a document — 19.0.x
> emits no doctype and no `<html>`/`<head>` open tag at all, 18.3.1 streams
> the whole resolved document nested inside a `<div hidden>` — and nothing in
> this library can repair bytes that are wrong before RNW is involved. Both
> failures are pinned by `streamingHead.spec.js`. See
> [React version support](#react-version-support).

`<StyleSheet.Anchors />` renders the per-group anchors as React elements
wherever you put them in the tree, reading the sheet during its own render.
That is what makes a streaming `<head>` workable: the anchors are React-owned
by construction, so the one hydration-skewing configuration above — a
`<style>` React did not render, interleaved among `<style>` siblings it did —
cannot arise.

```jsx
import { Suspense } from 'react';
import { StyleSheet } from 'react-native-web';

function Document({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* Above the boundary: the anchors go out in React's first flush. */}
        <StyleSheet.Anchors />
        <Suspense>
          <LateHeadTags />
        </Suspense>
      </head>
      <body>{children}</body>
    </html>
  );
}
```

**Render it above every boundary in `<head>`, not inside one.** The anchors are
the stylesheet; putting them behind a boundary means the browser paints the
shell before the CSS exists, and no delivery mechanism can fix that — the rules
have not been compiled yet. That flash is measured and pinned by `fouc.spec.js`
rather than tolerated silently. Above the boundary there is no flash on either
React major.

A chunk whose rules arrive before their anchor does is not lost: the delta
script queues them, and the queue is drained at sheet bootstrap, by later
chunks, by the component's own commit, and at `DOMContentLoaded`.

## Per-request scoping

```js
import { configureRequestScope, runInRequestScope } from 'react-native-web';
import {
  getProcessState,
  getScopedState,
  hasRequestScope
} from 'react-native-web/server';
```

### `runInRequestScope(fn)`

Runs `fn` inside a fresh per-request scope and returns its result. State read
through `getScopedState` during `fn` — RNW's own CSS delta buffer, `Dimensions`,
`Appearance`, and anything you register yourself — is isolated from concurrent
scopes.

Wrap every SSR render in it, including the `renderToPipeableStream` call and
the `onShellReady` handler that sets up the piping. Without it there is no
per-request isolation at all: concurrent renders share one set of module-level
values, and the CSS delta channel is inert.

On the client this is a no-op; state stays the process singleton.

### `configureRequestScope({ AsyncLocalStorage })`

**Required on non-Node server runtimes** — workerd, Deno, Bun, some edge
runtimes — whose bundler resolves the package's `browser` condition. Call it
once at startup, before any render.

```js
import { AsyncLocalStorage } from 'node:async_hooks';
import { configureRequestScope } from 'react-native-web';

configureRequestScope({ AsyncLocalStorage });
```

On Node this is unnecessary: `node:async_hooks` is imported statically. It
throws if the argument is not a constructor. An already-open scope is not
carried over to the new store.

Without an `AsyncLocalStorage`, `runInRequestScope` still calls `fn`, but it
throws in development and logs once in production rather than quietly sharing
state across requests.

### `getScopedState(key, createDefault)`

The per-request state object for `key`, created with `createDefault()` on first
access in the scope. Outside any scope it returns the process-default singleton
(also lazily created). The reference is stable across reads within one scope,
so downstream SSR helpers can keep their own per-request state behind the same
scope by mutating what they get back.

### `getProcessState(key, createDefault)`

The process-wide default for `key`, ignoring any active scope. This is what a
fresh scope's state is seeded from in `Dimensions` and `Appearance`, so a value
set once at module scope keeps working.

### `hasRequestScope()`

`true` iff execution is currently inside a request scope.

## The streaming adapter

```js
import {
  renderToStreamingResponse,
  createStyleInjectionTransform
} from 'react-native-web/server';
```

Two levels. `renderToStreamingResponse` is the documented arrangement as one
call and is what most servers want; `createStyleInjectionTransform` is the
piece it is built on, for a caller who owns the response themselves.

### `renderToStreamingResponse(options)`

Renders `element` into `response` with the whole streaming-SSR arrangement
wired: the request scope open around both the render and the piping, this
request's device state applied, the document assembled around the stylesheet
shell and the hydration snapshot, and React piped through the transform in the
order it needs. Returns `{ abort }`. See [Quickstart](#quickstart) for the
shape of a call.

| option             | type                         | default           | meaning                                                                                                                          |
| ------------------ | ---------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `element`          | `React.Node`                 | — (required)      | The tree to render. Typically `AppRegistry.getApplication(…).element`.                                                           |
| `response`         | `http.ServerResponse`        | — (required)      | Where the document is streamed. Any writable stream works; `statusCode` and `setHeader` are used when present.                   |
| `head`             | `string`                     | `''`              | Markup for `<head>`, after the charset and before the hydration snapshot and the shell. `<title>`, the viewport meta, `<link>`s. |
| `viewport`         | `DisplayMetrics`             | the process value | This request's viewport, applied to both `screen` and `window`. For different values per key, see below.                         |
| `colorScheme`      | `'light' \| 'dark'`          | the process value | This request's color scheme.                                                                                                     |
| `bootstrapScripts` | `Array<string>`              | none              | Passed to React.                                                                                                                 |
| `bootstrapModules` | `Array<string>`              | none              | Passed to React.                                                                                                                 |
| `nonce`            | `string`                     | none              | CSP nonce. Applied to every `<style>` and `<script>` this package emits, and passed to React for its bootstrap scripts.          |
| `rootId`           | `string`                     | `'root'`          | `id` of the div the app renders into — the one the client hands to `runApplication({ rootTag })`.                                |
| `lang`             | `string`                     | `'en'`            | `lang` on `<html>`.                                                                                                              |
| `status`           | `number`                     | `200`             | Status code, set at `onShellReady`.                                                                                              |
| `abortAfterMs`     | `number`                     | `10000`           | Deadline for a boundary that never resolves. `0` disables it.                                                                    |
| `onError`          | `(error, errorInfo) => void` | `console.error`   | Every error React reports, recoverable ones included.                                                                            |
| `onShellError`     | `(error) => void`            | a minimal 500     | The shell itself failed and nothing has been written. A replacement owns the response.                                           |
| `onShellReady`     | `() => void`                 | none              | Called after the response is piped and the first bytes are on their way.                                                         |
| `onAllReady`       | `() => void`                 | none              | Passed to React.                                                                                                                 |

It emits the doctype, `<html lang>`, `<meta charset="utf-8">` and the root
div itself; `head` is everything else that belongs in `<head>`.

**Per-request state it has no option for** goes in a scope you open yourself.
An already-open request scope is used as-is rather than nested inside — a
nested scope would be seeded from the process defaults and would discard
whatever the outer one set:

```js
runInRequestScope(() => {
  Dimensions.set({ screen, window }); // asymmetric screen/window
  registerRequestThing();
  renderToStreamingResponse({ element, response: res });
});
```

**When not to use it.** It writes `<head>` as a string, so React does not own
the document. For `hydrateRoot(document, …)`, or a `<head>` that is [itself
inside the stream](#stylesheet-anchors), drive `createStyleInjectionTransform`
directly — and read [rendering `<head>` through
React](#rendering-head-through-react) first. There is no Web Streams variant,
for the reason in [known limitations](#known-limitations).

### `createStyleInjectionTransform({ prelude, epilogue, nonce })`

Returns a Node `stream.Transform` to pipe React's output through. It forwards
React's HTML untouched and splices this request's newly compiled CSS in between
chunks. See the [server example](#the-server) above for the full shape.

| option     | type                            | meaning                                                                                                                                          |
| ---------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prelude`  | `(shellHTML: string) => string` | Called once, immediately before React's first byte is forwarded. Receives the shell stylesheet; returns everything that precedes React's output. |
| `epilogue` | `string`                        | Appended after the final delta, when React's stream ends. Typically the tags `prelude` opened.                                                   |
| `nonce`    | `string`                        | CSP nonce, applied to every `<style>` and `<script>` the transform emits.                                                                        |

`prelude` is a function rather than a string because the shell can only be
serialised at one instant — after the shell render has compiled its CSS, before
any body markup is on the wire — and the transform is the only party that knows
when that is.

Omit `prelude` if you would rather write the document head yourself. Then it is
on you to call `StyleSheet.takeShellHTML()` after the shell has rendered and
before the first body byte; the transform still handles every delta after that.

Write that shell **through the transform** — `injector.write(head)` — not around
it (`res.write(head)` ahead of `injector.pipe(res)`). The transform releases a
delta only once it has seen an anchor's bytes go past, so a shell written around
it leaves no anchor in this stream and every delta is withheld to the end of the
stream instead of streaming. Nothing is lost — the rules still arrive, in order,
ahead of the epilogue — but the per-boundary CSS stops being per-boundary.
Passing `prelude` avoids the question entirely.

And write that head as **UTF-8**. The anchor scan matches the ASCII bytes
`data-rnw-group="` against the raw chunk, and by the time `_transform` sees a
chunk the original encoding is unrecoverable: measured on Node 24.18.0,
`write(string)`, `write(string, 'utf16le')`, `write(string, 'base64')`,
`write(Buffer)` and `write(Uint8Array)` all arrive as a `Buffer` whose
`encoding` argument is `'buffer'`. A `utf16le` head puts `d\0a\0t\0a\0…` on
the wire, the marker never matches, and every delta is again withheld to the
end of the stream — the same benign degradation as writing the shell around
the transform: late CSS, not missing CSS. React itself cannot reach this
(Fizz's Node writer encodes through one module-level UTF-8 `TextEncoder`,
which has no options, and hands the destination a `Uint8Array`), so it only
bites a caller writing the head by hand. `prelude` avoids it too.

Two behaviours are worth knowing about:

- **Ordering.** `injector.pipe(res)` must run before `pipe(injector)`. React
  signals a clean element boundary by calling `flush()` on its destination;
  this transform implements `flush()` in order to inject there (React's writes
  routinely end mid-tag, so injecting from `_transform` would corrupt the
  markup). Because it consumes that call, it forwards the signal to everything
  it has been piped into — but only to destinations it knows about at the time.
- **The final delta.** The last boundary to resolve produces rules after the
  last flush React will ever make, so the transform takes one more delta at
  end-of-stream, before the epilogue.

The browser build of this module throws when called. It is a Node server API;
keep it behind the same server entrypoint as `runInRequestScope`.

### <a id="root-level-suspense-under-react-191"></a>Root-level `<Suspense>` under React >= 19.1

A streaming-quality note, not a correctness one. Output was always correct;
what this is about is whether it streams.

React 19.1 made Fizz's preamble Suspense-aware. If the walk from the root
segment reaches a still-pending Suspense boundary without first passing through
a host element — the root itself is a `<Suspense>`, or a Fragment or array with
one as a direct child — React writes _no bytes at all_ until that boundary
resolves, because it is waiting to find out whether `<html>`/`<head>` will come
out of it. React 18.3.1 and every 19.0.x do not do this; 19.1.0 and later do.
It is React behaviour, not an RNW constraint, and putting any host element
above the outermost boundary restores full streaming.

Note which way round the version story runs here. Waiting for the preamble is
the _mild_ case: the output is correct on every version, and only streaming
quality differs. The **absence** of the preamble is the severe one — if
`<html>`/`<head>` really are inside that boundary, a React without the
preamble writes a broken document, which is the one version floor this package
has. See [the one version floor](#react-version-support).

The transform handles the mild case: it emits the prelude and shell from
React's first `flush()` as well as from the first write, so a pass that
produces zero bytes still gets your document head onto the wire immediately,
and the boundary's rules still arrive as a delta rather than being folded into
a late shell. This was verified against 18.3.1, 19.0.0, 19.1.1, 19.2.0 and
19.3.0 in the original Node/jsdom investigation (historical — see
[React version support](#react-version-support)) and is reconfirmed end to end
on all five by the real-browser matrix. It is a strict no-op on 18.3.1 and
19.0.x, where the first signal is always a write.

What the transform cannot recover is React's own markup: the boundary's
fallback still will not stream on >= 19.1.

## Worker threads

Only worth reaching for if the render is CPU-bound enough to block the event
loop. If the motivation is per-request isolation, `runInRequestScope` already
gives you that in-process and a thread buys nothing.

`AsyncLocalStorage` works inside a worker — `node:async_hooks` is per-thread
and this package loads it statically, so there is nothing to configure. Module
state is per-thread too, which makes a worker pool _more_ isolated than one
process: each worker gets its own compiled stylesheet, so cross-request CSS
leakage is not expressible.

What does not work is handing the worker the response. An
`http.ServerResponse` owns a socket, which is a handle: not
structured-cloneable, not transferable. The render has to happen in the worker
and the bytes have to be written on the main thread, so the stream has to span
the two. `createWorkerResponse` / `pipeWorkerResponse` are that stream.

```js
// main thread
import { pipeWorkerResponse } from 'react-native-web/server';

app.get('/*', (req, res) => {
  const { port1, port2 } = new MessageChannel();
  pipeWorkerResponse({ port: port1, response: res });
  worker.postMessage({ responsePort: port2, url: req.url }, [port2]);
});
```

```js
// worker
import { parentPort } from 'node:worker_threads';
import {
  createWorkerResponse,
  renderToStreamingResponse
} from 'react-native-web/server';

parentPort.on('message', ({ responsePort, url }) => {
  renderToStreamingResponse({
    element: appFor(url),
    response: createWorkerResponse({ port: responsePort })
  });
});
```

`renderToStreamingResponse` is unchanged — `createWorkerResponse()` carries
`statusCode`, `setHeader`, `writableEnded` and `'close'`, so the adapter
cannot tell it from a `ServerResponse`, and its default `onShellError` (a 500
with headers) works from inside the worker. It works the same way under
`createStyleInjectionTransform` directly.

### Why this is a library API and not four lines in your server

Two things about the obvious hand-rolled version are wrong, and both are
silent.

**A flush posted as its own message races the bytes it belongs to.** The
transform forwards React's per-pass `destination.flush()` to any destination
that has one, and that signal is what makes a compression stream release the
shell instead of sitting on it. `Readable.pipe` usually emits `'data'`
synchronously, but when the readable side has buffered it defers — and then
the flush message is posted first:

```
naive bridge, readable side buffered:
  ["flush", "w:shell-bytes"]     ← flush arrives first, flushes nothing
```

The shell is then delayed by a whole boundary, exactly as if the flush had
been dropped, and the final HTML is byte-identical either way. So flush is not
a message here: it is a flag on the next batch, and batches are assembled in
`setImmediate`, after every synchronous and `nextTick` write of the pass has
landed.

**`postMessage` has no backpressure.** A CPU-bound render feeding a slow
socket queues the whole document in the main thread's heap and nothing
anywhere returns `false`. Each batch is stop-and-wait: the worker holds the
stream's write callbacks until the main thread reports the batch written and
drained, which is what makes Node apply real backpressure back through the
pipe into the transform and into Fizz — the only place that can slow down.

That it reaches Fizz is measured, not assumed. Against a consumer that never
drains, the render is stopped after a fixed backlog regardless of how large
the document is:

| document | produced before Fizz stops |       |
| -------- | -------------------------- | ----- |
| 222 KB   | 66.0 KB                    | 29.7% |
| 441 KB   | 66.3 KB                    | 15.0% |
| 880 KB   | 65.9 KB                    | 7.5%  |
| 1.76 MB  | 67.3 KB                    | 3.8%  |

A constant ceiling is bounded memory. A ceiling proportional to the document
would mean the whole thing buffers in the worker and the backpressure is
cosmetic.

### Either end going away

Both directions are carried, because both leave something running for nobody.

A client that disconnects destroys the worker-side stream, leaving
`writableEnded` false — exactly what the adapter's own `'close'` handler
watches for — so the render stops. The same happens if the main thread
crashes or closes the port without an abort.

A worker that is terminated or crashes mid-stream **destroys the response
rather than ending it**. Ending would hand the client a truncated document as
though it were whole; destroying surfaces it as the transport error it is. Pass
`onError` to observe this in production — without it the reason is logged in
development only, and the response is destroyed either way.

A `Worker` passed directly as the port is handled too. It has no `'close'`
event — it reports the same thing as `'exit'` — so both are listened for.

A `MessageChannel` per request does not accumulate. Both sides take their
listeners off the port when the response finishes, after which the pair is
unreferenced and collected: measured flat at 0 live `MessagePort` handles and
stable RSS across 600 sequential requests. Closing the port yourself is fine
but is not required. The same holds on the abort path — 400 client hang-ups
mid-stream left 0 live handles and a flat heap, and 60 rounds of killing the
worker mid-response all surfaced as transport errors with no hang and no
handle growth.

### `createWorkerResponse({ id, port })`

Worker side. Returns the writable stream to pass as `response`.

### `pipeWorkerResponse({ id, port, response, onError })`

Main-thread side. Writes the worker's batches into `response` and returns
`{ dispose }`, which stops listening without ending the response.

`port` is anything with `postMessage`, `on` and `off`: a `MessagePort`, a
`Worker`, or `parentPort`.

### Sharing one port between many responses

A `MessageChannel` per request is the pattern above and needs no `id`. One
port can carry many responses instead, which trades the channel allocation for
two obligations:

- Give every response in flight a distinct `id`. `pipeWorkerResponse` reports
  a collision in development rather than letting two documents interleave.
  Concurrency itself is free: each port carries one `'message'` listener that
  routes by id, however many responses are in flight, so a busy shared port
  does not trip Node's ten-listener `MaxListenersExceededWarning`.
- Have your own `'message'` handler skip the bridge's traffic. Its acks and
  aborts arrive at the same handler your tasks do, and a handler that assumes
  every message is a task will try to render one:

```js
parentPort.on('message', (message) => {
  if (isWorkerResponseMessage(message)) return;
  const { id, url } = message;
  renderToStreamingResponse({
    element: appFor(url),
    response: createWorkerResponse({ id, port: parentPort })
  });
});
```

## The lower-level CSS API

For adapters that do their own stream plumbing rather than using the transform.

Only the _delta_ accessors are scope-gated — `takeDeltaHTML()`,
`takeRequestDelta()` and `resetRequestDelta()` each return early when there is
no scope. The shell accessors are not, and must not be — the non-streaming [`AppRegistry` SSR](#appregistry-ssr) path
serialises a shell with no request scope anywhere in sight, and
`getStyleElements()` is the same emission as `takeShellHTML()`.

<!-- drift-check: scope-gating -->

| Called outside a request scope  | Returns                                 |
| ------------------------------- | --------------------------------------- |
| `StyleSheet.takeShellHTML()`    | the whole shell, same as inside a scope |
| `StyleSheet.takeShellGroups()`  | the whole shell, same as inside a scope |
| `StyleSheet.takeDeltaHTML()`    | `''`                                    |
| `StyleSheet.takeRequestDelta()` | `''`                                    |

<!-- /drift-check -->

That table is not prose: `src/__tests__/docs-drift-test.node.js` parses it out
of this file and calls each API outside a scope, so a row that stops being
true fails `npm test`.

### `StyleSheet.takeShellHTML({ nonce })`

The full cumulative server sheet as an HTML fragment — one
`<style data-rnw-group="G">` per group, ascending, empty groups included.
Inline it verbatim, typically right before `</head>`. Also resets the request's
delta watermark, so subsequent chunks carry only what came after.

Emit exactly one shell per document; see
[one shell per document](#emitting-two-shells) in Gotchas.

### `StyleSheet.takeDeltaHTML({ nonce })`

The fragment for a streamed post-shell chunk: the rules added since the last
`takeShellHTML` / `takeDeltaHTML` call, as a **single self-removing inline
`<script>` and nothing else**. No `<style>` element, and no DOM node of any
kind — the script inserts the rules into the CSSOM of the anchors the shell
put in `<head>`, hands them to RNW's runtime, and deletes itself, leaving the
DOM exactly as React rendered it. Returns `''` when there is nothing new.

Embed it verbatim at a chunk boundary. `<body>` is where it lands in practice,
but where it sits no longer affects the cascade: the rules go into the
anchor's own sheet, so their bucket is the anchor's position. `nonce` applies
to the `<script>`, which is the only element this call emits — and the only
one it can emit, since a chunk that finds no anchor queues its rules rather
than creating one.

The payload is escaped for a `<script>` context — `JSON.stringify`, plus every
`<` rewritten as the JSON escape `\u003c`, so a rule containing `</script>`
or `<!--` cannot end the element early. That replaces the `</style` escaping the old `<style>`
format needed; `takeShellHTML` and `takeShellGroups` still escape for `<style>`,
since that is still what they emit.

Treat the returned string as a single inert blob. The script's contents and the
window globals it touches are implementation details and may change.

### `StyleSheet.takeShellGroups()`

The same shell as `takeShellHTML`, structured: an array of `[group, cssText]`
pairs, ascending. `cssText` is already escaped for embedding in a `<style>`
element. Use it to build your own elements — `AppRegistry`'s
`getStyleElements()` is the in-tree consumer. Also resets the delta watermark.

Snapshotting it requires a moment at which the sheet is right for the whole
document, which a `<head>` that is itself inside the stream does not have. For
that case render the anchors instead of serialising them: see
[`<StyleSheet.Anchors />`](#stylesheet-anchors), which also carries the
**React >= 19.1** floor for a Suspense boundary above `<html>`/`<head>`.

### `StyleSheet.takeRequestDelta()` / `StyleSheet.resetRequestDelta()`

The older marker-delimited form of the same delta channel, kept because it is
part of the published `IStyleSheet` type. **Most callers should not reach for
these.** Prefer `takeDeltaHTML`.

`takeRequestDelta()` returns raw CSS text for callers that assemble their own
`<style>` tags. Each group present in the delta is preceded by a
`[stylesheet-group="N"]{}` marker rule the first time it appears in the
request; later flushes skip the marker because the client already knows the
group exists. `takeDeltaHTML` needs no markers — it carries the group as a
field of its script payload instead.

`resetRequestDelta()` declares the request's client up to date with the sheet
as it stands, so the delta channel carries only what arrives after that point.
`takeShellHTML` and `takeShellGroups` call it for you.

### One format per document

A document uses the grouped format or the legacy single sheet, never both.
Their relative cascade order is undefined. The client throws in development
when it finds both per-group anchors and a `<style id="react-native-stylesheet">`
in the same document; in production it cannot afford to throw, so it picks one
and mis-cascades.

## AppRegistry SSR

For non-streaming SSR, or for streaming adapters that render `<head>` as React
elements rather than a string.

```jsx
const { element, getStyleElement, getStyleElements } =
  AppRegistry.getApplication('App', { initialProps });
```

### `getStyleElements(props)`

The grouped, streaming-compatible format: an array of keyed React elements, one
`<style data-rnw-group="G">` per group, ascending, empty groups included.
Render the array into `<head>`. It goes through `StyleSheet.takeShellGroups()`,
so it inherits the anchor and watermark behaviour described above.

This is the right accessor when React renders `<head>` itself, because it makes
every anchor a node React rendered — read
[rendering `<head>` through React](#rendering-head-through-react) before doing
that, including the constraint that `<head>` must be complete before the shell
is taken.

`props` is spread onto every emitted element; `nonce` is the one that matters
in practice. `id` throws in development, because it would produce duplicate
ids — the group number already identifies each element.

An array rather than a fragment: SSR pipelines commonly count, slice or
interleave the elements. Both render identically under `renderToString` and
`renderToStaticMarkup`.

### `getStyleElement(props)`

Upstream's single `<style id="react-native-stylesheet">`, unchanged. Still
correct for non-streaming SSR.

### Emitting both throws

Calling both accessors from one render throws in development. This is the
server-side half of the client's one-format-per-document rule, reported at the
call that creates the problem instead of at the client that inherits it. Inside
a request scope the flags are per request, so two concurrent requests never see
each other's choice; outside one they are local to a single `getApplication()`
result. One process may legitimately serve a grouped page and a legacy page.

## Per-request device state

`Dimensions` and `Appearance` hold the two pieces of device state a render can
read. Both refuse to run in the browser (`Dimensions.set` and `Appearance.set`
assert), and both isolate per request when called inside `runInRequestScope`. A
fresh scope starts as a copy of the process default, so seeding a value once at
module scope still works and per-request calls layer on top.

Their client-side counterparts — `useWindowDimensions` and `useColorScheme` —
are built on `useSyncExternalStore`, which is what makes them correct under
progressive hydration. The hooks used to seed `useState` from the module value,
and a `useState` initialiser captures that value at the moment _that particular
component_ first renders — which under progressive hydration is many moments,
not one, so a late boundary read whatever the value had become. That was not a
warning-level problem: React emitted `Text content does not match
server-rendered HTML.` **and** `There was an error while hydrating this Suspense
boundary. Switched to client rendering.`, throwing away the server markup for
that boundary. With `useSyncExternalStore`, React calls `getServerSnapshot` for
every subtree it hydrates, whenever it hydrates it, so each boundary reads the
value the server rendered with and then reconciles to the live value as an
ordinary update. The snapshot they read comes from
[hydration state](#hydration-state).

### Dimensions

```js
Dimensions.set({
  screen: { fontScale: 1, height: 800, scale: 1, width: 1024 },
  window: { fontScale: 1, height: 800, scale: 1, width: 1024 }
});
```

Declares the viewport this server render should use. Either key may be omitted.

```js
Dimensions.unstable_setForHydration({ screen, window }); // browser only
Dimensions.unstable_restoreFromHydration();
```

`unstable_setForHydration` forces the server's values as the live client value
for the duration of hydration, _and_ records them as the frozen server
snapshot. It is the alternative to emitting `takeHydrationStateHTML()` for apps
that plumb the values across themselves, and it is what covers code that reads
`Dimensions.get()` imperatively during a render rather than through the hook.
While the override is in force, resize events do not overwrite the values.

`unstable_restoreFromHydration` clears the override, re-reads the real viewport,
and notifies `change` subscribers if the metrics actually moved — without that
notification, consumers would keep the server's size until some later resize
happened to arrive. It deliberately does **not** touch the frozen snapshot.

### Appearance

```js
Appearance.set({ colorScheme: 'dark' });
```

Declares the color scheme this server render should use.

```js
Appearance.unstable_setForHydration({ colorScheme }); // browser only
Appearance.unstable_restoreFromHydration();
```

The client-side override matters more here than it does for Dimensions.
Dimensions needs one because the server cannot know the real viewport;
Appearance needs one because the client _can_ answer and can answer
differently. `Appearance.set` exists so a request can render the scheme the
user chose — a cookie, an account setting — and that is precisely the case
where `matchMedia('(prefers-color-scheme: dark)')` disagrees, because it only
ever reports the OS setting.

While the override is in force, media-query changes are not forwarded to
`addChangeListener` subscribers. Like the Dimensions counterpart,
`unstable_setForHydration` also records the frozen server snapshot, and
`unstable_restoreFromHydration` does not touch it.

`unstable_restoreFromHydration` hands control back to the media query and
notifies change listeners if the query disagrees with the value that was
forced. Nothing re-fires a media query that never changed — the override merely
stopped ignoring it — so without that notification subscribers would hold the
forced scheme forever.

### Handing control back after hydration

**Restoring is safe at any time.** It used to be a timing hazard; it is not one
any more. `unstable_setForHydration` records a _frozen_ server snapshot that
`unstable_restoreFromHydration` cannot touch, so a Suspense boundary that has not
hydrated yet still reads the server value and still agrees with the markup it
is reconciling against, no matter what the live value has become in the
meantime. There is no moment you have to wait for, and no signal you have to
synthesise: restore whenever your app is ready to track the browser again.

What remains is a product question, not a correctness one, and only for
`Appearance`: if the scheme came from a deliberate user preference, handing
control back to `matchMedia` flips the page to the OS setting and away from the
choice the user made. `matchMedia` only ever reports the OS preference, so for
an app with a stored theme, not restoring is often the right permanent answer.
For `Dimensions` there is no such tension — the server was guessing, and the
browser knows better — so restore when it suits you.

## Hydration state

```js
import {
  registerHydrationState,
  takeHydrationStateHTML
} from 'react-native-web/server';
```

Under streaming SSR a Suspense boundary's first client render happens when its
chunk lands, which can be long after the root became interactive — and React
reconciles that render against markup produced at the start of the response.
So the boundary has to see the device state _the server_ saw, not whatever the
module holds by then. This is how that value reaches the client.

It is a parallel mechanism to the CSS shell, deliberately not coupled to it.
CSS is cumulative and arrives in pieces across the whole response; this is a
single immutable payload that must be in the document before React's first byte
of app markup is hydrated. So it does not live on `StyleSheet`,
`createStyleInjectionTransform` does not emit it, and the app decides where it
goes. It is inert markup — put it anywhere that parses before hydration starts,
typically in `<head>`, next to the shell in the transform's `prelude`, as in
the [server example](#the-server).

### `takeHydrationStateHTML({ nonce })`

Returns `<script>window.__RNW_HYDRATION__={…}</script>`, carrying this
request's `Dimensions` and `Appearance` values. Inline it verbatim. Pass
`nonce` when the response is served under a CSP.

It reads every registered source through its public API, so inside
`runInRequestScope` it picks up that request's values and two concurrent
renders each emit their own.

The client needs no wiring: `useWindowDimensions` and `useColorScheme` read
that snapshot through `getServerSnapshot`. Treat the payload as opaque —
`unstable_setForHydration` is the supported way to supply the same values by
hand, not writing the global yourself.

### `registerHydrationState(key, read)`

Adds your own per-request state to the same snapshot. `key` is the name it is
filed under; `read` is called during `takeHydrationStateHTML()`, inside
whatever request scope is open, and must return a JSON-serialisable **object**
(a plain record — a scalar is rejected, so the record can gain a field later
without breaking the wire format).

**Registration is a precondition, not a caveat.** Call it once, at server
entry, from module scope — next to `configureRequestScope` — and always before
any render. `takeHydrationStateHTML()` serialises whatever is registered when
it runs, and it runs in the prelude, before the shell. Registering from a
module that loads later, such as one imported lazily inside a Suspense
boundary, is **not supported** and is a deliberate non-goal, not a gap waiting
for a streamed registration channel: that boundary's markup goes out carrying
state that never reached the snapshot, and the client hydrates it against the
live value instead. Nothing can recover it after the fact. Development names
the key when a page emitted a snapshot that lacks it.

`Dimensions` and `Appearance` are registered by the library itself, so they
cannot be caught by that. Registering a key twice keeps the first source and
reports an error in development; a source that throws or returns a non-object
costs only its own key, which then falls back to the live client value.

Not included, on purpose: `PixelRatio` derives everything it reports from
`Dimensions`, so it rides on that entry, and `StyleSheet`'s delta buffer has
its own wire channel and is cumulative rather than a snapshot.

### Everything degrades to today's behaviour

An app that wires up neither the emitter nor `unstable_setForHydration` is
unaffected: `getServerSnapshot` falls back to the live value, which is what
these hooks always did. The same is true per key — a missing, malformed or
truncated payload costs that subsystem the snapshot, not the page.

## Gotchas

Each of these fails silently, or nearly so.

**Five of them are not yours if you use
[`renderToStreamingResponse`](#rendertostreamingresponseoptions)**: the
request scope, the pipe order, piping before `onShellReady`, emitting a
second shell, and reusing a transform are all decided inside that one call.
What is still yours on any path: `AsyncLocalStorage` on an edge runtime,
never mixing the two stylesheet formats, and registering hydration state
before the first render. The rest of this section is written for a caller
driving `createStyleInjectionTransform` themselves.

**Forgetting `runInRequestScope`.** `takeDeltaHTML()` returns `''` outside a
scope rather than throwing, so a transform used without a scope degrades to
shell-plus-passthrough: everything a late Suspense boundary compiled is missing
from the page and those boundaries render unstyled. A stream that never once
saw a scope logs an error in development when it ends. The other half of the
damage is quieter — `Dimensions` and `Appearance` fall back to process
singletons, so concurrent renders overwrite each other's values.

The scope has to cover the piping too, not just the render. Set up
`renderToPipeableStream` and its `onShellReady` handler inside the callback you
pass to `runInRequestScope`.

In development the transform reports this at the end of React's first
streaming pass — next to the request that caused it — rather than at the end
of the response, and once per process, since it is a property of the handler
and not of any one request.

**Missing `AsyncLocalStorage` on edge runtimes.** If your bundler resolves the
package's `browser` condition on a server runtime — workerd, Deno, Bun, some
edge runtimes — there is no `AsyncLocalStorage` and every key resolves to a
process-wide singleton. `runInRequestScope` throws in development and logs once
in production, but the production log is easy to miss and the failure is
exactly the cross-request leak the API exists to prevent. Call
`configureRequestScope({ AsyncLocalStorage })` once at startup.

**Mixing the two stylesheet formats.** Emitting both the grouped shell and the
legacy `<style id="react-native-stylesheet">` in one document is never safe;
their relative cascade order is undefined. Development throws on both sides;
production silently mis-cascades. Pick one per document. In practice that means
not calling `getStyleElement()` in a render that also uses the streaming
transform, `takeShellHTML()`, or `getStyleElements()`.

**<a id="emitting-two-shells"></a>Emitting two shells.** One shell per
document. `StyleSheet.takeShellHTML()`, `StyleSheet.takeShellGroups()` and
`AppRegistry`'s `getStyleElements()` are three spellings of one emission, not
three separate ones — they all funnel through `takeShellGroups()`, and two calls
in one request return the identical string.

That is worse than redundant. Each shell is the whole cumulative sheet, so the
document ends up with two of every group anchor — `[0,1,2,3][0,1,2,3]` — and a
delta's rules go into the _first_ anchor for their group. A group-2 delta then
sits ahead of the second copy of group 3, while the second copy of group 2 sits
after the first copy of group 3: group 2 outranks group 3, the exact cascade
inversion the anchors exist to prevent.

<!-- drift-check: duplicate-shell -->

`takeShellGroups()` logs a `console.error` on the second and later shell
within one request scope — **in production as well as in development**, and
deliberately so. A second shell cannot be made safe, only visible: the cascade
reads DOM order, so two anchor sets mis-rank each other whatever the second
one contains, and there is nothing for the library to repair. Suppressing the
second emission would break hydration for whichever instance rendered it, and
the server cannot know which emission the caller will actually put on the
wire. That leaves failing loudly, and a warning nobody would ever see on a
deployed server is not loud enough for a symptom — some rules silently
outranked by others — that nobody reproduces locally.

It warns rather than throws because re-emitting can be legitimate (retrying
after an aborted response, where the first shell never reached the wire), and
because by the time it fires the response is usually already on the wire:
aborting a half-written document is worse than mis-cascading it. The message
names that legitimate case so it can be ignored knowingly.

The warning is scoped per request, so a fresh request starts clean, and it is
silent _outside_ a request scope — there the emitted-shell flag is a process
singleton, and every render after the first would trip it for no reason.

<!-- /drift-check -->

**Piping in the wrong order.** `injector.pipe(res)` before `pipe(injector)`.
The transform can only forward React's flush signal to destinations it already
knows about, and React writes and flushes synchronously from `pipe(injector)`
— so getting it backwards loses the flush for the pass that carries your
shell. With a compression middleware or a `gzip` stream downstream, the shell
then sits in that stream's buffer until the next boundary resolves (or until
the response ends, if none does): the page still arrives, it just stops
streaming, which is invisible in local testing without compression.

Development reports this too, at the end of React's first pass, by noticing
that nothing is consuming the readable side at the moment React says a pass is
finished. A caller who drives the readable side by hand rather than piping —
`on('data')`, async iteration, `stream.pipeline` — does not trip it, provided
that listener is attached before React is handed the transform.

**Piping before `onShellReady`.** Set the piping up _from_ `onShellReady`, not
before it. That is not just convention: the transform serialises the shell on
whichever comes first, React's first write or React's first `flush()`, and
React runs the `finally` containing that flush even on a pass its
`pendingRootTasks > 0` guard skipped entirely. Pipe earlier and you get
`takeShellHTML()` while the shell render is still compiling. It degrades
gracefully rather than breaking — the shell is serialised early and whatever
the shell render compiles afterwards arrives in the first delta, landing in the
right anchor's sheet like any other rule — but the shell is incomplete, the
first delta is needlessly large, and those rules now need JavaScript to apply
(see [with JavaScript disabled](#with-javascript-disabled)). From
`onShellReady` the shell render has finished compiling before React can flush
to you at all.

**Registering hydration state after the render starts.**
`registerHydrationState` must run at server-entry module scope, before any
render; `takeHydrationStateHTML()` only serialises what is registered when it
runs. A key registered later — typically from a module imported lazily inside
a Suspense boundary — is simply absent from the snapshot, and that boundary
hydrates against the live client value. Development warns and names the key
when a page emitted a snapshot without it; production does not. See
[registerHydrationState](#registerhydrationstatekey-read).

**Emitting a delta after `end()`.** Emit the last delta _before_ you call
`injector.end()`. Whether a `flush()` that arrives after `end()` still reaches
the response depends on something the caller cannot see. If the writable queue
was still parked under backpressure when `end()` returned, `_flush` has not run
yet, and those bytes do go out — in order, ahead of the final delta (measured:
200 × 4KB writes into a `highWaterMark: 1` sink with its write callbacks
parked, then `end()`, then `flush()`, and the delta is in the response). If the
queue had already drained, `end()` ran `_flush` synchronously before it
returned, and the bytes are unrecoverable — the readable side is over. So it is
neither true that bytes after `end()` are always lost nor that they always
arrive; it is decided by the state of the queue at that instant. The transform
now reports the unrecoverable case in development instead of assigning it to a
variable nothing will read, and a destroyed stream is exempt, since an aborted
response is _meant_ to lose bytes. React never puts you here — in every build
from 18.3.1 to 19.3.0, `flushBuffered(destination)` precedes
`destination.end()` — so this is for a hand-written driver, or a future React
that reorders.

**Reusing a transform.** One `createStyleInjectionTransform()` per response.
The prelude fires once per instance.

## Known limitations

**Node streams only, deliberately.** There is no `TransformStream` variant of
`createStyleInjectionTransform` for `renderToReadableStream`, and its absence
is a design decision rather than an oversight or a build problem — do not
"fix" it by adding one.

The whole design rests on React's Node destination contract exposing
`destination.flush()` as an explicit "this pass is finished, the bytes are at
an element boundary" signal. That is the only thing that makes injection safe:
React's writes routinely end mid-tag, so appending anywhere else produces
`<di<style>…</style>v>`. React's Web Streams path has no equivalent — a
`TransformStream` sees the same ~2KB-split enqueues with no way to ask whether
the source has finished a pass. It could only guess, and a wrong guess splices
a `<style>` into the middle of a `<script>`, corrupting the response instead of
failing. A timing heuristic would be a silent-corruption source.

The honest answer on those runtimes is to call `StyleSheet.takeShellHTML()` and
`StyleSheet.takeDeltaHTML()` from the framework's own boundary hooks, which do
know where a pass ends. The browser build of the module throws rather than
degrading, because the value it would have to return is a Node
`stream.Transform`.

**What has not been verified.** React 18.3.1 and React 19.0–19.3 were tested
in Node plus jsdom in an earlier investigation whose installs no longer exist
(see [React version support](#react-version-support)) — that figure is
historical, not something a reader can rerun. What _is_ reproducible today,
via `packages/streaming-ssr-e2e/scripts/react-version-matrix.js`, is Chromium
coverage on all five of **18.3.1, 19.0.0, 19.1.1, 19.2.0 and 19.3.0** (see
[real-browser coverage](#real-browser-coverage)). Two entries that used to be
on this list have come off it:
real-browser rendering — including React 19's reveal path (`$RB`/`$RV`,
`requestAnimationFrame`, the reveal throttle), now audited on every painted
frame rather than reasoned about — and document-level
`hydrateRoot(document, …)`, which is now covered by a spec that reads React's
fiber back-pointers. Still nothing is claimed about:

- Firefox and WebKit. The Playwright suite runs Chromium only, so the CSSOM
  `insertRule` path, the reveal timing and the hydration binding are all
  measured on one engine;
- CSP enforcement. A nonce is threaded through the transform and asserted on
  the elements it emits, but no tested response is served under a real
  `Content-Security-Policy`, so no test proves that a policy strict enough to
  matter accepts the stream;
- concurrent load. Device-state isolation _is_ now tested under contention —
  eight overlapping renders through the worker bridge, on dedicated channels
  and on one shared port, each asserting its own viewport, color scheme and
  markup — but only at that scale and only through that path. The delta
  channel remains warmth-sensitive by design: which rules a request is sent
  depends on what earlier and concurrent requests already compiled, and that
  imprecision is pinned by a test rather than fixed;
- Web Streams, per the section above;
- React 19.4+, canary and experimental builds.

One entry that used to sit on this list has moved: a Suspense boundary inside
`<head>` is now supported and covered, via
[`<StyleSheet.Anchors />`](#stylesheet-anchors). A boundary **above**
`<html>`/`<head>` is supported too, but only from **React 19.1** — that is a
stated floor rather than a verification gap, and both preamble-less failure
modes are pinned by tests.
