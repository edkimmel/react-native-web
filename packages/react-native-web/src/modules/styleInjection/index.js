/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Streaming-SSR CSS injection for React's Node stream renderer — the Node
 * implementation.
 *
 * `StyleSheet.takeShellHTML()` and `StyleSheet.takeDeltaHTML()` produce the
 * two halves of a streamed stylesheet, but getting them into the response in
 * the right places is fiddly and the failure modes are silent. This wraps
 * both in a `stream.Transform` the caller pipes React's output through, so
 * the only thing left to decide is what the surrounding document looks like.
 *
 * `node:stream` is imported statically. Browser and native bundles get
 * `./index.browser.js` instead, via the `browser` field map in
 * `package.json` — the same arrangement, and for the same reason, as
 * `../asyncContext`: a bundler that ignores `browser` fails loudly on an
 * unresolvable `node:stream` rather than shipping something subtly wrong.
 *
 * Node streams only, deliberately. There is no `TransformStream` variant
 * for `renderToReadableStream`, and it is not an oversight or a build
 * problem: the whole design rests on React's Node destination contract
 * exposing `destination.flush()` as an explicit "this pass is finished, the
 * bytes are at an element boundary" signal (see trap 1 below). React's Web
 * Streams path has no equivalent — a `TransformStream` sees the same
 * ~2KB-split enqueues with no way to ask whether the source has finished a
 * pass. It could only guess, and a wrong guess splices the injected chunk
 * into the middle of one of React's tags, corrupting the response instead
 * of failing. A timing heuristic here would be a silent-corruption source,
 * so the honest answer on those runtimes is to call
 * `StyleSheet.takeShellHTML()` and `StyleSheet.takeDeltaHTML()` from the
 * framework's own boundary hooks, which do know where a pass ends.
 *
 * Usage:
 *
 *     import { renderToPipeableStream } from 'react-dom/server';
 *     import { runInRequestScope } from 'react-native-web';
 *     // Server-only, hence its own entry point — this module is what makes
 *     // it so. See `../../server/index.js`.
 *     import { createStyleInjectionTransform } from 'react-native-web/server';
 *
 *     app.get('/*', (req, res) => {
 *       // Everything — the render AND the piping it sets up — has to be
 *       // inside the scope. The per-request delta lives there.
 *       runInRequestScope(() => {
 *         const injector = createStyleInjectionTransform({
 *           nonce: res.locals.cspNonce,
 *           // Called once, immediately before React's first byte is
 *           // forwarded. `shellCSS` is the whole cumulative sheet, one
 *           // <style> per group; put it wherever <head> ends.
 *           prelude: (shellCSS) =>
 *             '<!doctype html><html lang="en"><head>' +
 *             '<meta charset="utf-8">' +
 *             '<meta name="viewport" content="width=device-width">' +
 *             '<title>App</title>' +
 *             shellCSS +
 *             '</head><body><div id="root">',
 *           epilogue: '</div></body></html>'
 *         });
 *
 *         const { abort, pipe } = renderToPipeableStream(<App />, {
 *           bootstrapScripts: ['/client.js'],
 *           onShellReady() {
 *             res.statusCode = 200;
 *             res.setHeader('Content-Type', 'text/html; charset=utf-8');
 *             // Pipe the injector at its destination FIRST, then hand the
 *             // injector to React. See the note on `flush` below: React's
 *             // end-of-pass flush signal only reaches `res` once this
 *             // transform knows where its output goes.
 *             injector.pipe(res);
 *             pipe(injector);
 *           },
 *           onShellError(error) {
 *             res.statusCode = 500;
 *             res.setHeader('Content-Type', 'text/html; charset=utf-8');
 *             res.end('<!doctype html><p>Something went wrong</p>');
 *           },
 *           onError(error) {
 *             console.error(error);
 *           }
 *         });
 *
 *         setTimeout(abort, 10000);
 *       });
 *     });
 *
 * Omit `prelude` if you would rather write the document head yourself. Then
 * it is on you to call `StyleSheet.takeShellHTML()` after the shell has
 * rendered and before the first body byte; the transform still handles every
 * delta after that.
 */

import { Transform } from 'node:stream';
import StyleSheet from '../../exports/StyleSheet';
import { hasRequestScope } from '../asyncContext';

export type StyleInjectionOptions = {
  // HTML appended after the final delta, when React's stream ends. Typically
  // the closing tags the `prelude` opened.
  epilogue?: ?string,
  // CSP nonce, applied to every <style> and <script> this emits.
  nonce?: ?string,
  // Receives the shell stylesheet and returns everything that should precede
  // React's first byte. Taking a function rather than a string is the whole
  // point: the shell can only be serialised at one instant — after the shell
  // render has finished compiling CSS, and before any body markup is on the
  // wire — and the transform is the only party that knows when that is.
  prelude?: ?(shellHTML: string) => string,
  ...
};

const MISSING_REQUEST_SCOPE =
  'react-native-web: createStyleInjectionTransform() is streaming a response ' +
  'from outside a request scope, so no delta CSS is emitted and anything a ' +
  'late Suspense boundary needs will be missing from the page. Wrap the ' +
  'render — and the onShellReady handler that pipes it — in ' +
  'runInRequestScope().';

const NO_DESTINATION =
  'react-native-web: createStyleInjectionTransform() reached the end of ' +
  "React's first streaming pass with nothing piped to it, which is what " +
  '`pipe(injector)` before `injector.pipe(response)` looks like from here. ' +
  "React's end-of-pass flush signal is consumed by this transform and " +
  'forwarded only to destinations it already knows about, so that first pass ' +
  '— the one carrying your shell — is never flushed onward, and a ' +
  'compression stream in between holds the shell until the next boundary ' +
  'resolves. Call injector.pipe(response) first, then pipe(injector). (If ' +
  'you consume the readable side yourself rather than piping, attach that ' +
  'listener before handing the transform to React.)';

const DOWNSTREAM_FLUSH_FAILED =
  'react-native-web: a stream downstream of createStyleInjectionTransform() ' +
  'threw from its flush(). React calls ours once per streaming pass, and we ' +
  'forward it so compression middleware keeps streaming; the throw was ' +
  'swallowed so it could not abort the render mid-response. The CSS for this ' +
  'pass was queued regardless, but bytes may now sit in that stream until it ' +
  'flushes on its own:';

const BYTES_AFTER_END =
  'react-native-web: createStyleInjectionTransform() was handed CSS to inject ' +
  'after its stream had already finished, so those rules are missing from the ' +
  "page. Something called the transform's flush() after end(), and end() had " +
  'already run _flush — the last point at which anything can still be ' +
  'emitted. React does not do this: it calls flushBuffered() before ' +
  'destination.end() on every supported version. Emit the last delta before ' +
  'ending the stream.';

let hasWarnedMissingRequestScope = false;

// The anchors' own marker, as it appears in the byte stream. See trap 6:
// this is the attribute a streamed chunk's `querySelector` uses to find the
// anchor it writes into, so it is already load-bearing on the client rather
// than invented here. ASCII, hence `latin1` — and hence searchable in bytes
// without decoding anything (trap 3).
const ANCHOR_MARKER = Buffer.from('data-rnw-group="', 'latin1');
// The most a marker can have left behind at the end of a chunk without
// having matched in it.
const ANCHOR_CARRY_MAX = ANCHOR_MARKER.length - 1;
const NO_CARRY = Buffer.alloc(0);

/**
 * A `stream.Transform` that forwards React's HTML untouched and splices this
 * request's newly compiled CSS in between chunks.
 *
 * Eight things are load-bearing here, each guarding a failure that is silent
 * if you get it wrong. Traps 1, 1b and 7 are three parts of one question —
 * when to inject, where the bytes then go in, and what happens when there is
 * nowhere left to put them:
 *
 * 1. WHERE THE INJECTION LANDS, IN REACT'S TIMELINE. React does not hand its
 *    destination one complete HTML unit per `write()`. Fizz encodes into a
 *    fixed-size view and flushes it whenever it fills up, so a single
 *    `write()` routinely ends in the middle of a tag — append there and you
 *    get `<div data-pa<script>…</script>ss="7">`. (The view is 2048 bytes
 *    on React 18.3.1, 19.0.0, 19.1.1 and 19.2.0, and 4096 only from 19.3.0
 *    — measured in each build, not inferred from the major. An earlier note
 *    here said "2048 on React 18 and 4096 on React 19"; that was measured
 *    against 19.3.0 alone and over-generalised. Nothing here depends on the
 *    number, or on there being one: the only contract relied on is the
 *    `flush()` boundary below. The sizes are quoted so the next reader does
 *    not go looking for a dependency that isn't there.)
 *
 *    What React does guarantee is `completeWriting()` followed by
 *    `flushBuffered()` in the `finally` of every `flushCompletedQueues()`
 *    pass: the partial view is drained, and then `destination.flush()` is
 *    called if it exists. That call is React's own "everything written so far
 *    is safe to put on the wire" signal — it is what lets compression
 *    middleware flush mid-response — and it is therefore exactly a clean
 *    element boundary. So this transform exposes a public `flush()` and
 *    injects there, never from `_transform`. Verified unchanged, in that same
 *    `finally`, from React 18.3.1 through 19.3.0. (`close()` — the
 *    `destination.end()` that ends the response — is also in that `finally`,
 *    *after* `flushBuffered()`, so our `flush()` never runs on an ended
 *    stream in the ordinary path. `push()` copes with the other order as far
 *    as it can, and reports the case where it cannot; see trap 7.)
 *
 *    Consequence: `flush()` on this object is React's hook, not a method for
 *    callers. It is deliberately distinct from `_flush`, the Transform
 *    end-of-stream hook.
 *
 *    Consequence 2: React calling our `flush()` means it is no longer calling
 *    the one further downstream, so a `gzip` or compression-middleware `res`
 *    after us would buffer the entire response and streaming SSR would stop
 *    streaming. `pipe` is overridden to remember destinations and forward the
 *    flush to any that want one.
 *
 * 1b. WHERE THE INJECTION LANDS, IN THE BYTE STREAM. Knowing the right
 *    *moment* is only half of it; the bytes then have to enter the stream at
 *    the matching *place*, and on a Transform those are two different doors.
 *
 *    React's HTML comes in through `write()`, on the writable side, and only
 *    reaches the readable side when `_transform` runs. Node stops running
 *    `_transform` as soon as the readable buffer reaches
 *    `readableHighWaterMark` — `Transform.prototype._write` parks the write
 *    callback in `kCallback` instead of completing it — and from that instant
 *    every further `write()` React makes simply queues on the writable side.
 *    That is not an edge case: it is what backpressure *is*, and it happens
 *    on any response the client reads more slowly than Fizz produces it.
 *
 *    `stream.push()` writes to the readable side directly. So injecting with
 *    `push()` from `flush()` jumps the whole parked writable queue and lands
 *    the delta ahead of markup React handed over several views ago — i.e. in
 *    the middle of a tag, `<div data-pa<script>…`, which is exactly the
 *    corruption trap 1 exists to prevent, and additionally reorders whole
 *    passes of markup.
 *
 *    So injected bytes go in through the same door React's do: `push()`
 *    (below) calls the Transform's own `write()` when it is invoked from
 *    React's `flush()`, which appends them to the writable queue behind
 *    everything React has already written — that is, behind the pass's
 *    `completeWriting()` write, the one that lands on an element boundary.
 *    They then reach the readable side through `_transform` like any other
 *    chunk, in order, whatever the backpressure state.
 *
 *    Inside `_transform` and `_flush` the situation is reversed: those *are*
 *    the ordering point, nothing is queued behind them, and writing to
 *    ourselves there would either recurse or (in `_flush`) throw
 *    `ERR_STREAM_WRITE_AFTER_END`. `push()` switches on a `forwarding` flag
 *    that is set for exactly the duration of those two hooks.
 *
 *    Backpressure survives this, in both directions. Our own bytes count
 *    towards `writableLength` like React's, so a large delta makes React's
 *    next `write()` return `false` on its own account rather than silently
 *    inflating the readable buffer; and `_transform` still forwards React's
 *    chunks with `callback(null, chunk)` rather than `push`, which is what
 *    lets Node park the callback and stop asking for more.
 *
 * 2. THE FINAL DELTA. The last boundary to resolve produces rules after the
 *    last `flush()` React will ever make, so `_flush` takes one more delta
 *    before ending. Without it the newest boundary on the page is the one
 *    that renders unstyled.
 *
 * 3. BYTES, NOT STRINGS. Incoming chunks are `Uint8Array`s carrying UTF-8.
 *    Decoding one to a string and re-encoding it splits any multi-byte
 *    sequence that straddles the encoder's view boundary into replacement
 *    characters. Nothing here ever converts a chunk: `_transform` passes the
 *    original object straight through, and injected HTML is encoded as its
 *    own separate buffer. Concatenating whole UTF-8 buffers is always safe;
 *    slicing or transcoding them is not.
 *
 * 4. NO REQUEST SCOPE. `takeDeltaHTML()` returns `''` outside a scope rather
 *    than throwing, so a transform used without `runInRequestScope` degrades
 *    to shell-plus-passthrough instead of failing. That is the right runtime
 *    behavior and the wrong thing to do quietly, so a stream that never once
 *    saw a scope warns in development when it ends.
 *
 * 5. WHEN THE PRELUDE GOES OUT. `start()` runs from React's `flush()` as well
 *    as from the first `_transform`, and must run from both.
 *
 *    `_transform` alone is not enough. React 19.1 made Fizz's preamble
 *    Suspense-aware: `preparePreamble` walks the completed root segment
 *    looking for `<html>`/`<head>`/`<body>`, and if it reaches a still-pending
 *    Suspense boundary without first passing through a host element it leaves
 *    `request.completedPreambleSegments` null, whereupon `flushCompletedQueues`
 *    returns before writing anything. React is waiting to find out whether the
 *    document element is going to come out of that boundary. So for a tree
 *    whose root is a `<Suspense>` — or a Fragment or array with one as a
 *    direct child — React writes *no bytes at all* until the boundary
 *    resolves. Keying the prelude off the first byte would then withhold the
 *    doctype, `<head>` and the whole shell stylesheet until then: the response
 *    stops streaming, and every rule the boundary compiled is folded into the
 *    shell instead of arriving as a delta. React 18.3.1 and 19.0.0 do not do
 *    this; 19.1 and later do.
 *
 *    `flush()` alone is not enough either: it is only called if React exposes
 *    a flush to us at all, and `_flush` still has to cover a stream that ends
 *    without one. `start()` is idempotent, so all three call it.
 *
 *    Ordering is unaffected on every version. Inside that `finally`,
 *    `completeWriting()` — which calls `destination.write()` — runs *before*
 *    `flushBuffered()`, so any pass that produces bytes has already been
 *    through `_transform` and emitted the prelude by the time our `flush()`
 *    runs. `start()` there is a no-op. It only does work on a pass that wrote
 *    nothing, which is exactly the case being rescued.
 *
 *    `takeShellHTML()` is valid at that point because the documented usage
 *    calls `pipe()` from `onShellReady`, so the shell render has finished
 *    compiling before React can flush to us at all. A caller who pipes earlier
 *    than that degrades gracefully rather than breaking: the shell is
 *    serialised early and whatever the shell render compiles afterwards
 *    arrives in the first delta, which inserts into its group anchor's own
 *    sheet like any other. The cost is that those rules then need JS to
 *    apply at all, where a shell rule would not have.
 *
 * 6. NO DELTA BEFORE THE SHELL, WHEN REACT WRITES `<head>`. With a `prelude`
 *    the shell is ours and `start()` has already emitted it, so `started` is
 *    also "the anchors are on the wire". Without one, the app is rendering
 *    `<head>` through React and the anchors arrive whenever React gets to
 *    them — which, once `<head>` itself streams, is neither necessarily
 *    before React's first byte nor necessarily before the first flush.
 *
 *    Both supported majors open that window, for opposite reasons. React
 *    >= 19.1 withholds the whole response until it knows whether `<html>`
 *    comes out of a pending boundary (trap 5), and still calls our `flush()`
 *    on every one of those empty passes: a delta drained there is a
 *    `<script>` ahead of the doctype, which is enough on its own for quirks
 *    mode. React 18 does the reverse — it flushes `<head>` immediately with a
 *    `<!--$?-->` placeholder where the boundary will go — so bytes exist but
 *    the anchors do not, and a delta drained there takes the whole sheet,
 *    sends it with nowhere to put it, and then the shell sends all of it
 *    again a few KB later.
 *
 *    `StyleSheet.hasEmittedShell()` is one half of the answer: true only
 *    once some spelling of the shell has actually been serialised for this
 *    request, which is what rules out the second case above — before the
 *    shell the watermark has never been reset, so the delta *is* the whole
 *    sheet. The stream's own end is exempt, so a caller who never emits a
 *    shell at all still gets their rules — queued for RNW's runtime to
 *    apply — rather than nothing at all.
 *
 *    It is only half, though, because it reports that the anchors
 *    *rendered*, not that their bytes were written, and under Fizz those are
 *    separate phases. `flushCompletedQueues` writes its queues one at a time
 *    and returns the moment `destination.write()` says stop, but that
 *    `return` is inside a `try` whose `finally` calls `flushBuffered()` —
 *    i.e. us — anyway. So a pass that renders the anchors into a boundary
 *    queued *behind* a boundary that tripped backpressure reaches our
 *    `flush()` with `hasEmittedShell()` already true and not one byte of the
 *    anchors on the wire. The rules in that delta then find no anchor,
 *    queue as pending, and need JS to apply.
 *
 *    So the second half is measured instead of asked: `_transform` scans the
 *    bytes it forwards for the anchors' own marker, and the gate means
 *    literally "an anchor's bytes have been through this transform".
 *
 *    WHAT IT REPLACED, AND WHY THE CHEAPER OPTIONS DO NOT WORK. The gate
 *    used to be `hasEmittedShell()` plus "at least one chunk has been
 *    through `_transform`". That closes only the passes where React wrote
 *    nothing at all (every pre-`<html>` pass on React >= 19.1); it is
 *    satisfied for the rest of the response by a chunk written long before
 *    the anchors rendered. Deferring the check to the *next* `_transform`
 *    is no better: it proves React wrote something, not that it wrote the
 *    anchors. And `StyleSheet` cannot be asked, because the only moment it
 *    knows about is the render — the byte stream is the only place the
 *    write is observable, and this transform sees every byte of it.
 *
 *    WHY THIS MARKER. `data-rnw-group="` is the attribute a streamed
 *    chunk's own `querySelector` uses to find the anchor it writes into
 *    (see `deltaScript` in `exports/StyleSheet/index.js`). It is therefore
 *    already load-bearing on the client and cannot be renamed without
 *    breaking the delta channel itself, which makes it a far safer gate
 *    than a marker invented for this purpose — and it needs no change to
 *    what `<StyleSheet.Anchors>` emits. It is matched as bytes, not text:
 *    the marker is ASCII and UTF-8 is self-synchronising (every byte of a
 *    multi-byte sequence has its high bit set), so an ASCII byte search can
 *    never match inside one and nothing here has to decode a chunk — trap 3
 *    still holds.
 *
 *    A marker can straddle two chunks: Fizz encodes into a fixed-size view
 *    (trap 1) and writes it whenever it fills, so the split falls wherever
 *    the byte count lands, mid-attribute included. The scan therefore
 *    carries the last `marker.length - 1` bytes of each chunk over to the
 *    next, copied rather than retained as a view, since React hands us a
 *    slice of a buffer it is free to reuse.
 *
 *    WHAT THE SCAN COSTS. It stops for good at the first hit, and it is
 *    skipped entirely when there is a `prelude` (the shell is ours, and
 *    `started` already answers the question). Neither of those bounds the
 *    supported arrangement described under ONE NARROWING below, where the
 *    marker never arrives at all: there the scan runs on every chunk for the
 *    whole response. An earlier version of this comment claimed the cost was
 *    "bounded by the distance to the first anchor rather than paid per chunk
 *    forever", which was false for exactly the caller the same comment
 *    declares supported. So the per-chunk cost has to be one that can be
 *    paid forever, and it is:
 *
 *      - one `Buffer#indexOf` over bytes React already handed us. No copy.
 *      - one join window of at most `2 * (marker.length - 1)` = 30 bytes,
 *        which is all a marker that began in the previous chunk can reach
 *        into this one, so `Buffer.concat([carry, chunk.subarray(0, 15)])`
 *        finds it and `Buffer.concat([carry, chunk])` is not needed.
 *      - one <= 15-byte copy for the next carry.
 *
 *    The whole-chunk concat is what this used to do, and it allocated and
 *    copied every byte of the response. Measured through the real transform,
 *    20 000 x 4KB writes (80MB), median of five runs each: with the concat,
 *    22.6ms when no anchor ever arrives against 2.0ms for the same stream
 *    with an anchor in chunk 0; with the join window, 14.6ms against 2.3ms.
 *    The scan tax drops from ~20.6ms to ~12.3ms per 80MB, and 80MB of
 *    allocation churn becomes ~0.9MB of 15- and 30-byte buffers. What is
 *    left is the `indexOf` itself, which no arrangement of this gate avoids.
 *
 *    GIVING UP AFTER N CHUNKS WAS CONSIDERED AND REJECTED. A bail-out would
 *    make the cost strictly O(N) and its failure mode is the benign one —
 *    the gate stays shut, deltas are withheld to `_flush`, every rule still
 *    arrives before the epilogue — so it is safe in the sense that matters.
 *    It is still wrong: any N is a guess about how far into a response
 *    React's `<head>` can be, and a page that puts the anchors past N stops
 *    streaming its CSS for good, silently, on a configuration that works
 *    today. What it buys back is 12.3ms / 20 000 = 0.6 microseconds per 4KB
 *    chunk, or 0.15ms on a 1MB response. That is not worth a correctness
 *    cliff.
 *
 *    THE SCAN RUNS AT `_transform`, not at `write()`, so under sustained
 *    backpressure the flag can lag the writable queue: chunks React handed
 *    over after the readable side filled are parked and unscanned until the
 *    next drain. That only ever errs towards withholding, never towards
 *    emitting early — those anchor bytes are already ahead of any delta in
 *    the FIFO (trap 1b), so all that is lost is one pass of latency, and the
 *    next flush after the drain carries the delta. `_flush` backstops it in
 *    the case where no further flush ever comes.
 *
 *    FALSE POSITIVES are bounded on both sides. The delta `<script>` itself
 *    contains that literal, inside its `querySelector` — but a delta cannot
 *    be emitted until the gate is already open, so it can never be the
 *    thing that opens it. Page content that happens to contain the literal
 *    would open the gate early, which costs exactly the old behaviour: a
 *    delta whose rules queue as pending. `hasEmittedShell()` is still
 *    required alongside it, so no amount of matching text can drain a delta
 *    before a shell exists.
 *
 *    ONE NARROWING, DELIBERATE. A caller who omits `prelude` *and* writes
 *    the shell somewhere this transform never sees it — `res.write()` ahead
 *    of `injector.pipe(res)`, say — has no anchor bytes in this stream, so
 *    every delta is now withheld until `_flush` instead of streaming. The
 *    rules all still arrive, in order, before the epilogue; what is lost is
 *    that they arrive early. Writing that head through the transform
 *    (`injector.write(head)` before `pipe(injector)`) or using `prelude`
 *    restores it, and both are better arrangements anyway, since they put
 *    the shell in the same FIFO as everything else. In-tree there is no
 *    such caller.
 *
 *    A SECOND NARROWING, DOCUMENTED RATHER THAN FIXED: the scan reads UTF-8.
 *    `injector.write(head, 'utf16le')` puts `d\0a\0t\0a\0…` on the wire, the
 *    ASCII marker never matches, and every delta is withheld to `_flush` —
 *    measured, and the same benign degradation as the narrowing above.
 *
 *    It is not fixed because it cannot be fixed *here* and should not be
 *    fixed anywhere. By the time `_transform` runs, the encoding is gone:
 *    Node's `writeOrBuffer` has already decoded the string, and the
 *    `encoding` argument `_transform` receives is `'buffer'` for a
 *    `utf16le` write exactly as it is for a `utf8` one (measured on Node
 *    24.18.0, all five write shapes). Recovering it would mean wrapping
 *    `write()` itself — a JS frame on the hottest path in the file, on every
 *    one of React's chunks — to detect an encoding React cannot produce:
 *    Fizz's Node writer encodes with a single module-level `TextEncoder`,
 *    which is UTF-8 only and has no options, and hands `destination.write()`
 *    a `Uint8Array`. Checked in 18.3.1, 19.0.0, 19.1.1, 19.2.0 and 19.3.0.
 *    So the cost would be paid by every real caller for a case only a
 *    hand-written non-UTF-8 `write()` can reach, whose worst outcome is
 *    late CSS. Write the head as UTF-8, or use `prelude`.
 *
 * 7. BYTES THAT ARRIVE AFTER THE WRITABLE SIDE HAS CLOSED. Outside
 *    `forwarding`, `push()` goes in through `write()`, which throws
 *    `ERR_STREAM_WRITE_AFTER_END` once `end()` has been called. The only
 *    caller that can be there is React's `flush()`, and React never calls it
 *    after `end()`: in `flushCompletedQueues`'s `finally`,
 *    `flushBuffered(destination)` precedes `destination.end()` in 18.3.1,
 *    19.0.0, 19.1.1, 19.2.0 and 19.3.0 — read in all five builds. So this is
 *    for a non-React caller, or a future React that reorders.
 *
 *    There are two such cases and they are not the same, which an earlier
 *    version of this file got wrong by answering both with "append to `tail`
 *    and let `_flush` emit it":
 *
 *    a. THE WRITABLE QUEUE WAS STILL PARKED at `end()` — i.e. backpressure.
 *       `end()` returns immediately with `writableEnded === true`, but
 *       `_flush` cannot run until the queue has drained through
 *       `_transform`, so it is still to come and `tail` is read at the top
 *       of it. The bytes go out, in order, ahead of the final delta.
 *       Measured: 200 x 4KB writes into a `highWaterMark: 1` sink whose
 *       write callbacks are parked, then `end()`, then `flush()` — observed
 *       order `end() returned` (`writableEnded=true`,
 *       `writableLength=757760`), `flush() returned`, then `_flush`. The
 *       delta that `flush()` produced is in the response, and removing
 *       `tail += html` removes it from the response.
 *
 *    b. THE QUEUE WAS EMPTY. Then `end()` runs `_flush` synchronously,
 *       before it returns, and a `flush()` after that has missed the last
 *       train. Measured in the same harness with a free-running sink:
 *       observed order `_flush`, then `end() returned`. Nothing can rescue
 *       those bytes — the stream is over and the readable side has been
 *       ended. What this can do is stop pretending: `push()` warns in
 *       development instead of assigning to a variable nothing will read
 *       again, because a fallback that looks like a safety net and is not
 *       one is worse than no fallback at all.
 *
 *    A destroyed stream is exempt from both. The response was aborted, so
 *    bytes going missing is the point rather than a defect worth a warning.
 */
export default function createStyleInjectionTransform(
  options?: StyleInjectionOptions = Object.freeze({})
): Transform {
  const emitOptions = { nonce: options.nonce };
  const prelude = options.prelude;
  const epilogue = options.epilogue;

  // Set the instant before React's first byte is forwarded. Guards both the
  // prelude (emit once) and the deltas (never before the shell).
  let started = false;
  // Whether any part of this stream was observed inside a request scope, for
  // the development warning in `_flush`. See trap 4.
  let sawRequestScope = false;
  // True for exactly the duration of `_transform` and `_flush` — the two
  // places where this transform is itself the ordering point and the tail of
  // the readable side is "here". See trap 1b.
  let forwarding = false;
  // Whether a shell anchor's bytes have been through `_transform` yet — the
  // measured half of the no-delta-before-the-shell gate. Subsumes the
  // "has anything at all been forwarded" flag it replaced, since a chunk
  // carrying the marker is by definition a chunk. See trap 6.
  let sawAnchorBytes = false;
  // The tail of the previous chunk, kept so a marker split across two
  // `write()` calls is still found. Copied, never a view onto React's
  // buffer. Empty once `sawAnchorBytes` is set and the scan stops.
  let anchorCarry: Buffer = NO_CARRY;
  // HTML that had nowhere to go because `end()` had been called before
  // `push()` was reached, but `_flush` had not run yet — the writable queue
  // was still parked behind backpressure. `_flush` emits it first, so the
  // bytes keep their order instead of being dropped. See trap 7a, and 7b for
  // the case this deliberately does not cover.
  let tail = '';
  // Set once `_flush` has run: from then on nothing more can be emitted, and
  // `push()` says so rather than assigning to `tail` for nobody. See trap 7b.
  let flushed = false;
  // Per transform rather than per process, unlike the missing-scope warning
  // below it: a missing `runInRequestScope` is a wiring mistake that is
  // identical on every request, whereas this one names bytes lost from one
  // specific response.
  let hasWarnedBytesAfterEnd = false;
  // Also per transform: it names one response's wiring, and a server can
  // legitimately have one handler that pipes and another that does not.
  let hasWarnedNoDestination = false;
  // Everything this transform's output has been piped into. See trap 1.
  const downstream: Array<Object> = [];
  // Sticky: `downstream` empties again when a destination unpipes, and the
  // two states mean opposite things. See `reportWiringMistakes`.
  let everHadDestination = false;

  function push(html: string) {
    // `stream` and `originalWrite` are assigned below; nothing calls this
    // before then.
    if (html === '') return;
    const bytes = Buffer.from(html, 'utf8');
    if (forwarding) {
      // Inside `_transform`/`_flush`: nothing of React's is queued behind us,
      // so the readable side's tail is exactly here.
      stream.push(bytes);
      return;
    }
    // Outside it — React's `flush()` — the readable side is *not* the tail:
    // whatever React wrote during this pass may still be parked on the
    // writable side. Enter through the same door those bytes did, so we land
    // behind them. See trap 1b.
    if (!(stream: any).writableEnded && !(stream: any).destroyed) {
      // `originalWrite`, not `stream.write`: a caller (or a test) may have
      // wrapped `write` to count React's chunks, and this is not one of them.
      originalWrite.call(stream, bytes);
      return;
    }
    // The writable side is closed, so `write()` would throw
    // ERR_STREAM_WRITE_AFTER_END. Which of the three outcomes below applies
    // is decided by whether `_flush` has already run. See trap 7.
    if ((stream: any).destroyed) {
      // The response was aborted. Bytes going missing is what that means.
      return;
    }
    if (!flushed) {
      // Trap 7a: `end()` returned with the writable queue still parked, so
      // `_flush` is yet to come and will emit this ahead of the final delta.
      tail += html;
      return;
    }
    // Trap 7b: `_flush` ran inside `end()`. Nothing can carry these bytes
    // now, so say so instead of assigning them to a variable nothing reads.
    if (process.env.NODE_ENV !== 'production' && !hasWarnedBytesAfterEnd) {
      hasWarnedBytesAfterEnd = true;
      console.error(BYTES_AFTER_END);
    }
  }

  function start() {
    if (started) return;
    started = true;
    if (prelude == null) return;
    // `takeShellHTML` serialises the sheet and resets this request's delta
    // watermark in one synchronous step. Calling it here — as late as
    // possible, but still before any body markup — means the shell carries
    // everything the shell render compiled and the first delta carries only
    // what came after.
    push(prelude(StyleSheet.takeShellHTML(emitOptions)));
  }

  function noteRequestScope() {
    if (hasRequestScope()) sawRequestScope = true;
  }

  /**
   * The two wiring mistakes this transform can see from the inside, reported
   * at the end of React's first pass — the earliest moment at which either
   * answer is final, and still early enough to be next to the request that
   * caused it in a log.
   *
   * Both used to be invisible here. The missing scope was reported at
   * `_flush`, a whole response later, where it reads as a property of the
   * response rather than of the handler; the pipe order was reported nowhere
   * at all, and its symptom — a shell that arrives late, only under
   * compression — does not reproduce locally.
   *
   * Development only, and each at most once. Neither is recoverable from
   * here: by the time we know, the bytes have been queued the way the caller
   * asked for.
   */
  function reportWiringMistakes() {
    if (!sawRequestScope && !hasWarnedMissingRequestScope) {
      hasWarnedMissingRequestScope = true;
      console.error(MISSING_REQUEST_SCOPE);
    }
    // `pipe()` registers a `data` listener on us, so no destinations AND no
    // reader means nothing is consuming the readable side — which on React's
    // first pass is the reversed-`pipe` mistake. A caller who drives the
    // readable side by hand (`on('data')`, async iteration, `pipeline`) has
    // one or the other, so this does not fire for them.
    //
    // `everHadDestination` is what separates "never wired up" from "wired up
    // and then torn down". A client that disconnects mid-response destroys
    // the response, which emits `unpipe` and empties `downstream` — and the
    // render keeps going for one more pass before React's abort lands. Without
    // this guard every disconnect in development reports the reversed-pipe
    // mistake at a caller whose pipe order is correct, which is both wrong and
    // the fastest way to teach someone to ignore the one case it exists for.
    if (
      !hasWarnedNoDestination &&
      !everHadDestination &&
      downstream.length === 0 &&
      stream.listenerCount('data') === 0 &&
      stream.listenerCount('readable') === 0 &&
      !(stream: any).destroyed
    ) {
      hasWarnedNoDestination = true;
      console.error(NO_DESTINATION);
    }
  }

  // Look for an anchor in the bytes about to be forwarded. Runs only while
  // the answer can still change and only when the gate uses it. See trap 6
  // for what it costs and why it never concatenates the chunk.
  //
  // Always a `Buffer`, never a string or a bare `Uint8Array`: this Transform
  // is constructed without `decodeStrings: false`, and Node's `writeOrBuffer`
  // converts every other shape before `_write` runs — a string through
  // `Buffer.from(chunk, encoding)`, a `Uint8Array` through
  // `_uint8ArrayToBuffer`, both arriving with `encoding === 'buffer'`.
  // Measured on Node 24.18.0 for `write(string)`, `write(string, 'utf16le')`,
  // `write(string, 'base64')`, `write(Buffer)` and `write(Uint8Array)`: all
  // five reach `_transform` as a `Buffer`. The normalising branches that used
  // to be here were therefore unreachable, and the string one carried a
  // comment about `decodeStrings: false` that this function's own caller
  // makes impossible.
  function scanForAnchorBytes(bytes: Buffer): void {
    // A marker that began in the previous chunk can reach at most
    // `ANCHOR_CARRY_MAX` bytes into this one, so joining the carry to that
    // many bytes is enough to find it. Bounded at `2 * ANCHOR_CARRY_MAX`
    // regardless of how big the chunk is — see trap 6 on what concatenating
    // the whole chunk here used to cost.
    if (
      anchorCarry.length !== 0 &&
      Buffer.concat([anchorCarry, bytes.subarray(0, ANCHOR_CARRY_MAX)]).indexOf(
        ANCHOR_MARKER
      ) !== -1
    ) {
      sawAnchorBytes = true;
      anchorCarry = NO_CARRY;
      return;
    }
    // Anything that starts inside this chunk. No copy: `indexOf` reads the
    // bytes React already handed over.
    if (bytes.indexOf(ANCHOR_MARKER) !== -1) {
      sawAnchorBytes = true;
      anchorCarry = NO_CARRY;
      return;
    }
    // Keep the last `ANCHOR_CARRY_MAX` bytes of `carry ++ chunk`, copied
    // rather than retained as a view: the source is a slice of a view React
    // allocated for this pass and is free to hand back again. Both branches
    // copy — `Buffer.from(buffer)` and `Buffer.concat` each do — and neither
    // touches more than `2 * ANCHOR_CARRY_MAX` bytes, whatever the chunk's
    // size. The short-chunk branch is the only one that can see a carry it
    // still needs: a chunk of `ANCHOR_CARRY_MAX` bytes or more already
    // contains every byte worth keeping.
    if (bytes.length >= ANCHOR_CARRY_MAX) {
      anchorCarry = Buffer.from(
        bytes.subarray(bytes.length - ANCHOR_CARRY_MAX)
      );
      return;
    }
    const joined = Buffer.concat([anchorCarry, bytes]);
    anchorCarry =
      joined.length <= ANCHOR_CARRY_MAX
        ? joined
        : Buffer.from(joined.subarray(joined.length - ANCHOR_CARRY_MAX));
  }

  function emitDelta(isFinal?: boolean) {
    // Never before the shell has been emitted: a pass that writes no bytes
    // still triggers React's flush, and draining a delta then would put
    // style elements ahead of the doctype and steal rules the shell owns.
    if (!started) return;
    // And, when React is the one writing `<head>`, never before the shell
    // has actually gone out: the anchors have to have been rendered *and*
    // their bytes have to have been forwarded through this transform. See
    // trap 6. The stream's own end is exempt: whatever is left there has to
    // go somewhere, and nothing is coming after it to carry the rules
    // instead.
    if (
      prelude == null &&
      isFinal !== true &&
      !(sawAnchorBytes && StyleSheet.hasEmittedShell())
    ) {
      return;
    }
    noteRequestScope();
    push(StyleSheet.takeDeltaHTML(emitOptions));
  }

  const stream = new Transform({
    // No `encoding` and no `objectMode`: chunks stay as the byte buffers
    // React produced. See trap 3.
    transform(chunk, encoding, callback) {
      forwarding = true;
      try {
        noteRequestScope();
        // Emits the prelude ahead of this chunk, straight onto the readable
        // side: we are the ordering point here. See trap 1b.
        start();
      } finally {
        forwarding = false;
      }
      // Only while the answer can still change, and only when the gate
      // consults it: with a `prelude` the shell is ours and `started`
      // already says it went out. See trap 6.
      //
      // `instanceof Buffer` is always true here — Node converts every write
      // shape before `_write` runs, measured — but Flow's `_transform`
      // libdef says `Buffer | string`, because the same signature also
      // describes a stream built with `decodeStrings: false`. Refining is
      // better than casting the type away: if that contract ever changed,
      // the scan stops instead of throwing on `chunk.subarray`, and a scan
      // that stops is the benign failure (deltas withheld to `_flush`).
      if (prelude == null && !sawAnchorBytes && chunk instanceof Buffer) {
        scanForAnchorBytes(chunk);
      }
      // Forward via the callback rather than `push`, so Transform keeps
      // applying backpressure to React on our behalf.
      callback(null, chunk);
    },
    flush(callback) {
      // Stream end. React has stopped writing, so this is the last chance to
      // emit anything the final boundary compiled. See trap 2. Everything
      // React (and `push()`) queued on the writable side has already been
      // through `_transform` by now, so this is again the ordering point.
      forwarding = true;
      try {
        if (tail !== '') {
          const pending = tail;
          tail = '';
          push(pending);
        }
        start();
        emitDelta(true);
        if (epilogue != null) push(epilogue);
      } finally {
        forwarding = false;
      }
      if (
        process.env.NODE_ENV !== 'production' &&
        !sawRequestScope &&
        !hasWarnedMissingRequestScope
      ) {
        hasWarnedMissingRequestScope = true;
        console.error(MISSING_REQUEST_SCOPE);
      }
      // Last, so that anything reaching `push()` from here on knows there is
      // no longer a `_flush` to carry it. See trap 7b.
      flushed = true;
      callback();
    }
  });

  // Captured before anything can wrap it. `push()` uses it to queue injected
  // bytes behind React's on the writable side. See trap 1b.
  const originalWrite = stream.write;

  // React's end-of-pass boundary signal. See trap 1.
  (stream: any).flush = function flush() {
    // Before the delta, never after: on a React >= 19.1 tree whose root is a
    // Suspense boundary this is the only chance to emit the shell before the
    // boundary resolves, and a delta drained ahead of the shell would steal
    // rules the shell owns and land its <style> elements above the doctype.
    // See trap 5. On a pass that wrote bytes `start()` has already run from
    // `_transform` and this is a no-op; the delta it then drains is empty,
    // because `takeShellHTML()` resets the watermark synchronously.
    //
    // Both of these go in through the writable side rather than `push()`ing
    // onto the readable one, so they land behind whatever React wrote during
    // this pass instead of in the middle of it. See trap 1b.
    //
    // The scope note is taken here as well as in `_transform`, because a
    // pass that writes no bytes — a React >= 19.1 tree whose root is a
    // Suspense boundary — reaches this function without ever reaching that
    // one, and reporting a missing scope for it would be a false alarm.
    noteRequestScope();
    start();
    emitDelta();
    if (process.env.NODE_ENV !== 'production') {
      reportWiringMistakes();
    }
    for (let i = 0; i < downstream.length; i++) {
      const dest = downstream[i];
      if (typeof dest.flush !== 'function') continue;
      try {
        dest.flush();
      } catch (error) {
        // We are inside React's `flushCompletedQueues` `finally`. A throw
        // here unwinds into Fizz and takes the render down at an arbitrary
        // point mid-response — over a downstream's failure to do something
        // that is, by contract, best-effort ("put what you have on the wire
        // now"). Our own bytes are already queued, so the response is
        // complete either way; report it and keep going, including to the
        // destinations after this one.
        if (process.env.NODE_ENV !== 'production') {
          console.error(DOWNSTREAM_FLUSH_FAILED, error);
        }
      }
    }
  };

  // Remember where our output goes, so `flush()` can forward React's signal
  // to a compression stream sitting between us and the socket.
  const originalPipe = stream.pipe;
  (stream: any).pipe = function pipe(
    destination: Object,
    pipeOptions?: Object
  ) {
    // One listener per destination we are actually tracking, and it takes
    // itself off when it fires. Adding one per `pipe()` call leaks: a
    // pipe/unpipe/re-pipe cycle — or a caller that simply pipes twice —
    // accumulates listeners that nothing ever removes, and Node starts
    // printing MaxListenersExceededWarning at eleven.
    if (downstream.indexOf(destination) === -1) {
      downstream.push(destination);
      everHadDestination = true;
      const onUnpipe = function onUnpipe(source) {
        if (source !== stream) return;
        destination.removeListener('unpipe', onUnpipe);
        const index = downstream.indexOf(destination);
        if (index !== -1) downstream.splice(index, 1);
      };
      destination.on('unpipe', onUnpipe);
    }
    return originalPipe.call(this, destination, pipeOptions);
  };

  return stream;
}
