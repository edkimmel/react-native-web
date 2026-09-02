/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * Per-request scoping for module-level state inside react-native-web — the
 * browser/native implementation.
 *
 * There is no `AsyncLocalStorage` here, so every key resolves to a
 * process-wide singleton, matching the historical behavior of RNW's
 * module-level `let` bindings. Substituted for `./index.js` by the `browser`
 * field map in `package.json`.
 *
 * Non-Node server runtimes (workerd, Deno, Bun, some edge runtimes) whose
 * bundler resolves this file can restore isolation with
 * `configureRequestScope({ AsyncLocalStorage })`. Until they do,
 * `runInRequestScope` throws in development rather than quietly sharing
 * state across requests.
 */

import type { AsyncContext } from './createAsyncContext';
import createAsyncContext from './createAsyncContext';

const context: AsyncContext = createAsyncContext(null);

export const configureRequestScope = context.configureRequestScope;
export const getProcessState = context.getProcessState;
export const getScopedState = context.getScopedState;
export const hasRequestScope = context.hasRequestScope;
export const runInRequestScope = context.runInRequestScope;
