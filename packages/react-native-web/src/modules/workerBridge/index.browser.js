/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The worker-thread response bridge — browser/native stand-in.
 *
 * Substituted for `./index.js` by the `browser` field map in `package.json`,
 * for the same reason `../styleInjection` and `../streamingResponse` split
 * that way: bundling for a browser or native target must not drag
 * `node:stream` into the output. Both halves of this bridge are Node server
 * code — one runs in a worker thread, the other on the main thread beside the
 * socket — and neither has a meaningful degradation here, so they throw at
 * the call rather than at some later byte.
 */

// Declared here rather than re-exported from `./index.js`, so that nothing in
// this file names the module the `browser` field exists to keep out.
export type WorkerResponseOptions = {
  id?: string | number,
  port: Object,
  ...
};

export type PipeWorkerResponseOptions = {
  id?: string | number,
  port: Object,
  response: Object,
  ...
};

export type PipeWorkerResponseHandle = {| dispose: () => void |};

const MESSAGE =
  'react-native-web: the worker-thread response bridge is a Node server API ' +
  'and is not available in this build. It spans a node:worker_threads ' +
  'MessagePort and writes into an http.ServerResponse, neither of which ' +
  'exists here.';

export function createWorkerResponse(options: WorkerResponseOptions): empty {
  throw new Error(MESSAGE);
}

export function pipeWorkerResponse(options: PipeWorkerResponseOptions): empty {
  throw new Error(MESSAGE);
}

// A pure predicate over a message object, with nothing Node-only in it. It
// answers the same way here as it does on a server, so it is implemented
// rather than thrown from: a shared helper that inspects worker messages
// should not have to care which build it ended up in.
export function isWorkerResponseMessage(message: mixed): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message: $FlowFixMe).__rnwWorkerResponse === true
  );
}
