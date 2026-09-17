/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Streaming a response out of a worker thread.
 *
 * WHY THIS EXISTS. `renderToStreamingResponse` wants a Node writable stream,
 * and an `http.ServerResponse` is the one thing you cannot hand a worker: its
 * socket is a handle, so it is neither structured-cloneable nor transferable.
 * The render has to happen in the worker and the bytes have to be written on
 * the main thread, which means a stream that spans the two.
 *
 * Writing that bridge by hand is deceptively easy to get wrong, in two ways
 * that are both silent:
 *
 *  1. THE FLUSH CAN OVERTAKE THE DATA. This package's transform consumes
 *     React's per-pass `destination.flush()` and forwards it to any
 *     destination that has one — that signal is what makes a compression
 *     stream release the shell instead of sitting on it until the next
 *     boundary resolves. Post it as its own message and it races the chunk
 *     messages: `Readable.pipe` usually emits `'data'` synchronously, but
 *     when the readable side has buffered it defers, and then the flush is
 *     posted first and flushes an empty buffer. The shell is delayed by a
 *     whole boundary, exactly as if the flush had been dropped. So flush is
 *     not a message here. It is a *flag on the next batch*, and batches are
 *     assembled in `setImmediate` — after every synchronous and `nextTick`
 *     write of the pass has landed. A flush can therefore never precede the
 *     bytes it belongs to, and coalescing later bytes into the same batch is
 *     strictly better than splitting them out.
 *
 *  2. `postMessage` HAS NO BACKPRESSURE. A CPU-bound render feeding a slow
 *     socket will queue the entire document in the main thread's heap, and
 *     nothing anywhere returns `false`. So each batch is stop-and-wait: the
 *     worker holds the stream's write callbacks until the main thread has
 *     written the batch *and* drained. Holding the callback is what makes
 *     Node apply real backpressure back through the pipe into the transform
 *     and into Fizz, which is the only place that can actually slow down.
 *
 * It also carries `statusCode`/`setHeader` across, so the response object the
 * worker sees behaves like the `ServerResponse` the adapter expects — which
 * is what makes the adapter's own default `onShellError` (a 500 with headers)
 * work unchanged from inside a worker. And an aborted request on the main
 * thread destroys the worker-side stream, so the adapter's built-in
 * disconnect handling fires and stops rendering for a client that has gone.
 *
 * Usage. The bridge needs a `MessagePort` at each end. The clean way is one
 * `MessageChannel` per response, with its far end transferred to the worker
 * in the task message — then the response traffic never touches the port your
 * own protocol runs on, and there is nothing to demultiplex:
 *
 *     // main thread
 *     app.get('/*', (req, res) => {
 *       const { port1, port2 } = new MessageChannel();
 *       pipeWorkerResponse({ port: port1, response: res });
 *       worker.postMessage({ responsePort: port2, url: req.url }, [port2]);
 *     });
 *
 *     // worker
 *     parentPort.on('message', ({ responsePort, url }) => {
 *       renderToStreamingResponse({
 *         element: appFor(url),
 *         response: createWorkerResponse({ port: responsePort })
 *       });
 *     });
 *
 * One port can carry many responses instead, which trades a `MessageChannel`
 * per request for two obligations. Give every response in flight a distinct
 * `id` — `pipeWorkerResponse` reports a collision rather than letting two
 * documents interleave — and have your own `'message'` handler skip the
 * bridge's traffic, because its acks and aborts arrive at the same handler
 * your tasks do:
 *
 *     parentPort.on('message', (message) => {
 *       if (isWorkerResponseMessage(message)) return;
 *       const { id, url } = message;
 *       renderToStreamingResponse({
 *         element: appFor(url),
 *         response: createWorkerResponse({ id, port: parentPort })
 *       });
 *     });
 *
 * `port` is anything with `postMessage`, `on` and `off`: a `MessagePort`, a
 * `Worker`, or `parentPort`.
 */

import { Writable } from 'node:stream';

export type WorkerResponseOptions = {
  // Only needed when one port carries more than one response at a time, in
  // which case it must be unique among those in flight. Defaults to 0.
  id?: string | number,
  // A MessagePort, a Worker, or `parentPort`.
  port: Object,
  ...
};

export type PipeWorkerResponseOptions = {
  // The same id the worker was given for this response. Defaults to 0.
  id?: string | number,
  // Called if the bridge cannot write to `response`. Defaults to destroying
  // the response, which is what an unhandled stream error would do anyway.
  onError?: ?(error: mixed) => void,
  // A MessagePort or Worker — the other end of the worker's `port`.
  port: Object,
  // The `http.ServerResponse` (or any writable) the bytes are written to.
  response: Object,
  ...
};

export type PipeWorkerResponseHandle = {|
  // Stops listening and stops writing. Does not end the response.
  dispose: () => void
|};

// Every message this bridge puts on the wire carries this key, and nothing
// else it sends does. It exists so that a worker sharing one port between its
// own task protocol and a response can tell the two apart — see
// `isWorkerResponseMessage`.
const MARKER = '__rnwWorkerResponse';

const DUPLICATE_ID =
  'react-native-web: pipeWorkerResponse() was given an `id` that is already ' +
  'in flight on this port. One port carries many responses at once and the ' +
  'id is the only thing separating them, so two responses sharing one ' +
  'interleave their bytes into both documents. Either give each response a ' +
  'distinct id, or give each one its own MessageChannel. The later ' +
  'registration takes over the id, so the earlier response stops receiving ' +
  'its own bytes. Duplicate id:';

const PORT_CLOSED =
  'react-native-web: the worker end of a response went away mid-stream — ' +
  'the worker was terminated, crashed, or closed its port before the ' +
  'document was finished. The response is incomplete, so it is destroyed ' +
  'rather than ended: ending it would deliver a truncated document to the ' +
  'client as though it were whole. Pass `onError` to pipeWorkerResponse() ' +
  'to handle this yourself.';

const MISSING_PORT =
  'react-native-web: createWorkerResponse() and pipeWorkerResponse() ' +
  'require a `port` — a MessagePort, a Worker, or `parentPort` from ' +
  'node:worker_threads.';

const HEADERS_ALREADY_SENT =
  'react-native-web: createWorkerResponse() ignored a setHeader() call made ' +
  'after the first chunk was posted to the main thread. Headers cross once, ' +
  'with the first batch, for the same reason http.ServerResponse sends them ' +
  'with the first write: by now they are already on the wire.';

function requirePort(options: Object, fn: string): void {
  if (options == null || options.port == null) {
    throw new TypeError(MISSING_PORT + ` (${fn})`);
  }
}

/**
 * One `'message'` listener per port, not one per response.
 *
 * The obvious thing is for each response to attach its own listener and
 * filter by id. That works, and it makes a server doing eleven concurrent
 * renders through one shared port print
 * `MaxListenersExceededWarning: Possible EventTarget memory leak detected` —
 * a false alarm, because the listeners are all live and all get removed, but
 * indistinguishable from the real thing and arriving exactly when a server is
 * under enough load to worry about. So each port gets one listener that
 * routes by id to a `Map` of handlers, and the listener count stays at one
 * however many responses are in flight.
 *
 * The registry doubles as the duplicate-id check: an id already in the map is
 * a collision, reported at the call that creates it rather than as
 * interleaved bytes in two documents.
 *
 * Keyed per side, because the two ends of a channel are different objects but
 * a caller is free to point both halves at one port in a test, and the ids
 * would then collide across sides for no reason.
 */
type Registry = {|
  closers: Set<() => void>,
  handlers: Map<mixed, (message: Object) => void>,
  onGone: () => void,
  onMessage: (message: Object) => void
|};

const registries: Array<WeakMap<Object, Registry>> = [
  new WeakMap(),
  new WeakMap()
];

const WORKER_SIDE = 0;
const MAIN_SIDE = 1;

function off(port: Object, event: string, listener: Function): void {
  if (typeof port.off === 'function') port.off(event, listener);
  else if (typeof port.removeListener === 'function') {
    port.removeListener(event, listener);
  }
}

/**
 * Register one response's handlers on a port. Returns the unsubscribe.
 *
 * `onGone` fires when the far end disappears. A `MessagePort` reports that as
 * `'close'`; a `Worker` — which the docs accept as a port, and which is the
 * natural thing to pass when the worker owns one response at a time — has no
 * `'close'` event at all and reports it as `'exit'`. Listening for only the
 * first left worker-death detection silently inert on that path.
 */
function subscribe(
  side: number,
  port: Object,
  id: mixed,
  onMessage: (message: Object) => void,
  onGone: () => void
): () => void {
  const byPort = registries[side];
  let registry = byPort.get(port);
  if (registry == null) {
    const created: Registry = {
      closers: new Set(),
      handlers: new Map(),
      onGone() {
        // Copied, because a closer unsubscribes while we iterate.
        Array.from(created.closers).forEach((closer) => closer());
      },
      onMessage(message: Object) {
        if (!isWorkerResponseMessage(message)) return;
        const handler = created.handlers.get(message.i);
        if (handler != null) handler(message);
      }
    };
    registry = created;
    byPort.set(port, registry);
    port.on('message', registry.onMessage);
    port.on('close', registry.onGone);
    port.on('exit', registry.onGone);
  }

  if (
    side === MAIN_SIDE &&
    process.env.NODE_ENV !== 'production' &&
    registry.handlers.has(id)
  ) {
    console.error(DUPLICATE_ID, id);
  }
  registry.handlers.set(id, onMessage);
  registry.closers.add(onGone);

  const owner = registry;
  return function unsubscribe() {
    if (owner.handlers.get(id) === onMessage) owner.handlers.delete(id);
    owner.closers.delete(onGone);
    if (owner.handlers.size === 0 && owner.closers.size === 0) {
      off(port, 'message', owner.onMessage);
      off(port, 'close', owner.onGone);
      off(port, 'exit', owner.onGone);
      if (byPort.get(port) === owner) byPort.delete(port);
    }
  };
}

/**
 * True for the messages this bridge sends, on either direction of the port.
 *
 * A worker that shares one port between its own task protocol and its
 * responses needs this: the bridge's acks and aborts arrive at the same
 * `'message'` handler your tasks do, and a handler that assumes every message
 * is a task will try to render one. A dedicated `MessageChannel` per response
 * avoids the question entirely and is the pattern the docs lead with.
 */
export function isWorkerResponseMessage(message: mixed): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message: $FlowFixMe)[MARKER] === true
  );
}

function toBuffer(chunk: mixed, encoding: mixed): Buffer {
  if (Buffer.isBuffer(chunk)) return (chunk: $FlowFixMe);
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Buffer.from(String(chunk), (encoding: $FlowFixMe));
}

/**
 * Worker side. Returns a writable stream to pass as `response`.
 */
export function createWorkerResponse(options: WorkerResponseOptions): Object {
  requirePort(options, 'createWorkerResponse');
  const port = options.port;
  const id = options.id != null ? options.id : 0;

  const headers: Map<string, [string, mixed]> = new Map();
  let pending: Array<Buffer> = [];
  let pendingBytes = 0;
  let held: Array<() => void> = [];
  let scheduled = false;
  let awaitingAck = false;
  let flushRequested = false;
  let endRequested = false;
  let headSent = false;
  let aborted = false;

  const stream: Object = new Writable({
    write(chunk: mixed, encoding: mixed, callback: () => void) {
      const buffer = toBuffer(chunk, encoding);
      pending.push(buffer);
      pendingBytes += buffer.length;
      held.push(callback);
      schedule();
    },
    final(callback: () => void) {
      endRequested = true;
      held.push(callback);
      schedule();
    }
  });

  // A bare `Writable` has none of these, and the adapter reads all three off
  // whatever it is given. Mirroring them is what lets the same render code
  // run in-process and in a worker without a branch.
  stream.statusCode = 200;
  stream.setHeader = function setHeader(name: string, value: mixed) {
    if (headSent) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(HEADERS_ALREADY_SENT);
      }
      return stream;
    }
    headers.set(String(name).toLowerCase(), [String(name), value]);
    return stream;
  };
  stream.getHeader = function getHeader(name: string): mixed {
    const entry = headers.get(String(name).toLowerCase());
    return entry != null ? entry[1] : undefined;
  };
  stream.removeHeader = function removeHeader(name: string) {
    headers.delete(String(name).toLowerCase());
  };

  // React's end-of-pass signal, forwarded by the style transform. See (1) in
  // the module comment: it sets a flag on the next batch rather than posting,
  // so it can never be delivered ahead of the bytes of its own pass.
  stream.flush = function flush() {
    flushRequested = true;
    schedule();
  };

  function schedule() {
    if (scheduled || aborted) return;
    scheduled = true;
    setImmediate(drain);
  }

  function drain() {
    scheduled = false;
    if (aborted) return;
    // Stop-and-wait: nothing else crosses until the main thread reports that
    // the last batch reached the socket. See (2) in the module comment.
    if (awaitingAck) return;
    const hasBytes = pending.length > 0;
    if (!hasBytes && !flushRequested && !endRequested && headSent) return;

    const message: Object = { [MARKER]: true, i: id, t: 'w' };
    if (!headSent) {
      headSent = true;
      message.s = stream.statusCode;
      message.h = Array.from(headers.values());
    }
    if (hasBytes) {
      message.d =
        pending.length === 1
          ? pending[0]
          : Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
    }
    if (flushRequested) {
      message.f = true;
      flushRequested = false;
    }
    if (endRequested) {
      message.e = true;
    }

    awaitingAck = true;
    port.postMessage(message);
  }

  function release() {
    const callbacks = held;
    held = [];
    for (let i = 0; i < callbacks.length; i++) callbacks[i]();
  }

  function onMessage(message: Object) {
    if (message.t === 'a') {
      awaitingAck = false;
      release();
      schedule();
      return;
    }
    if (message.t === 'x') {
      // The client went away. Destroying leaves `writableEnded` false, so the
      // adapter's own `'close'` handler aborts the render rather than letting
      // React carry on producing bytes for nobody.
      aborted = true;
      detach();
      release();
      stream.destroy();
    }
  }

  // The other end went away — the main thread crashed, or closed the port
  // without sending an abort. Same handling as an abort: destroying leaves
  // `writableEnded` false, so the adapter stops rendering for a response
  // nobody can receive.
  function onGone() {
    if (aborted || stream.writableEnded) return;
    aborted = true;
    detach();
    release();
    stream.destroy();
  }

  let unsubscribe = null;
  function detach() {
    if (unsubscribe == null) return;
    const done = unsubscribe;
    unsubscribe = null;
    done();
  }

  unsubscribe = subscribe(WORKER_SIDE, port, id, onMessage, onGone);
  stream.on('finish', detach);
  stream.on('close', detach);

  return stream;
}

/**
 * Main-thread side. Writes the worker's batches into `response`.
 */
export function pipeWorkerResponse(
  options: PipeWorkerResponseOptions
): PipeWorkerResponseHandle {
  requirePort(options, 'pipeWorkerResponse');
  const { onError, port, response } = options;
  const id = options.id != null ? options.id : 0;

  let finished = false;
  let detached = false;

  function ack() {
    if (detached) return;
    port.postMessage({ [MARKER]: true, i: id, t: 'a' });
  }

  function fail(error: mixed) {
    if (onError != null) onError(error);
    else if (typeof response.destroy === 'function') response.destroy();
    detach();
  }

  function onMessage(message: Object) {
    if (message.t !== 'w' || finished || detached) return;

    try {
      if (message.h != null) {
        if (message.s != null) response.statusCode = message.s;
        if (typeof response.setHeader === 'function') {
          for (let i = 0; i < message.h.length; i++) {
            response.setHeader(message.h[i][0], message.h[i][1]);
          }
        }
      }

      let drained = true;
      if (message.d != null) {
        drained = response.write(toBuffer(message.d, 'utf8'));
      }
      // Forwarded last, so a compression stream between here and the socket
      // releases everything this batch just added rather than the batch
      // before it.
      if (message.f === true && typeof response.flush === 'function') {
        response.flush();
      }
      if (message.e === true) {
        finished = true;
        response.end();
        // Acked before detaching: the worker is holding its `final()`
        // callback on this batch, and without the ack that stream never
        // emits `'finish'` — so it never takes its own listener off the
        // port, and a long-lived worker leaks one per request.
        ack();
        detach();
        return;
      }

      if (drained) ack();
      else response.once('drain', ack);
    } catch (error) {
      fail(error);
    }
  }

  // Without this the response hangs until the client times out: no more
  // batches arrive, nothing ends the stream, and the socket stays open.
  function onGone() {
    if (finished || detached) return;
    const error = new Error(PORT_CLOSED);
    if (onError == null && process.env.NODE_ENV !== 'production') {
      console.error(PORT_CLOSED);
    }
    fail(error);
  }

  function onClose() {
    if (finished || detached) return;
    // Tell the worker to stop rendering before detaching, or the message has
    // nowhere to go.
    port.postMessage({ [MARKER]: true, i: id, t: 'x' });
    detach();
  }

  let unsubscribe = null;
  function detach() {
    if (detached) return;
    detached = true;
    if (unsubscribe != null) {
      const done = unsubscribe;
      unsubscribe = null;
      done();
    }
    if (typeof response.removeListener === 'function') {
      response.removeListener('close', onClose);
      response.removeListener('drain', ack);
    }
  }

  unsubscribe = subscribe(MAIN_SIDE, port, id, onMessage, onGone);
  if (typeof response.on === 'function') response.on('close', onClose);

  return { dispose: detach };
}
