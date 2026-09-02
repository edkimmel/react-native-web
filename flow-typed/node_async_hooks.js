/**
 * Flow 0.148 does not know the `node:` prefixed form of Node's core
 * modules. Only the surface `asyncContext` uses is declared here.
 *
 * @flow
 */

declare module 'node:async_hooks' {
  declare export class AsyncLocalStorage<T> {
    disable(): void;
    enterWith(store: T): void;
    exit<R>(callback: (...args: Array<any>) => R, ...args: Array<any>): R;
    getStore(): T | void;
    run<R>(store: T, callback: (...args: Array<any>) => R, ...args: Array<any>): R;
  }
}
