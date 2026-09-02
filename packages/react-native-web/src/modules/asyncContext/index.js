/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Per-request scoping for module-level state inside react-native-web — the
 * Node implementation.
 *
 * Callers (typically an SSR pipeline) wrap each render in
 * `runInRequestScope` to give that request its own isolated state for every
 * key, preventing cross-request leaks during concurrent renders with
 * `renderToPipeableStream`.
 *
 * `node:async_hooks` is imported statically. Browser and native bundles get
 * `./index.browser.js` instead, via the `browser` field map in
 * `package.json`. That direction is deliberate: if a bundler does not honor
 * `browser`, the browser build fails loudly on an unresolvable
 * `node:async_hooks` rather than silently shipping a no-op that would cost
 * request isolation on the server.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AsyncContext } from './createAsyncContext';
import createAsyncContext from './createAsyncContext';

const context: AsyncContext = createAsyncContext(AsyncLocalStorage);

export const configureRequestScope = context.configureRequestScope;
export const getProcessState = context.getProcessState;
export const getScopedState = context.getScopedState;
export const hasRequestScope = context.hasRequestScope;
export const runInRequestScope = context.runInRequestScope;
