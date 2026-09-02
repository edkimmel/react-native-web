/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import canUseDOM from '../canUseDom';

type RequestStore = { states: Map<string, mixed> };

type AsyncLocalStorageInstance = {
  getStore(): ?RequestStore,
  run<T>(store: RequestStore, fn: () => T): T,
  ...
};

export type AsyncContext = {|
  configureRequestScope: (options: {
    AsyncLocalStorage: Class<any>,
    ...
  }) => void,
  getProcessState: <T>(key: string, createDefault: () => T) => T,
  getScopedState: <T>(key: string, createDefault: () => T) => T,
  hasRequestScope: () => boolean,
  runInRequestScope: <T>(fn: () => T) => T
|};

const MISSING_ASYNC_LOCAL_STORAGE =
  'react-native-web: runInRequestScope() was called on the server, but no ' +
  'AsyncLocalStorage implementation is available. Without one, every ' +
  'concurrent request shares the same state, which is exactly the ' +
  'cross-request leak this API exists to prevent. Call ' +
  'configureRequestScope({ AsyncLocalStorage }) once at startup — e.g. ' +
  "import { AsyncLocalStorage } from 'node:async_hooks' — before rendering.";

/**
 * Build the per-request scoping API around an optional `AsyncLocalStorage`
 * implementation.
 *
 * `./index.js` (Node) passes `node:async_hooks`'s implementation; the
 * browser build (`./index.browser.js`) passes `null`, so every key resolves
 * to a process-wide singleton — matching the historical behavior of RNW's
 * module-level `let` bindings. Non-Node server runtimes that resolve the
 * browser build can supply their own via `configureRequestScope`.
 */
export default function createAsyncContext(
  InitialAsyncLocalStorage: ?Class<any>
): AsyncContext {
  let als: ?AsyncLocalStorageInstance =
    InitialAsyncLocalStorage != null ? new InitialAsyncLocalStorage() : null;

  const defaultStates: Map<string, mixed> = new Map();
  let hasWarnedMissingAsyncLocalStorage = false;

  /**
   * Supply an `AsyncLocalStorage` implementation for runtimes where one is
   * not statically importable from `node:async_hooks` (workerd, Deno, Bun,
   * some edge runtimes). Call once at startup, before any render — an
   * already-open scope is not carried over to the new store.
   */
  function configureRequestScope(options: {
    AsyncLocalStorage: Class<any>,
    ...
  }): void {
    const Ctor = options != null ? options.AsyncLocalStorage : null;
    if (typeof Ctor !== 'function') {
      throw new Error(
        'react-native-web: configureRequestScope() requires an ' +
          '{ AsyncLocalStorage } constructor.'
      );
    }
    als = new Ctor();
  }

  /**
   * Run `fn` inside a fresh per-request scope. State read via
   * `getScopedState` during `fn` is isolated from concurrent scopes;
   * the scope ends when `fn`'s promise settles or it returns.
   *
   * No-op on the client: state remains the process singleton. On the
   * server without an `AsyncLocalStorage` this throws in development and
   * logs once in production, rather than silently sharing state.
   */
  function runInRequestScope<T>(fn: () => T): T {
    if (als == null) {
      if (!canUseDOM) {
        if (process.env.NODE_ENV !== 'production') {
          throw new Error(MISSING_ASYNC_LOCAL_STORAGE);
        } else if (!hasWarnedMissingAsyncLocalStorage) {
          hasWarnedMissingAsyncLocalStorage = true;
          console.error(MISSING_ASYNC_LOCAL_STORAGE);
        }
      }
      return fn();
    }
    return als.run({ states: new Map() }, fn);
  }

  /**
   * The process-wide default state for `key`, ignoring any active scope,
   * creating it with `createDefault()` on first access.
   */
  function getProcessState<T>(key: string, createDefault: () => T): T {
    let value = defaultStates.get(key);
    if (value === undefined) {
      value = createDefault();
      defaultStates.set(key, value);
    }
    // $FlowFixMe[incompatible-return] T is enforced by the key/factory contract
    return value;
  }

  /**
   * Return the per-request state object for `key`, creating it with
   * `createDefault()` on first access in this scope. Outside any scope,
   * returns the process-default singleton (also lazily created).
   *
   * The returned reference is stable across reads within the same
   * scope — callers can mutate its properties and changes will be
   * observed by subsequent reads in the same scope.
   */
  function getScopedState<T>(key: string, createDefault: () => T): T {
    const store = als ? als.getStore() : null;
    if (store == null) {
      return getProcessState(key, createDefault);
    }
    let value = store.states.get(key);
    if (value === undefined) {
      value = createDefault();
      store.states.set(key, value);
    }
    // $FlowFixMe[incompatible-return] T is enforced by the key/factory contract
    return value;
  }

  /** True iff currently inside a request scope. */
  function hasRequestScope(): boolean {
    return als != null && als.getStore() != null;
  }

  return {
    configureRequestScope,
    getProcessState,
    getScopedState,
    hasRequestScope,
    runInRequestScope
  };
}
