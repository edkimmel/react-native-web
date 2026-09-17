/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The worker-thread response bridge.
 *
 * These run both halves over a real `MessageChannel` in one process rather
 * than spawning a `Worker`. The bridge's contract is entirely the message
 * protocol and the stream semantics on either end of it — a second thread
 * adds scheduling noise and no coverage, and a `MessagePort` pair delivers
 * with the same ordering guarantees and the same structured clone.
 */

const { EventEmitter } = require('node:events');
const { MessageChannel } = require('node:worker_threads');
const { PassThrough, Writable } = require('node:stream');

const required = require('..');
const { createWorkerResponse, isWorkerResponseMessage, pipeWorkerResponse } =
  required.default || required;

// `configs/jest.config.node.js` enables fake timers globally, which fakes
// `setImmediate` — the tick the bridge batches on. Nothing here can run
// without real ones.
beforeEach(() => {
  jest.useRealTimers();
});

function tick(n = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) {
    p = p.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return p;
}

function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString('utf8');
}

describe('createWorkerResponse / pipeWorkerResponse', () => {
  test('bytes, status and headers cross in order', async () => {
    const channel = new MessageChannel();
    const response = new PassThrough();
    const read = collect(response);
    response.statusCode = 0;
    const headers = [];
    response.setHeader = (name, value) => headers.push([name, value]);

    pipeWorkerResponse({ id: 1, port: channel.port1, response });
    const bridge = createWorkerResponse({ id: 1, port: channel.port2 });

    bridge.statusCode = 201;
    bridge.setHeader('Content-Type', 'text/html; charset=utf-8');
    bridge.write('<!doctype html>');
    bridge.write('<p>a</p>');
    bridge.write('<p>b</p>');
    bridge.end();

    await tick(8);

    expect(response.statusCode).toBe(201);
    expect(headers).toEqual([['Content-Type', 'text/html; charset=utf-8']]);
    expect(read()).toBe('<!doctype html><p>a</p><p>b</p>');
    channel.port1.close();
    channel.port2.close();
  });

  test('a flush never arrives ahead of the bytes of its own pass', async () => {
    const channel = new MessageChannel();

    // Records the interleaving the main thread actually sees. A hand-rolled
    // bridge that posts the flush as its own message fails here whenever the
    // readable side has buffered.
    const log = [];
    const response = new Writable({
      write(chunk, encoding, callback) {
        log.push(`w:${chunk.toString('utf8')}`);
        callback();
      }
    });
    response.flush = () => log.push('flush');

    pipeWorkerResponse({
      id: 'r',
      port: channel.port1,
      response,
      onError() {}
    });
    const bridge = createWorkerResponse({ id: 'r', port: channel.port2 });

    bridge.write('shell');
    bridge.flush();
    await tick(6);
    bridge.write('late');
    bridge.flush();
    await tick(6);

    expect(log).toEqual(['w:shell', 'flush', 'w:late', 'flush']);
    channel.port1.close();
    channel.port2.close();
  });

  test('a flush with no bytes of its own still crosses', async () => {
    const channel = new MessageChannel();
    const log = [];
    const response = new Writable({
      write(chunk, encoding, callback) {
        log.push('w');
        callback();
      }
    });
    response.flush = () => log.push('flush');

    pipeWorkerResponse({ id: 1, port: channel.port1, response, onError() {} });
    const bridge = createWorkerResponse({ id: 1, port: channel.port2 });

    bridge.flush();
    await tick(6);

    expect(log).toEqual(['flush']);
    channel.port1.close();
    channel.port2.close();
  });

  test('a stalled response stops the worker writing', async () => {
    const channel = new MessageChannel();

    // Never calls back until released, so `write()` returns false from the
    // second call on and the bridge has to wait.
    let release = null;
    const response = new Writable({
      highWaterMark: 1,
      write(chunk, encoding, callback) {
        release = callback;
      }
    });

    pipeWorkerResponse({ id: 1, port: channel.port1, response, onError() {} });
    const bridge = createWorkerResponse({ id: 1, port: channel.port2 });

    const written = [];
    for (let i = 0; i < 5; i++) {
      bridge.write(`chunk-${i}`, () => written.push(i));
    }
    await tick(8);

    // The first batch is in flight; nothing after it has been released, so
    // the pipe above the bridge is backpressured rather than buffering.
    expect(written).toEqual([]);
    expect(bridge.writableLength).toBeGreaterThan(0);

    release();
    await tick(8);
    expect(written.length).toBeGreaterThan(0);

    channel.port1.close();
    channel.port2.close();
  });

  test('a client disconnect destroys the worker-side stream', async () => {
    const channel = new MessageChannel();
    const response = new PassThrough();

    pipeWorkerResponse({ id: 1, port: channel.port1, response });
    const bridge = createWorkerResponse({ id: 1, port: channel.port2 });

    // This is the event the adapter listens for: `'close'` with
    // `writableEnded` still false is how it decides to abort the render.
    const closed = new Promise((resolve) => {
      bridge.on('close', () => resolve(bridge.writableEnded));
    });

    bridge.write('partial');
    await tick(4);
    response.destroy();

    await expect(closed).resolves.not.toBe(true);
    channel.port1.close();
    channel.port2.close();
  });

  test('a normal end leaves writableEnded true, so nothing aborts', async () => {
    const channel = new MessageChannel();
    const response = new PassThrough();
    const read = collect(response);

    pipeWorkerResponse({ id: 1, port: channel.port1, response });
    const bridge = createWorkerResponse({ id: 1, port: channel.port2 });

    const finished = new Promise((resolve) => bridge.on('finish', resolve));
    bridge.end('done');
    await finished;

    expect(bridge.writableEnded).toBe(true);
    await tick(4);
    expect(read()).toBe('done');
    channel.port1.close();
    channel.port2.close();
  });

  test('two responses on one port do not interleave', async () => {
    const channel = new MessageChannel();
    const a = new PassThrough();
    const b = new PassThrough();
    const readA = collect(a);
    const readB = collect(b);

    pipeWorkerResponse({ id: 'a', port: channel.port1, response: a });
    pipeWorkerResponse({ id: 'b', port: channel.port1, response: b });
    const bridgeA = createWorkerResponse({ id: 'a', port: channel.port2 });
    const bridgeB = createWorkerResponse({ id: 'b', port: channel.port2 });

    bridgeA.write('AAA');
    bridgeB.write('BBB');
    bridgeA.write('aaa');
    bridgeB.write('bbb');
    bridgeA.end();
    bridgeB.end();
    await tick(10);

    expect(readA()).toBe('AAAaaa');
    expect(readB()).toBe('BBBbbb');
    channel.port1.close();
    channel.port2.close();
  });

  test('a worker that dies mid-stream fails the response instead of hanging', async () => {
    const channel = new MessageChannel();
    const response = new PassThrough();
    response.resume();
    const errors = [];

    pipeWorkerResponse({
      port: channel.port1,
      response,
      onError: (error) => errors.push(error)
    });
    const bridge = createWorkerResponse({ port: channel.port2 });

    bridge.write('<!doctype html>');
    await tick(6);

    // What a terminated worker looks like from the main thread: no further
    // batches, and no `end`. Before this was handled the response simply
    // stayed open until the client gave up.
    channel.port2.close();
    await tick(6);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('went away mid-stream');
    expect(response.writableEnded).toBe(false);
    channel.port1.close();
  });

  test('a worker whose main thread went away stops rendering', async () => {
    const channel = new MessageChannel();
    const bridge = createWorkerResponse({ port: channel.port2 });

    const closed = new Promise((resolve) => {
      bridge.on('close', () => resolve(bridge.writableEnded));
    });

    bridge.write('partial');
    await tick(4);
    channel.port1.close();

    // `writableEnded` still false is the signal the adapter's own `'close'`
    // handler reads to abort the render.
    await expect(closed).resolves.not.toBe(true);
    channel.port2.close();
  });

  test('the ordinary path is not mistaken for a dead worker', async () => {
    const channel = new MessageChannel();
    const response = new PassThrough();
    response.resume();
    const errors = [];

    pipeWorkerResponse({
      port: channel.port1,
      response,
      onError: (error) => errors.push(error)
    });
    const bridge = createWorkerResponse({ port: channel.port2 });

    bridge.end('done');
    await tick(10);
    // Closing after a completed response is how the dedicated-channel
    // pattern cleans up; it must not report anything.
    channel.port2.close();
    channel.port1.close();
    await tick(6);

    expect(errors).toEqual([]);
    expect(response.writableEnded).toBe(true);
  });

  test('both halves refuse a missing port', () => {
    expect(() => createWorkerResponse({ id: 1 })).toThrow(/require a `port`/);
    expect(() =>
      pipeWorkerResponse({ id: 1, response: new PassThrough() })
    ).toThrow(/require a `port`/);
  });

  test('a dedicated channel needs no id at all', async () => {
    const channel = new MessageChannel();
    const response = new PassThrough();
    const read = collect(response);

    pipeWorkerResponse({ port: channel.port1, response });
    const bridge = createWorkerResponse({ port: channel.port2 });

    bridge.end('one response, one channel');
    await tick(8);

    expect(read()).toBe('one response, one channel');
    channel.port1.close();
    channel.port2.close();
  });

  test('a duplicate id on one port is reported, and the id frees when released', () => {
    const channel = new MessageChannel();
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const first = pipeWorkerResponse({
      id: 'dup',
      onError() {},
      port: channel.port1,
      response: new PassThrough()
    });
    expect(error).not.toHaveBeenCalled();

    const second = pipeWorkerResponse({
      id: 'dup',
      onError() {},
      port: channel.port1,
      response: new PassThrough()
    });
    expect(error.mock.calls[0][0]).toContain('already in flight');

    // Releasing the *earlier* response does not free the id: the later
    // registration took it over and is still live, so a third really is a
    // third collision.
    error.mockClear();
    first.dispose();
    const third = pipeWorkerResponse({
      id: 'dup',
      onError() {},
      port: channel.port1,
      response: new PassThrough()
    });
    expect(error.mock.calls[0][0]).toContain('already in flight');

    // Once nothing holds it, the id is reusable — a long-lived port does not
    // accumulate false collisions.
    error.mockClear();
    second.dispose();
    third.dispose();
    pipeWorkerResponse({
      id: 'dup',
      onError() {},
      port: channel.port1,
      response: new PassThrough()
    }).dispose();
    expect(error).not.toHaveBeenCalled();

    error.mockRestore();
    channel.port1.close();
    channel.port2.close();
  });

  test('one port carries many responses on a single listener', async () => {
    const channel = new MessageChannel();
    const CONCURRENT = 15;
    const responses = [];
    const bridges = [];
    const finished = [];

    for (let i = 0; i < CONCURRENT; i++) {
      const response = new PassThrough();
      response.resume();
      finished.push(new Promise((resolve) => response.on('finish', resolve)));
      responses.push(response);
      pipeWorkerResponse({ id: i, port: channel.port1, response });
      bridges.push(createWorkerResponse({ id: i, port: channel.port2 }));
    }

    // One listener per port, not one per response. Fifteen of them is past
    // Node's default limit of ten, which is where the per-response version
    // started printing MaxListenersExceededWarning at a server that was
    // doing nothing wrong.
    expect(channel.port1.listenerCount('message')).toBe(1);
    expect(channel.port2.listenerCount('message')).toBe(1);

    bridges.forEach((bridge, i) => bridge.end(`body-${i}`));
    await Promise.all(finished);
    await tick(10);

    // …and it is taken off once the last response lets go.
    expect(channel.port1.listenerCount('message')).toBe(0);
    expect(channel.port2.listenerCount('message')).toBe(0);

    channel.port1.close();
    channel.port2.close();
  });

  test('a Worker used as the port reports its death through exit', async () => {
    // The docs accept a `Worker` as the port, and a `Worker` has no `'close'`
    // event at all — it reports the same thing as `'exit'`. Listening for
    // only `'close'` left worker-death detection silently inert on exactly
    // the path the one-response-per-worker shape leads you to.
    const workerLike = new EventEmitter();
    workerLike.postMessage = () => {};

    const response = new PassThrough();
    response.resume();
    const errors = [];
    pipeWorkerResponse({
      port: workerLike,
      response,
      onError: (error) => errors.push(error)
    });

    workerLike.emit('exit', 1);
    await tick(4);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('went away mid-stream');
  });

  test("the bridge's own traffic is identifiable, so a shared port is usable", async () => {
    const channel = new MessageChannel();
    const response = new PassThrough();
    response.resume();

    // Exactly the handler a worker sharing one port has to write. Without the
    // guard it sees the bridge's acks and tries to render them.
    const tasks = [];
    channel.port2.on('message', (message) => {
      if (isWorkerResponseMessage(message)) return;
      tasks.push(message);
    });

    pipeWorkerResponse({ id: 7, port: channel.port1, response });
    const bridge = createWorkerResponse({ id: 7, port: channel.port2 });
    bridge.write('bytes');
    bridge.end();
    await tick(10);

    expect(tasks).toEqual([]);
    expect(isWorkerResponseMessage({ t: 'w' })).toBe(false);
    expect(isWorkerResponseMessage(null)).toBe(false);
    channel.port1.close();
    channel.port2.close();
  });

  test('aborted responses free their bookkeeping on a long-lived port', async () => {
    // The deployment shape for a shared port is a worker that lives for the
    // process. Ids, handlers and listeners all have to come back off it when
    // a client hangs up, not just when a response completes — the abort path
    // has more moving parts and is the one that runs under load.
    const channel = new MessageChannel();
    const ROUNDS = 200;
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    for (let i = 0; i < ROUNDS; i++) {
      const response = new PassThrough();
      response.resume();
      pipeWorkerResponse({
        id: `abort-${i}`,
        onError() {},
        port: channel.port1,
        response
      });
      const bridge = createWorkerResponse({
        id: `abort-${i}`,
        port: channel.port2
      });
      bridge.write(`partial-${i}`);
      // The client goes away mid-stream.
      response.destroy();
    }
    await tick(20);

    // One listener per port at most, and none once nothing is in flight.
    expect(channel.port1.listenerCount('message')).toBe(0);
    expect(channel.port2.listenerCount('message')).toBe(0);

    // Every id came back off the registry: reusing all of them reports no
    // collision. An id map that grew would report ROUNDS of them.
    error.mockClear();
    const handles = [];
    for (let i = 0; i < ROUNDS; i++) {
      const response = new PassThrough();
      response.resume();
      handles.push(
        pipeWorkerResponse({
          id: `abort-${i}`,
          onError() {},
          port: channel.port1,
          response
        })
      );
    }
    expect(error).not.toHaveBeenCalled();

    handles.forEach((handle) => handle.dispose());
    error.mockRestore();
    channel.port1.close();
    channel.port2.close();
  });

  test('a listener is taken off the port once the response is done', async () => {
    const channel = new MessageChannel();
    const response = new PassThrough();
    response.resume();

    const before = channel.port2.listenerCount('message');
    pipeWorkerResponse({ id: 1, port: channel.port1, response });
    const bridge = createWorkerResponse({ id: 1, port: channel.port2 });
    expect(channel.port2.listenerCount('message')).toBe(before + 1);

    bridge.end('x');
    await tick(10);

    expect(channel.port2.listenerCount('message')).toBe(before);
    expect(channel.port1.listenerCount('message')).toBe(0);
    channel.port1.close();
    channel.port2.close();
  });
});
