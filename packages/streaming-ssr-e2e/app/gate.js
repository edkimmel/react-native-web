/**
 * The thing that makes a Suspense boundary resolve *late*.
 *
 * Server: a per-request delay, held in RNW's own request-scoped state so
 * that two concurrent requests can use different delays. React.lazy cannot
 * do this job — its loader runs once per process, so after the first
 * request the module is already resolved and the boundary never suspends
 * again.
 *
 * Client: an optional manual gate. With `?gate=1` the `body` boundary
 * refuses to hydrate until the spec calls `window.__RELEASE_DETAILS__()`,
 * which is how the hydration spec gets a boundary that hydrates long after
 * the root did.
 *
 * Gates are NAMED. The streaming-head route has a boundary inside (or
 * above) `<head>` as well as the one in `<body>`, and they have to resolve
 * independently: a single shared promise would let the head boundary
 * satisfy the body one, and the body would stop arriving as a separate
 * chunk — which is the entire point of the cascade and FOUC assertions.
 * Only the `body` gate is ever gated on the client; a head boundary that
 * refused to hydrate would just be a hydration deadlock with nothing to
 * learn from it.
 */

// `getScopedState` moved to the server entry point with the rest of the
// per-request plumbing; only `runInRequestScope` and `configureRequestScope`
// stayed on the top-level barrel. This module is imported by the browser
// bundle too, where the server entry resolves to the browser builds of
// asyncContext/styleInjection through the `browser` field map — the client
// half below never calls into it.
import { getScopedState } from '@edkimmel/react-native-web/server';

const SCOPE_KEY = 'e2e.request';

function createRequestState() {
  return { gates: {} };
}

function serverGate(name) {
  const state = getScopedState(SCOPE_KEY, createRequestState);
  let gate = state.gates[name];
  if (gate == null) {
    gate = { delay: 0, promise: null, resolved: false };
    state.gates[name] = gate;
  }
  return gate;
}

/** Server only. Called from inside `runInRequestScope`. */
export function setRequestDelay(delay, name = 'body') {
  serverGate(name).delay = delay;
}

const clientGate = { done: false, promise: null };

/**
 * Suspends the calling component. Throwing a promise is the low-level
 * Suspense contract; React retries the boundary when it settles.
 */
export function boundaryGate(name = 'body') {
  if (typeof document !== 'undefined') {
    const config = window.__E2E__ || {};
    if (name !== 'body' || !config.gate || clientGate.done) return;
    if (clientGate.promise == null) {
      clientGate.promise = new Promise((resolve) => {
        window.__RELEASE_DETAILS__ = () => {
          clientGate.done = true;
          resolve();
        };
      });
    }
    throw clientGate.promise;
  }

  const state = serverGate(name);
  if (state.resolved) return;
  if (state.promise == null) {
    state.promise = new Promise((resolve) => {
      setTimeout(() => {
        state.resolved = true;
        resolve();
      }, state.delay);
    });
  }
  throw state.promise;
}
