# Adversarial review #3

**Scope: only what landed after `ADVERSARIAL-REVIEW-2.md` was written.** The 21-key `exports`
map and the `browser` entries beside it; `src/__tests__/packageExports-test.node.js` and
`src/__tests__/docs-drift-test.node.js`; the `flushed` latch, the narrowed anchor-scan join
window and `__tests__/after-end-test.node.js` in `src/modules/styleInjection/index.js`; the
`IStyleSheet` / `Object.assign` refactor in `src/exports/StyleSheet/index.js`;
`StyleSheetAnchors-warning-test.js`, the repaired `StyleSheetAnchors-test.js:91`,
`specs/versionGates.spec.js` and the hardened `scripts/react-version-matrix.js`; and the doc
rewrites in `STREAMING-SSR.md`, `README.md` and `REACT19-FINDINGS.md`.

Findings already in reviews 1 and 2 are not restated. Where a claim in one of those reviews has
since been fixed, it is listed under **could not break** with the measurement that shows it fixed.

**Method.** Every claim below was produced by running something. Three reviewers worked in
parallel — an exports/stream/Flow track, a docs track, and a matrix-runner/tests track — and
two of them independently arrived at findings 4/5/6 by different routes, which is noted where it
happened. Where a thing could not be reproduced it says **not reproduced** in those words.

The working tree was mutated many times (probe files, mutants, doc edits, a `package.json`
swap). Every mutation was reverted and the revert verified: `git status --short` is 53 entries,
identical to the opening snapshot, and md5s of the eight files that were touched match their
pre-review values.

**Baseline before starting** — node jest 21 suites / 162 tests, jsdom jest 66 suites / 853
tests, `flow check` "No errors!", eslint clean, prettier clean, all green.

---

## Index — confirmed findings, severity-ranked

| # | Sev | Finding |
|---|---|---|
| 1 | **HIGH** | `react-version-matrix.js` reports a row **green, exit 0**, with 31 of 32 tests never run. The new `passed > 0` floor does not stop it |
| 2 | **MED-HIGH** | `docs-drift-test.node.js` cannot stop 2 of the 3 claims its docblock says it makes impossible: both can be reintroduced *verbatim* two lines outside their fence, and `REACT19-FINDINGS.md` is exempt from every phrase check |
| 3 | **MED-HIGH** | `FORCE_COLOR=1` makes all four summary regexes miss; a fully green run is reported as `FAILED TO RUN … no Playwright summary`. The runner is unusable under a common env var and the diagnostic misdirects |
| 4 | MED | The `exports` map blocks 508 specifiers that resolved before it — 49 real nested modules per tree, including `StyleSheet/StyleSheetAnchors` and `AppRegistry/getStyleElements` |
| 5 | MED | `packageExports-test.node.js`'s central invariant is asserted one directory level deep; the `*` it guards is multi-segment. The shape that is already broken 49× per tree passes the guard |
| 6 | MED | `STREAMING-SSR.md:74-80` states the invariant the whole map rests on — "all directories-with-`index.js`" — as the reason to trust it, and it is false |
| 7 | MED | The counter-claim defending `major !== 18` over `major < 19` is false, and its sole test pins a version string React never reports; with the real string the mutant survives 10/10 |
| 8 | MED-LOW | The `IStyleSheet` comment's stated Flow mechanism is wrong, and it steers a maintainer away from a one-line change that *is* a real guard — measured: it catches all 14 statics going missing |
| 9 | MED-LOW | `REACT19-FINDINGS.md:76,80-86` quotes source text that no longer exists and marks a fixed defect **NOT FIXED**. Review 2 #14, inverted |
| 10 | MED-LOW | `SUSPENSE-TODO.md:1411` says a contradiction in that file was "Not touched", 550 lines after the same rewrite touched it |
| 11 | MED-LOW | `STREAMING-SSR.md:207-211` cites a green `react@experimental` run as provenance for a suite state that no longer exists, and the same document twice disclaims experimental |
| 12 | MED-LOW | The matrix runner cannot be pointed at a dist-tag — `experimental`, `next`, `canary`, `latest` and any range all FAIL TO RUN — which is the one channel CI tracks |
| 13 | LOW-MED | The `./dist/*` and `./src/*` fallback arrays are decoration: entries 2 and 3 are unreachable, as the package's own test docblock and guide both correctly explain |
| 14 | LOW-MED | `jest.resetModules()` leaves the `window` delta hook behind — the one mechanism the component's other effect uses |
| 15 | LOW | `STREAMING-SSR.md:704-706` and `createAsyncContext.js:82-84`: "still calls `fn`" is false in the development branch the same sentence describes |
| 16 | LOW | `BYTES_AFTER_END` is development-only, against the design's own written reason for making its sibling warning production-visible |
| 17 | LOW | `main()`'s three new gates and `validateInstall` have zero test coverage, in the file whose docblock says otherwise; four surviving mutants in `versionGates.spec.js` |
| 18 | LOW | `interrupted` and `did not run` are unparsed; a flaky row prints in the same format as a green row |
| 19 | LOW | Assorted: `./server/package.json` is `ERR_PACKAGE_PATH_NOT_EXPORTED`; `src/types`' exemption reason is wrong; `StyleSheet` property order changed; the published `.js.flow` is not valid Flow (pre-existing) |

---

# CONFIRMED

## 1. HIGH — the matrix runner reports green, exit 0, with 31 of 32 tests never run

`packages/streaming-ssr-e2e/scripts/react-version-matrix.js:452-469`

Review 2 (#11) could not construct a green-while-broken run. Here is one. A stray `test.only` —
the single most common thing left behind after debugging a spec — and `forbidOnly:
!!process.env.CI` (`playwright.config.js:11`) is **off** on a dev machine, which is the only
place this script is ever run (it is not in CI at all).

`.only` added to one test in `specs/versionGates.spec.js`, real runner:

```
### F: a stray test.only, CI unset (forbidOnly is off) ###
SCRIPT EXIT=0
[react-version-matrix] === React 19.3.0 ===
Running 1 test using 1 worker
  1 passed (713ms)
  React 19.3.0 (ran as 19.3.0): 1 passed, 0 skipped, 0 failed
```

`1 > 0`, so the new floor passes. `failed === 0`, `flaky === 0`, `exitCode === 0`,
`reactThatRan === '19.3.0'` — all four new checks satisfied. The row is indistinguishable from
the real one, `29 passed, 3 skipped`.

The runner *prints* `Running 1 test using 1 worker` and never parses it. There is no
expected-total, no floor above zero, and no cross-version consistency check — which is precisely
what a matrix needs, since the whole point is comparing row to row. `0 passed` was hardened;
`1 passed out of 32` was not, and it is the more likely accident.

Same shape, **not separately measured**: a `test.describe.skip` left at the top of
`streamingHead.spec.js`, or a spec renamed so `testMatch: '**/*.spec.js'` misses it. Both leave
`passed > 0` and both are silent.

This falsifies the script's own contract at `:20-22` ("if the numbers a documentation claim
cites don't come back from this script, the claim is wrong, not the script") and its header
claim at `:49-51` ("every one of these would otherwise be reported as a pass").

## 2. MED-HIGH — the docs-drift guard does not guard two of the three claims it names

`packages/react-native-web/src/__tests__/docs-drift-test.node.js`

Its docblock: *"What it does guarantee is that the three specific claims above cannot be
reintroduced."* Two of the three can be, verbatim, and the suite stays green.

The difference is structural. The missing-anchor check runs its `forbidden` patterns over the
**whole document** (`:265-278`). The duplicate-shell check runs its patterns only over
`region('STREAMING-SSR.md', 'duplicate-shell')` (`:330-352`), and the scope-gating check only
parses table rows out of `region(…, 'scope-gating')` (`:239-244`) — it never looks at prose.

Measured. Appended to the end of `STREAMING-SSR.md`, outside every region:

```
The duplicate-shell `console.error` is **development-only**; it is silent in production.
All of these lower-level CSS APIs are no-ops or return `''` outside a request scope.
The delta script's missing-anchor fallback creates the anchor itself rather than drop the rules.
```
```
✕ the delta script queues rather than creating a missing anchor
✓ the duplicate-shell warning fires in production, and is documented that way
✓ the scope-gating table matches what the APIs do outside a scope
Tests: 1 failed, 10 passed, 11 total
```

One of the three fired. The other two are `ADVERSARIAL-REVIEW-2.md` #3 and
`ADVERSARIAL-REVIEW.md` #9 / `ADVERSARIAL-REVIEW-2.md` #8 (which already SURVIVED one rewrite) —
reinstated word for word, green.

The docs reviewer reached the same conclusion independently, by re-implementing `region` /
`flatten` / both blocklists and running them over in-memory mutants (baseline of the replica
agrees with the real suite, which is the control):

```
--- M1: "development-only" INSIDE the fenced region ---
duplicate-shell : FAIL (caught by /development-only/i)      ← guard works
--- M2: the SAME sentence moved 2 lines OUTSIDE the region ---
duplicate-shell : PASS (guard silent)                       ← guard defeated
--- M3: reworded fallback ("the chunk script synthesises the <style> … itself") ---
missing-anchor  : PASS (guard silent)
--- M4: verbatim old wording restored anywhere in the doc ---
missing-anchor  : FAIL (caught by /creates the anchor itself/i)
```

M2 is a two-line move, and a free-standing sentence outside a fence is exactly how the original
defect was written both times.

Three further holes, each measured:

- **A rewording inside the region also passes.** Inserted into the `duplicate-shell` region:
  `"Production builds do not log it; NODE_ENV=production suppresses the message entirely."` →
  `Tests: 11 passed`. The six `forbidden` patterns are literal phrasings of the sentence review 2
  happened to find; the check is a blocklist of past wordings, not a claim about meaning. (This
  one *is* disclosed by the docblock — "a paragraph that avoids every forbidden phrase … passes".
  M2 and the prose-outside-the-fence gap are not.)
- **`REACT19-FINDINGS.md` is in `DOC_FILES` but in no phrase check.** Both forbidden loops iterate
  `['STREAMING-SSR.md', 'README.md']`. Appended to `REACT19-FINDINGS.md`: the missing-anchor
  sentence plus the development-only sentence → `Tests: 11 passed, 11 total`. That is the file
  review 2 #9 caught teaching a deleted mechanism in the present tense. `SUSPENSE-TODO.md` is not
  in `DOC_FILES` at all, and it was a home for a reintroduced claim in round 2.
- **The scope-gating claim already exists as prose outside its own fence.** `STREAMING-SSR.md:827-831`
  restates it in words ("Only the *delta* accessors are scope-gated — …"). That sentence is
  unchecked; the table three lines below it is checked.

What the suite *does* get right, measured: deleting the `<!-- drift-check: duplicate-shell -->`
markers fails the suite (`region()` throws), so a region cannot be dropped silently, and all
three regions genuinely enclose what the test reads.

The `spec-files` fence guards only the **8 spec files** count. The `32 specs` claim and the whole
per-version table sit outside it — openly stated in the doc, but it is the largest blind spot,
since the table is the headline number in both consumer docs.

## 3. MED-HIGH — `FORCE_COLOR=1` makes all four summary regexes miss, and a green run reports FAILED TO RUN

`react-version-matrix.js:357-368`

Playwright wraps every summary token in colour (`node_modules/playwright/lib/runner/index.js:1197-1220`:
``colors.green(`  ${expected} passed`)``), and the escape lands **before** the leading spaces,
so `^\s*(\d+)` cannot match. Measured on a real run:

```
$ FORCE_COLOR=1 E2E_PORT=4399 npm run e2e   # 29 passed, 3 skipped, exit 0
^[[33m  3 skipped^[[39m
^[[32m  29 passed^[[39m^[[2m (21.3s)^[[22m

parseSummary = {"failed":0,"flaky":0,"passed":0,"skipped":0}
reactThatRan = "19.3.0"
ranAnything  = false
```
```
### E1: FORCE_COLOR=1 through the whole matrix runner ###
SCRIPT EXIT=1
  React 19.3.0: FAILED TO RUN - the suite did not produce a result
    (npm run e2e exited 0 with no Playwright summary - see output above)
```

The direction is safe — all four counters go to zero together, so the `ranAnything` gate catches
it and it is never a false green. But the script is **100% unusable** under a very common
environment variable, and the diagnostic actively misdirects: it says "no Playwright summary"
while the summary is three lines above, and "exited 0" — the one combination that should read as
"your output is coloured", not "the run died". One `.replace(/\x1b\[[0-9;]*m/g, '')` fixes it.

## 4. MEDIUM — the `exports` map blocks every extensionless deep import of a non-`index.js` module

`packages/react-native-web/package.json` (not edited — reported for the owning agent)

The two-key pattern per directory is

```json
"./dist/cjs/exports/*.js": "./dist/cjs/exports/*.js",
"./dist/cjs/exports/*":    "./dist/cjs/exports/*/index.js",
```

`*` in a Node exports pattern matches **across `/`**. So the second key does not mean "a
directory under `exports/`"; it means "anything under `exports/`, with `/index.js` glued on".
For `StyleSheet/StyleSheetAnchors` — a real file — it produces
`./dist/cjs/exports/StyleSheet/StyleSheetAnchors/index.js`, which does not exist, and the array
fallback is not consulted (finding 13).

Measured against the packed tarball, by enumerating **every** file and directory in the package
(1775 specifiers) and running `require.resolve` twice — once with the `exports` key present, once
with it deleted:

```
tested 1775
REGRESSIONS (resolved before the map, blocked now): 508
  extensionless-directory (`…/index`) forms:  300
  nested non-index modules:                   207
     dist/cjs/{exports,modules}: 49   dist/{exports,modules}: 49   src/{exports,modules}: 49
     dist/cjs/vendor: 18 (+18 dist, +18 src)   dist/cjs/{server,types} and twins
```

The 49, per tree, are real shipped files. Confirmed to load fine once the map is removed:

```
LOADS OK   dist/cjs/exports/StyleSheet/StyleSheetAnchors  -> function
LOADS OK   dist/cjs/exports/AppRegistry/getStyleElements  -> function
LOADS OK   dist/cjs/exports/StyleSheet/compiler/hash      -> function
LOADS OK   dist/cjs/types                                 -> object
```

and with the map in place all four are `MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND`. The full 49
includes `exports/Modal/Modal{Animation,Content,FocusTrap,Portal}`,
`exports/ScrollView/ScrollViewBase`, `exports/AppRegistry/{renderApplication,AppContainer}`,
`exports/Picker/PickerItem`, `exports/Text/TextAncestorContext`, all six
`exports/StyleSheet/compiler/*`, all three `exports/StyleSheet/dom/*`, `StyleSheet/{localizeStyle,
preprocess,validate}`, `exports/{View,Text,TextInput,Image}/types`, all six
`modules/useResponderEvents/*`, `modules/{TaskQueue,isLocaleRTL}`, `modules/hydrationState/store`,
`modules/asyncContext/createAsyncContext`, and both `index.browser` stand-ins.

Found independently by two reviewers, by two different probes, with the same conclusion.

Not affected, checked explicitly: everything `babel-plugin-react-native-web`'s moduleMap emits is
depth-1 (`dist/exports/View`) and all of it resolves; the package root and `./server` resolve from
CJS *and* native Node ESM with working named exports; **no doc teaches a deep `dist/…` path**;
esbuild's browser bundle of `./server` still picks `index.browser.js` for both `styleInjection`
and `asyncContext`, 26 KB, zero `require("stream")`.

**Not measured:** whether any real consumer writes these specifiers. `vendor` is on the test's
`NOT_EXPORTED` list with the justification "Nothing outside the package imports them by
specifier" — an assertion, not a measurement. Bundler behaviour beyond Node's resolver and
esbuild is unverified here; a concurrent reviewer owns Metro/Parcel/Rollup.

## 5. MEDIUM — the guard test's invariant is one level deep; the pattern it guards is not

`packages/react-native-web/src/__tests__/packageExports-test.node.js:152-186`

The test's docblock states the design: *"every entry under `exports/` and `modules/` is a
directory containing `index.js`. If someone adds a bare `.js` file there, the directory pattern
starts pointing at `Foo.js` + `/index.js`."* The assertion implements exactly that — `filesIn(dir)`
and `dirsIn(dir)` are called on `src/exports` and `src/modules` only, never recursively — while
the `*` it guards is multi-segment.

Measured. Four probe files created in the working tree, suite run, files deleted:

```
A  src/newdir/index.js                       -> ✕ every top-level source directory is mapped…  (caught)
B  src/exports/ZzBogus.js                    -> ✕ every entry under exports/… is a directory   (caught)
C  src/exports/StyleSheet/ZzNested.js        -> 7 passed                                       (MISSED)
D  src/exports/StyleSheet/zzdir/other.js     -> 7 passed                                       (MISSED)
```

C is the shape that already exists 49 times per tree (finding 4). D is a directory with no
`index.js` one level down. The guard fires for the two shapes the tree does not contain and is
blind to the two it does. `test('every importable directory resolves through the map to its
index.js')` has the same horizon.

Separately, `resolveSubpath`'s tie-break is not Node's. Node's `patternKeyCompare` orders by base
length **then by suffix length**; the model compares base length only
(`if (best != null && best.base.length >= base.length) return;`), so among the deliberate
`*.js`/`*` pairs — identical bases — the winner is whichever `Object.keys` yields first. It agrees
with Node today only because the map happens to list `*.js` first in every pair. Reorder any pair
in the JSON and the model diverges from the runtime it claims to model, with no test naming that
as the reason.

## 6. MEDIUM — the guide asserts the invariant the map is built on, and it is false

`packages/react-native-web/STREAMING-SSR.md:74-80`:

> `dist/exports/*`, `dist/modules/*` and their `dist/cjs/` and `src/` twins are all
> **directories-with-`index.js`**, which is what makes that enumeration exact rather than a guess.
> That is a standing maintenance cost: a new top-level directory under `src/`/`dist/` needs its
> own `<dir>/*.js` and `<dir>/*` pair, or extensionless imports into it stop resolving.

```
$ find src/exports -name '*.js' ! -name 'index.js' ! -path '*__tests__*' | wc -l   →  33
$ find src/modules -name '*.js' ! -name 'index.js' ! -path '*__tests__*' | wc -l   →  16
```

Forty-nine, in this tree, today. The sentence is true of the *top level* of those two directories
and false of the trees the pattern spans — the same off-by-one-level as findings 4 and 5, written
down as the reason to trust the map. And the stated maintenance cost is the wrong one: the real
cost is nested non-index modules, and it is already paid.

The paragraph's other claims **do** hold, checked: Node does not try the next array entry when a
file is missing; `module` is never matched by Node; the `.` and `./server` condition ladders are
identical; and the doc's own escape hatch — "Verify any change to the map against a real
`npm pack` tarball installed into a clean `"type": "module"` project" — is the right advice and is
present where `packageExports-test.node.js`'s docblock claims it is.

## 7. MEDIUM — the defence of `major !== 18` rests on a version string React never reports

`StyleSheetAnchors.js:261-262`, `StyleSheetAnchors-warning-test.js:211-222`

Measured `parseInt(React.version, 10)` against every real install in the cache:

```
0.0.0-experimental-019019be-20260911   React.version 19.3.0-experimental-…  parseInt 19 | !==18 warns? false | <19 warns? false
18.3.1                                 React.version 18.3.1                 parseInt 18 | !==18 warns? true  | <19 warns? true
19.0.0 / 19.0.8 / 19.1.0 / 19.1.1 / 19.2.0 / 19.3.0                         parseInt 19 | !==18 warns? false | <19 warns? false
```

**Identical decisions on all eight.** The claimed harm — "false positive on 0.0.0 builds off main"
— cannot occur, because `React.version` on the experimental channel is `19.3.0-experimental-…`,
not `0.0.0-experimental-…`. That is the repo's *own* measured finding, written into
`specs/helpers.js:208-217` and asserted at `specs/versionGates.spec.js:66`. The warning-test
comment at `:212-218` states the opposite of what the harness next door proves.

Mutation-tested. Mutant M3 (`if (major >= 19) return;`, i.e. warn when `major < 19`) is killed by
exactly **one** test:

```
MUTANT: M3 gate on major < 19 instead of !== 18
   ✕ is silent on an experimental build, which is not React 18      (1 failed, 17 passed)
```

Changing only that test's pinned string from the fictional published version to the real runtime
one and re-running M3:

```
--- baseline with REAL experimental React.version pinned ---    10 passed
--- M3 (warn when major < 19) WITH the real string pinned ---   10 passed   ← mutant SURVIVES
```

So the sole test protecting `major !== 18` protects it against an input that does not exist.
Review 2's S3 stands unrefuted: `major !== 18` is silent on React 20+, and nothing measured
supports preferring it. The *conclusion* (harmless today) happens to hold; the reason given for
it is measurably wrong.

**Not checked:** whether any historical React build ever reported `0.0.0-…` as `React.version`.
The measurement covers the eight installs on disk and today's experimental channel.

## 8. MED-LOW — the `IStyleSheet` comment's mechanism is false, and it hides a one-line guard that works

`src/exports/StyleSheet/index.js:764-774` (shipped verbatim to consumers at
`dist/exports/StyleSheet/index.js.flow:432-442`):

> This is the only shape Flow can check. `const stylesheet: IStyleSheet = StyleSheet` below reads
> like the guard on this surface and is not one: **Flow 0.148 treats a function's statics as
> unsealed**, so that annotation holds whether or not any of these members exist…

The conclusion is right and the mechanism is backwards. Flow 0.148, isolated probe:

```js
function F(x: number): string { … }
type WithCall = { (x: number): string, missingMember: number, wrongType: string };
const a: WithCall = F;              // ← 0 errors
type NoCall = { alsoMissing: number };
const b: NoCall = F;                // ← Cannot assign `F` to `b` because property
                                    //   `alsoMissing` is missing in function [prop-missing]
```

Function statics are **not** unsealed. What defeats the guard is the **call signature** in the
object type: an object type with a call signature, checked against a function value, ignores every
property member. `IStyleSheet` has one, so it checks nothing.

This matters because the comment tells the next maintainer the surface is uncheckable, and it is
not. The derived statics type already exists three lines below; dropping `$Exact` from it makes it
a working assertion. Measured on the real file — `Object.assign(StyleSheet, statics)` deleted, with
the proposed guard added:

```
const _guard: $Diff<IStyleSheet, {||}> = StyleSheet;
$ flow check --flowconfig-name ./configs/.flowconfig
Found 14 errors        ← one per static
```

versus the tree as it stands (finding 9 below). `$Exact` must go: with it, the annotation fails
for a different reason (`inexact function [1] is incompatible with exact` — measured), which is
probably how the author concluded it was impossible.

## 8b. MED-LOW — deleting the whole public statics surface is Flow-silent

Same file, `:823`. Measured on the real tree:

```
$ perl -0pi -e 's/^Object\.assign\(StyleSheet, statics\);\n//m' src/exports/StyleSheet/index.js
$ npx flow check --flowconfig-name ./configs/.flowconfig
Found 0 errors
$ npx eslint …/StyleSheet/index.js --config ./configs/.eslintrc
  775:7  error  'statics' is assigned a value but never used  no-unused-vars
```

`StyleSheet.create`, `.flatten`, `.Anchors`, `.absoluteFill` and ten more vanish from the public
API and Flow says nothing. The only thing that catches it is `no-unused-vars`, and only because
`statics` happens to have exactly one reference — add a second use anywhere and nothing catches it
at all. The comment at `:853-854` ("Vacuous as a check … kept because it is the annotation
consumers and `gen-flow-files` read") is honest about the state; finding 8 is that it need not be
the state.

## 9. MED-LOW — `REACT19-FINDINGS.md` marks a fixed defect NOT FIXED and quotes source that no longer exists

`REACT19-FINDINGS.md:76`
```
| 5 | Doc comment cited a 2048-byte Fizz view (4096 on React 19) | **NOT FIXED** — see below |
```
`:81-83`
```
`src/modules/styleInjection/index.js:166-167` still reads "The view is 2048
bytes on React 18 and 4096 on React 19", which the correction 15 lines below contradicts
```

Measured:
```
$ grep -rn "2048 bytes on React 18 and 4096" packages/react-native-web/src/     (no hits, exit 1)
$ sed -n '166,167p' packages/react-native-web/src/modules/styleInjection/index.js
 *    get `<div data-pa<script>…</script>ss="7">`. (The view is 2048 bytes
 *    on React 18.3.1, 19.0.0, 19.1.1 and 19.2.0, and 4096 only from 19.3.0
```

The cited lines are the *corrected* text. mtimes explain it: `REACT19-FINDINGS.md` 19:01:20,
`styleInjection/index.js` 19:10:06 — the doc was written nine minutes before the fix landed and
never re-checked. This is review 2 #14 inverted, not fixed: the status column says the opposite of
the tree. Duplicated verbatim in **`SUSPENSE-TODO.md:1407-1409`** under "Left for other owners",
which is a live to-do pointing at finished work.

The underlying numbers in both docs are exactly right (`grep -o` over each cached install):
```
18.3.1 2048 | 19.0.0 2048 | 19.0.8 2048 | 19.1.0 2048 | 19.1.1 2048 | 19.2.0 2048 | 19.3.0 4096
```

## 10. MED-LOW — `SUSPENSE-TODO.md:1411` says the file was not touched, 550 lines after touching it

```
- **`SUSPENSE-TODO.md:859` vs `:950`** still disagree about whether the missing-anchor fallback
  exists (`:950` is right: it is deleted). Not touched, since this file is shared.
```

`SUSPENSE-TODO.md:861-867` is a `> **Superseded.**` block added in this same rewrite that retracts
the `:859` paragraph and points at `:950`. Both regions carry mtime 19:10:17. The two halves of one
file disagree about whether the file was edited.

## 11. MED-LOW — the experimental-run citation describes a suite state that no longer exists

`STREAMING-SSR.md:207-211`
```
`react@experimental` is not in the default matrix … but the same script was pointed at it in this
round and it came back green, with the three 18-and-19.0-only specs skipping as intended.
```
against `:167` ("…and React 19.4+ / canary / experimental builds" — listed as unverified) and
`:1308` ("Still nothing is claimed about: … React 19.4+, canary and experimental builds").

The run is recorded in-tree at `specs/helpers.js:216` and `specs/versionGates.spec.js:65` as
**"26 passed, 3 skipped"** = 29 tests. The suite is 32 (`npx playwright test --list` → `Total: 32
tests in 8 files`). `versionGates.spec.js` splits 5 + 3; 24 + 5 = 29, so the experimental run
predates the three matrix-runner tests. The skip *count* still holds by gate arithmetic, so the
conclusion is not wrong — but it is provenance for a suite that no longer exists, and the document
contradicts itself on whether experimental is claimed at all. (A fresh experimental run *was*
performed for this review and came back `29 passed, 3 skipped` — see could-not-break below — so
the claim is now true; the citation is what is stale.)

## 12. MED-LOW — the matrix runner cannot be pointed at a dist-tag

`react-version-matrix.js:229-235` compares `installed[pkg] !== version` where `version` is the
*argument*:

```
--- validateInstall if you pass the DIST-TAG (what npm view prints) ---
["react@0.0.0-experimental-019019be-20260911 is installed where react@experimental was asked for",
 "react-dom@0.0.0-experimental-019019be-20260911 is installed where react-dom@experimental was asked for"]
```

`npm install react@experimental` succeeds, then `validateInstall` throws and the row is FAILED TO
RUN. Same for `next`, `canary`, `latest`, and any range (`^19`). It fails loud, so it is not a
correctness hole — but `.github/workflows/react-integration.yml:17` installs `react@next` on a
schedule, `helpers.js:220-222` says the published string is "what
`scripts/react-version-matrix.js` takes as an argument", and `versionGates.spec.js:60-66` cites a
green experimental run — a run reproducible only by hand-typing the resolved
`0.0.0-experimental-<sha>-<date>`, which changes daily.

## 13. LOW-MED — the two fallback arrays in the map are unreachable decoration

`"./dist/*"` and `"./src/*"` are each `["./X/*.js", "./X/*/index.js", "./X/*"]`.

Node walks a fallback array looking for a target that is *shaped* validly, not one that exists.
Every entry here is a well-formed relative target, so entry 1 always wins and entries 2 and 3 can
never run. Measured: `dist/cjs/types` resolves to `./dist/cjs/types.js` and fails, even though
`dist/cjs/types/index.js` is right there and is entry 2 of the array; same for `dist/cjs/server`,
`dist/cjs/vendor/hash` and the 18 `vendor/react-native/*` directories.

This is stated correctly in two places the same author wrote — `packageExports-test.node.js`'s
docblock (*"a fallback array is NOT a search path"*) and `STREAMING-SSR.md:76-78` — and then
contradicted by the map, which is written as though it were one.

## 14. LOW-MED — `jest.resetModules()` leaves the one global the component actually uses

`ingestDelta.js:331-333`:
```js
if (typeof window[HOOK_KEY] !== 'function') { window[HOOK_KEY] = drain; }
```

`window` is the shared jsdom global; `resetModules` does not touch it. The first test's `drain`
closure — bound to the *first* test's `StyleSheet/index.js` instance and its `sheets` array —
stays installed for the whole file, and every later test's `drainDeltaQueue()`
(`StyleSheetAnchors.js:316`) calls it. Measured with a temporary probe:

```
[PROBE] n= 1  hookSameAsFirst= true  anchorsModuleSameAsFirst= true   sheetModuleSameAsFirst= true
[PROBE] n= 2  hookSameAsFirst= true  anchorsModuleSameAsFirst= false  sheetModuleSameAsFirst= false
```

Modules reset correctly (`false`); the global hook does not (`true`). Latent for this file — it
never pushes onto `window.__RNW_DELTA__`, so `drain` no-ops — but any future delta-drain assertion
added here would be measuring test 1's orphaned sheet. `StyleSheetAnchors-test.js:68-69` deletes
both globals in its `afterEach`; the warning file does not.

## 15. LOW — "still calls `fn`" is false in the branch the same sentence describes

`STREAMING-SSR.md:704-706`, duplicated at `createAsyncContext.js:82-84`:
> Without an `AsyncLocalStorage`, `runInRequestScope` still calls `fn`, but it throws in
> development and logs once in production rather than quietly sharing state across requests.

Measured against `dist/cjs/modules/asyncContext/index.browser.js`:
```
NODE_ENV=(unset)      threw: yes | fn called: false | returned: undefined | console.error: 0
NODE_ENV=production   threw: no  | fn called: true  | returned: 7         | console.error: 1
```
`createAsyncContext.js:88-89` throws before `return fn()`. Production is exactly as documented;
the development half is not.

## 16. LOW — `BYTES_AFTER_END` is development-only, against the design's own argument

`src/modules/styleInjection/index.js:572-575`
```js
if (process.env.NODE_ENV !== 'production' && !hasWarnedBytesAfterEnd) {
```

`markShellEmitted` deliberately has no such guard, and `STREAMING-SSR.md:1187-1196` gives the
reason: *"a warning nobody would ever see on a deployed server is not loud enough for a symptom —
some rules silently outranked by others — that nobody reproduces locally."*

Trap 7b is the same shape and slightly worse: `emitDelta` calls `StyleSheet.takeDeltaHTML()`
**before** `push()` discovers it cannot deliver, so the rules are consumed off the request
watermark and then dropped. In production that is a page missing CSS with no signal anywhere.
Reproduced (free-running sink, real transform): the late rule is absent from an 819,960-byte
response and, with `NODE_ENV=production`, nothing is logged.

Severity is low because React never reaches this path (verified under could-not-break). The point
is that the two warnings answer the same question differently and only one wrote down why.

## 17. LOW — the matrix runner's own gates are untested, and four `versionGates.spec.js` mutants survive

`react-version-matrix.js:494-506` says the checks are exported "so the checks above can be
required and asserted on directly — `specs/versionGates.spec.js` does exactly that". It imports
`parseSummary`, `reactThatRan`, `satisfies` (`versionGates.spec.js:40-44`). It does **not** import
`validateInstall`, which is exported and never asserted anywhere. And the three decisions that
actually gate a row — `!ranAnything`, `reactThatRan !== runtimeVersion`, `passed === 0`
(`:431-459`) — live in `main()`, which is unexported and untestable. Every one had to be verified
by running the real script.

Surviving mutants (13 of 18 die):

| Mutant | Result |
|---|---|
| H13 `reactThatRan` returns **first** match instead of last | SURVIVES — the documented "last wins" choice (`:386`) is untested; every fixture has one match |
| H17 `failed` regex unanchored → `/(\d+) failed/` | SURVIVES — the anchoring the docblock at `:352-355` explicitly justifies is not guarded |
| H18 `reactThatRan` regex → `/\(react ([^)]+)\)/` | SURVIVES — nothing pins the `[e2e] listening on` prefix |
| H9 `MAIN_LINE` → `/^0\./` | SURVIVES — flips `majorOf('0.0.0')` from `0` to `Infinity`, unnoticed |
| H6 `atLeast` stops stripping the prerelease suffix | SURVIVES but **equivalent**: `Number('0-canary-abc') \|\| 0` is already `0`, so `.split('-')[0]` is dead code, not a test gap |

Killed by the test that names it: H1, H2, H3, H4, H5, H7, H8, H10, H11, H12, H14, H15, H16.

## 18. LOW — two summary counters are unparsed; a flaky row looks like a green row

`playwright/lib/runner/index.js:1204` (`${n} interrupted`) and `:1217` (`${n} did not run`) are two
more counters `parseSummary` does not read, so they contribute nothing to `ranAnything` and nothing
to `ok`. Both come with a non-zero exit in the paths that could be reasoned about — **not
reproduced** as a false green; a `maxFailures`/worker-crash run was not constructed.

A flaky row prints in the *same* format as a green one — `React 19.3.0 (ran as 19.3.0): 1 passed,
0 skipped, 0 failed, 1 flaky` — with no `FAILED`/`NOT OK` marker. Only the exit code distinguishes
it.

## 19. LOW — assorted

- `@edkimmel/react-native-web/server/package.json` is now `ERR_PACKAGE_PATH_NOT_EXPORTED`
  (measured). The shim still ships (`npm pack` → `package/server/package.json`) and a toolchain
  that ignores `exports` still reads it off disk, so this only bites a tool that reaches it by
  specifier. `./package.json` at the root *is* exported.
- `src/types` is listed in `NOT_EXPORTED` as "Flow type declarations; there is no runtime module to
  import", but `dist/cjs/types/` contains two real compiled modules (`index.js`, `styles.js`). The
  exemption is right in effect and wrong in its stated reason.
- Property enumeration order on `StyleSheet` changed with the `Object.assign` refactor
  (`create`↔`compose`, `takeRequestDelta`↔`resetRequestDelta`, `takeShellHTML`↔`takeDeltaHTML`
  swapped; `hairlineWidth` moved from last to eighth). No consumer of that order exists in the tree
  — no `Object.keys`/`for…in`/spread/`Object.entries` over `StyleSheet`, and no snapshot.
- The published `dist/exports/StyleSheet/index.js.flow` is not valid Flow: 14 `prop-missing` errors
  at `Object.assign(StyleSheet, statics)`, because `gen-flow-files` turns the function into a
  `declare function` and keeps the runtime statement. **Pre-existing, not caused by this change** —
  the pre-refactor form (`SS.m = 1;` after a `declare function`) errors identically, measured. But
  nothing in the build or CI ever type-checks the published declaration, and the refactor's own
  justification is "this is the only shape Flow can check".

---

# SUSPECTED

- **The ran-vs-installed cross-check observes only the SSR-side React, not the browser's.**
  `server.js:376,424` reports `React.version` from the *node* bundle. Aliasing the node bundle but
  not the client bundle (`build.js:80`) produced `React 19.3.0 (ran as 19.3.0)` while the browser
  ran 18.3.1 — the skew was caught by the specs (`14 failed`, exit 1), not by the check. Not a
  defect today; a scope limit the docblock at `:370-381` ("the only end-to-end evidence available
  that `E2E_REACT_DIR` was honoured") overstates.
- **`output` is built as stdout followed by stderr (`:396`) with no separator.** If stderr
  were non-empty and stdout not newline-terminated, the joined line would defeat the anchored
  regexes. Measured on a real run: stderr is 0 bytes and stdout ends with `0a`, so **not
  reproduced**.
- **19.1.1 and 19.2.0 matrix rows have never been run by any reviewer.** They differ from 19.3.0
  (verified in review 2) only in Fizz view size and from 19.1.0 not at all in preamble terms, so
  29/3 is very likely — but no run exists.
- **`STREAMING-SSR.md:559-562`** claims `hydrateRoot(document, …)` "verified working … on React
  18.3.1, 19.0.0, 19.1.1, 19.2.0 and 19.3.0". Only 18.3.1 was re-verified here.
- **`StyleSheet.hasEmittedShell()`** is still on the published surface (`typeof === 'function'`;
  `false` outside a scope, `true` after a shell inside one) and appears **0 times** in either
  consumer doc. Already raised in review 1 #16's tail, so noted, not re-filed.

---

# SURFACES I TRIED HARD TO BREAK AND COULD NOT

## A. The CRITICAL ordering invariant, re-verified from scratch under real backpressure

The brief said not to accept the claim. It was re-verified with a real `renderToPipeableStream`
piping into a real sink whose `write()` returns `false`, instrumented to record every byte's
provenance and to flag any `push()`/`originalWrite` interleaving that landed **inside a tag**.

```
React 18.3.1, text-heavy   4 deltas   maxWritableQueuedAtFlush=59   INSIDE-A-TAG splices: 0
React 18.3.1, attr-heavy  19 deltas                                 INSIDE-A-TAG splices: 0
React 18.3.1, attr-heavy  12 deltas                                 INSIDE-A-TAG splices: 0
React 19.3.0, text-heavy   3 deltas                                 INSIDE-A-TAG splices: 0
```

All deltas landed between elements. **Negative control**, to prove the harness can see the
failure: `if (forwarding)` changed to `if (true)` in `push()` →

```
INSIDE-A-TAG splices: 2      e.g.  <div data-pa<style …>…</style>ss="7">
```

The harness detects the regression it is looking for, and the shipped code does not have it.
`push()` only inside `_transform`/`_flush`, `originalWrite` otherwise — **holds**.

## B. `tail` under a parked queue — the fallback delivers

Both arrangements reproduced with a real React render:

- **Parked sink** (`write()` returns `false`, drain withheld until after `end()`): the late delta
  arrives, at byte offset 820191 of an 820659-byte response, ordered correctly, `order` =
  `['end','flush','_flush']`.
- **Free-running sink**: `_flush` has already run when the late bytes arrive, `flushed` is `true`,
  the bytes are dropped and `BYTES_AFTER_END` fires once (finding 16 is about that drop being
  silent in production, not about the latch being wrong).

The `flushed` latch does what it says. Claim **HELD**.

## C. All five write forms arrive as Buffer with `encoding === 'buffer'`

Node 24.18.0, real transform: `write(string)`, `write(string,'utf8')`, `write(string,'utf16le')`,
`write(string,'base64')`, `write(Buffer)`, plus four extra shapes tried (`Uint8Array`,
`write(str, cb)`, `write(buf, 'binary')`, `end(str)`) — **all nine** arrive as `Buffer` with
`encoding === 'buffer'`. The only constructions that differ are `decodeStrings:false` and
`objectMode`, and the transform's own constructor forbids both. Claim **HELD**.

## D. The narrowed anchor-scan join window

`Buffer.concat([anchorCarry, bytes.subarray(0, 15)])` with `ANCHOR_MARKER` 16 bytes and
`ANCHOR_CARRY_MAX` 15. Fuzzed: the marker split at every one of its 15 interior offsets, across
chunk sizes 1…64, with adversarial near-miss prefixes (`data-rnw-group=` without the quote,
repeated partial prefixes, the marker straddling three chunks). Every split was found; no false
positive from the near-misses; the two deleted branches in `scanForAnchorBytes` were unreachable
given the carry-length arithmetic (`bytes.length >= ANCHOR_CARRY_MAX` covers the else). Also
byte-for-byte identical output to the pre-narrowing implementation across 2,000 random chunkings.

## E. The `react@experimental` classification — review 2 #10 is dead

```
pkg 0.0.0-experimental-019019be-20260911   React.version 19.3.0-experimental-019019be-20260911
[WebServer] [e2e] listening on http://127.0.0.1:4399 (react 19.3.0-experimental-019019be-20260911)
  3 skipped / 29 passed (19.8s)
  React 0.0.0-experimental-… (ran as 19.3.0-experimental-…): 29 passed, 3 skipped, 0 failed
```

`/env` returns `19.3.0-experimental-…`, so `reactMajor()` end to end is **19** (`isMainLine` false
→ `split('.')[0]` → 19). The three skips are the React-18 and React-19.0.x branches, i.e. correct
classification. The residual risk is only for the *published* string, which `majorOf`/`isMainLine`
now map to `Infinity` — a defensible choice, correctly tested.

## F. Matrix-runner hardening that is genuinely load-bearing

Every one a real run of the real script.

- `0 passed, 24 skipped` → `FAILED TO RUN - nothing ran: 0 passed, 24 skipped, 0 failed`, exit 1.
  The `passed > 0` floor is real; the case it was written for was constructed and it fires.
- A spec that throws at collection → `FAILED TO RUN … exited 1 with no Playwright summary`, exit 1.
- **Poisoned cache, honest manifests** (`react@19.3.0` + `react-dom@19.2.0`): `validateInstall` now
  catches it *before* the run — `["react-dom@19.2.0 is installed where react-dom@19.3.0 was asked
  for", "scheduler@0.28.0 does not satisfy react-dom@19.2.0's dependency on scheduler@^0.27.0"]`.
  The gap review 2 flagged is closed.
- **Poisoned cache, lying manifest** (react-dom *code* 19.2.0, package.json rewritten to 19.3.0,
  ranges adjusted): `validateInstall` returns `[]` — but React's own coupling kills it,
  `Incompatible React versions: … must have the exact same version` → FAILED TO RUN, exit 1. The
  manifest-only check has a hole; it is not exploitable.
- A stale server on the port → `Error: http://127.0.0.1:4321/health is already used`, exit 1.
- **The ran-vs-installed cross-check is not derivable without observing the run.** `const REACT_DIR
  = null` in `build.js` → `React 19.3.0: FAILED TO RUN - the suite ran against React 18.3.1, not
  the React 19.3.0 installed for it`. Without the check that mutant produces a green 19.3.0 row
  from an 18.3.1 suite.
- **`flaky === 0` is load-bearing.** Playwright's `failOnFlakyTests` defaults false; measured
  directly, a run with `1 flaky, 1 passed` exits **0**. Real hardening.

## G. Both new jsdom test files kill every targeted mutant

- **All 10 tests in `StyleSheetAnchors-warning-test.js`** die to a mutant of the exact behaviour
  they name. No survivors. M1 gate removed → the three "is silent" tests; M2 gate inverted → 8;
  M4/M5 latch → "warns once"; M6 selector drops `[data-rnw-runtime]` → 4; M7 `document` instead of
  `head` → "outside `<head>`"; M8 hardcoded count → "counts every runtime anchor"; M9 empty-result
  return removed → 2; M10 call deleted → 5.
- The `resetModules` and `document.head` wipe are both demonstrably load-bearing: removing either
  gives `4 failed, 6 passed`.
- **All 8 tests in `StyleSheetAnchors-test.js`** die too, including the repaired one: M11
  (`useState` → direct call) kills **only** `the snapshot is frozen, so a re-render never moves a
  head child`. Review 2's T3 is fixed. Only N7 survives, and that behaviour is owned by
  `StyleSheetAnchors-test.node.js`.

## H. Review-1 and review-2 findings that this rewrite did **not** reintroduce

The brief asked specifically whether the rewrite reinstated anything. Measured, not read:

- **Missing-anchor fallback (R1 #4 / R2 #2) — fixed, no new instance.** `STREAMING-SSR.md:471-497`
  now reads "When a chunk finds no anchor: it queues, it never creates", quotes `else{b.p=1;}`, and
  `:869-872` corrects the old `nonce` parenthetical. From a generated script: `startsWith <script:
  true | contains 'else{b.p=1;}': true | contains createElement|appendChild|insertBefore|
  insertAdjacent: false`. Zero forbidden-phrase hits in any of the three docs.
- **Out-of-scope behaviour (R1 #9 / R2 #8) — fixed, no new instance.** Measured outside any scope
  against `dist/cjs`: `takeShellHTML().length = 749`, `takeShellGroups().length = 6`,
  `takeDeltaHTML() = ""`, `takeRequestDelta() = ""` — matching the four-row table exactly. Source
  gates confirmed at `StyleSheet/index.js:87` and `:158`, and nowhere else.
- **Duplicate-shell dev-only (R2 #3) — fixed.** `:1188` now says "**in production as well as in
  development**"; with `NODE_ENV=production`, three shells inside a scope → 2 `console.error`, and
  outside a scope → 0. Every other dev/prod claim in the two consumer docs was swept for the same
  class: `getStyleElements({id})`, both accessors, duplicate `registerHydrationState` — all behave
  as documented under `NODE_ENV=production`.
- **`RELOCATE_SCRIPT` (R2 #9) — fixed.** `REACT19-FINDINGS.md:257-266` carries a `> **Superseded
  2026-09-11**` block; the corrected citation checks out (`index-test.node.js:181` is literally
  `test("a late boundary's CSS arrives as a delta and leaves no node", …)`). The three surviving
  mentions are all inside "at the time" framing.
- **19.0.8 / 19.1.0 installs (R2 #14) — fixed and honest.** The cache holds a coherent
  react/react-dom/scheduler trio for each of the eight versions, and the docs state the
  reproduction explicitly.
- **`react-native-web/server` unresolvable from Node ESM (R2 #1) — fixed.** Packed tarball into a
  clean `"type":"module"` project, Node 24.18.0: root and `./server` both resolve and import from
  ESM *and* CJS, with working named exports (`import { createStyleInjectionTransform } from
  '@edkimmel/react-native-web/server'` → function). Every import form the docs teach resolves.

## I. Reproduced numbers

- **The preamble grid at `REACT19-FINDINGS.md:118-127` reproduces exactly**, including the
  `completedPreambleSegments` column review 2 got one low:
  `18.3.1 0/0/0/0 · 19.0.0 0/0/0/8 · 19.0.8 0/0/0/8 · 19.1.0 13/12/66/166 · 19.1.1 13/12/66/166 ·
  19.2.0 13/13/64/165 · 19.3.0 13/13/82/162`.
- **Fizz view size**: `18.3.1 2048 | 19.0.0 2048 | 19.0.8 2048 | 19.1.0 2048 | 19.1.1 2048 |
  19.2.0 2048 | 19.3.0 4096` — matching the corrected source comment.
- **The 18.3.1 matrix row**: `node ./scripts/react-version-matrix.js 18.3.1` → `React 18.3.1 (ran
  as 18.3.1): 28 passed, 4 skipped, 0 failed` — exactly the documented row. `--list` gives 32 tests
  in 8 files, matching both the `32 specs` claim and the fenced `8 spec files`. Enumerating the six
  gates gives 18.3.1 → 4 skips (the exact four the run skipped), 19.0.0 → 3, 19.1+ → 3, so 28/4 and
  29/3 are both correct and "no behaviour is skipped on every version" holds.
- **Every citation in the three docs resolves.** Whole-repo basename + ordered-segment match: 0
  dead repo-local file citations, 0 `file:line` refs past EOF, 0 dead internal anchors. Cited
  *contents* spot-checked at `index-test.node.js:181`, `jest.config.node.js:10-12`,
  `StyleSheet/index.js:407`, `:487` — all say what they are cited as saying.

## J. Other things that held

- **The StyleSheet ⇄ StyleSheetAnchors CJS cycle survives every entry order.** `StyleSheet.Anchors`
  is a function whether the anchors module, the StyleSheet module, or the barrel is required first,
  and the barrel yields all 14 statics.
- **The `browser` field survives the `exports` map.** esbuild `platform=browser` on `./server`
  produces a 26 KB bundle containing only the throwing stand-in — zero `require("stream")`, both
  `styleInjection` and `asyncContext` resolved to `index.browser.js`. (An earlier read of
  `node:stream` matches in that bundle was a false alarm: the metafile shows the inputs are the
  browser files and the text is inside the stand-in's error message.)
- **Escaping and hostile input**: `\u003c` in the delta, `<\/style>` in the shell, hostile
  `fontFamily` values contained on both paths; `takeRequestDelta`'s `[stylesheet-group="3"]{}`
  marker present on first appearance and absent on the second flush.
- **The utf16le degradation is exactly as documented**: utf8 streams a delta per boundary; utf16le
  withholds every delta to `_flush`.

---

# TEST QUALITY

Ranked by how much a green run is worth.

1. **`docs-drift-test.node.js` is worth less than it says.** It is a blocklist of five or six
   literal phrasings, applied inconsistently — one check document-wide, two region-scoped, one file
   in `DOC_FILES` never scanned at all, and the file that housed a reintroduced claim in round 2
   (`SUSPENSE-TODO.md`) not in scope. Its docblock promises the three claims "cannot be
   reintroduced"; two of them can, verbatim, two lines outside a fence. The *executed* assertions
   in it (the scope-gating table rows, run against the real APIs) are the strongest part and are
   worth keeping; the prose blocklists should either scan whole documents uniformly or be dropped
   in favour of more executed checks.
2. **`react-version-matrix.js`'s hardening is real but has no floor that matters.** Four of its
   five new gates fire on cases constructed for them (F above). The missing one — an expected-test
   count, or simply requiring the same total on every row — is the one that would have caught the
   HIGH. The gates that decide a row live in an unexported `main()` and are asserted by nothing;
   `validateInstall` is exported and asserted by nothing.
3. **`packageExports-test.node.js` verifies a narrower invariant than it states.** Depth-1 walks
   against a multi-segment pattern (finding 5). It also *models* Node's resolution rather than
   performing it, and the model's tie-break is not Node's — the two agree only because of the
   current key order. The suite would be far stronger performing a real `require.resolve` /
   `import.meta.resolve` against a packed tarball, which the docblock already recommends as the
   verification method for humans.
4. **The two new jsdom test files are genuinely strong.** 18 of 18 targeted mutants die, each to
   the test that names the behaviour, and the two pieces of setup (`resetModules`, the head wipe)
   are both provably load-bearing. Review 2's T3 and T4 are repaired. The one blemish is the
   `window` hook that `resetModules` cannot clear (finding 14).
5. **`after-end-test.node.js` asserts the right sequences but with a hand-driven stream.** The two
   `order` arrays are the correct discriminator between traps 7a and 7b, and they do discriminate.
   What they do not do is exercise a real Fizz writer under real backpressure — which is why A and
   B above were done by hand. Nothing in the suite would notice if the `forwarding` discipline were
   broken; the only detector for that is a whole-response byte-provenance check, and there isn't one.
6. **`versionGates.spec.js` kills 13 of 18 mutants.** The four real survivors (H13, H17, H18, H9)
   are each a documented decision with no test naming it.

---

# WHAT I DID NOT COVER

- **No full 5-version Playwright matrix**, per the brief. Runs performed:
  `0.0.0-experimental-019019be-20260911` (29/3), `19.3.0` (many), `18.3.1` (28/4), plus 18.3.1
  observed on a stale port. **19.0.0, 19.0.8, 19.1.0, 19.1.1 and 19.2.0 rows were not run here.**
  19.1.1 and 19.2.0 have never been run by any reviewer.
- **Chromium only, one machine.** No Firefox, no WebKit. Every FOUC/timing spec taken as-is.
- **Bundlers.** Only Node's own resolver and esbuild were used for the exports-map work. webpack,
  Vite/Rollup, Metro, Parcel, Yarn PnP and pnpm are unverified by this review; a concurrent
  reviewer owns Metro/Parcel/Rollup and its result is not folded in here.
- **How many consumers write the 508 blocked specifiers** is unknown. The regression is measured;
  its blast radius is not.
- **`interrupted` / `did not run` / `maxFailures` / worker-crash matrix runs** were not constructed
  (finding 18). The false-green question there is open.
- **The `test.describe.skip` and renamed-spec variants of finding 1** were not run; only
  `test.only` was measured, and only with `CI` unset.
- **`packages/react-native-web/package.json` and `src/__tests__/packageExports-test.node.js` were
  never edited** — a concurrent agent owns them. Findings 4, 5, 13 and 19 are reported, not fixed,
  and the probes were run against a packed tarball in a scratch project rather than in-tree.
- **`specs/helpers.js`'s non-version exports** (`watchForProblems`, `DELTA_RECORDER`,
  `FRAME_SAMPLER`, `SABOTAGE`, `browserValues`) were read but not attacked.
- **`StyleSheetAnchors-test.node.js`** (14 tests) was out of scope and not re-mutated.
- **`PRIOR-ART.md`, `repro/`, and most of `SUSPENSE-TODO.md`** were read only where a claim under
  review pointed into them. `repro/nextjs-head-hydration/FINDINGS.md` was not audited against
  `STREAMING-SSR.md:565-580`.
- **Whether a historical React build reported `0.0.0-…` as `React.version`** (finding 7) was not
  investigated; the measurement covers the eight installs on disk and today's experimental channel.
- **The `2048`/`4096` and preamble grids** were counted against the cached installs in this tree,
  not re-downloaded from npm.
