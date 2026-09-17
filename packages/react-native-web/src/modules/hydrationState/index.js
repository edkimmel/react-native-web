/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The server half of the hydration snapshot: a registry of device state
 * sources, and a `<script>` tag that carries their values to the client.
 *
 * WHAT PROBLEM THIS SOLVES. Under streaming SSR, Suspense boundaries hydrate
 * progressively — a boundary's first client render happens when its chunk
 * lands, which can be long after the root became interactive. React
 * reconciles that render against markup produced at the start of the
 * response, so the boundary has to see the device state *the server* saw,
 * not whatever the module happens to hold by then. `store.js` pins that
 * value on the client; this file is how it gets there.
 *
 * DELIBERATELY NOT WIRED INTO `createStyleInjectionTransform`. The CSS shell
 * and this snapshot are parallel mechanisms, not one mechanism: CSS is
 * cumulative and arrives in pieces across the whole response, while this is
 * a single immutable payload that must be in the document before React's
 * first byte of app markup is hydrated. Coupling them would tie the
 * placement of one to the streaming lifecycle of the other for no benefit.
 * The app calls this and decides where it goes — typically in `<head>`, or
 * at the top of the `prelude` the style transform is given. It is inert
 * markup: put it anywhere that parses before hydration starts.
 *
 * Usage:
 *
 *     runInRequestScope(() => {
 *       Dimensions.set({ window: viewport, screen: viewport });
 *       Appearance.set({ colorScheme: user.theme });
 *
 *       const injector = createStyleInjectionTransform({
 *         nonce,
 *         prelude: (shellCSS) =>
 *           '<!doctype html><html><head>' +
 *           takeHydrationStateHTML({ nonce }) +
 *           shellCSS +
 *           '</head><body><div id="root">',
 *         epilogue: '</div></body></html>'
 *       });
 *       // ...renderToPipeableStream, pipe through `injector`
 *     });
 *
 * The client side needs no wiring at all: `Dimensions` and `Appearance`
 * read the global lazily on first use. An app that emits
 * nothing behaves exactly as it does today, because every reader falls back
 * to its live value.
 *
 * WHAT IS REGISTERED, AND WHAT IS NOT.
 *
 * The two device modules are registered below, in this module's own
 * scope, rather than each registering itself. Self-registration would make
 * correctness depend on those modules having been evaluated first, and
 * `package.json` sets `"sideEffects": false` — a bundler is entitled to
 * drop a module whose exports nobody uses, so "it registered itself when it
 * loaded" is not something that can be relied on. Registering here means the
 * built-ins are present exactly when the emitter is, which is the only
 * moment they matter. Consumers extend the set with
 * `registerHydrationState`.
 *
 * Everything else is excluded on purpose, so that no absence reads as an
 * oversight:
 *   - `PixelRatio` derives everything it reports from
 *     `Dimensions.get('window').scale` and `.fontScale`, so it rides on the
 *     `Dimensions` entry.
 *   - `AccessibilityInfo` holds nothing a render can read: its only
 *     consumer, `isReduceMotionEnabled()`, is asynchronous, so
 *     `prefers-reduced-motion` never reaches a render pass and cannot
 *     produce a hydration mismatch. A snapshot entry would buy nothing and
 *     would have to assert a value the server was never told.
 *   - `StyleSheet`'s per-request delta buffer has its own wire channel (the
 *     shell stylesheet plus a streamed delta per chunk) and is cumulative
 *     rather than a snapshot; a copy here would be a second, conflicting
 *     source of the same CSS.
 *   - `AppRegistry`'s style-format guard is a development-only warning flag
 *     that never leaves the server and means nothing to a client.
 */

import type { HydrationStore } from './store';
import Appearance from '../../exports/Appearance';
import Dimensions from '../../exports/Dimensions';

export type HydrationStateOptions = {
  // CSP nonce, applied to the emitted <script>.
  nonce?: ?string,
  ...
};

type HydrationSource = () => mixed;

const GLOBAL_KEY = '__RNW_HYDRATION__';

// Insertion-ordered, so the emitted JSON is stable across renders — which
// matters only for tests and diffs, but costs nothing.
const sources: Map<string, HydrationSource> = new Map();

/**
 * Register a source of per-request state to include in the hydration
 * snapshot.
 *
 * `key` is the name the value is filed under in
 * `window.__RNW_HYDRATION__`, and the same string the client side passes to
 * `getServerValue`. `read` is called during `takeHydrationStateHTML()`,
 * inside whatever request scope is open at that moment, and must return a
 * JSON-serialisable **object** (a plain record — scalars are rejected,
 * because a record can gain a field later without breaking the wire format
 * or the readers).
 *
 * WHEN TO CALL IT. Registration happens once, at server entry, from module
 * scope — next to `configureRequestScope` — and always before any render.
 * That is the contract: `takeHydrationStateHTML()` serialises the sources
 * that are registered when it runs, and it runs in the prelude, before the
 * shell. Registering from a module that loads later — one imported lazily
 * inside a Suspense boundary, say — is outside that contract and is not
 * supported: the boundary's markup goes out carrying per-request state that
 * never reached the snapshot, and the client hydrates it against the live
 * value instead. `getServerValue` reports that in development.
 *
 * Registering the same key twice keeps the first source and reports an
 * error in development. Silently letting one subsystem overwrite another's
 * snapshot surfaces later as an inexplicable hydration mismatch in code
 * that has nothing to do with either. It is not fatal, because a duplicate
 * can also come from one module being instantiated twice by a bundler,
 * which is survivable and not worth taking a server down for.
 */
export function registerHydrationState(
  key: string,
  read: HydrationSource
): void {
  if (typeof key !== 'string' || key === '') {
    throw new Error(
      'react-native-web: registerHydrationState() requires a non-empty ' +
        'string key.'
    );
  }
  if (typeof read !== 'function') {
    throw new Error(
      'react-native-web: registerHydrationState() requires a read() ' +
        'function.'
    );
  }
  if (sources.has(key)) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(
        'react-native-web: registerHydrationState() was called twice for ' +
          `the key "${key}". The first source is kept. Two subsystems ` +
          'sharing a key means one of them silently hydrates against the ' +
          "other's state, which surfaces as a hydration mismatch far from " +
          'the cause. Give each subsystem its own key.'
      );
    }
    return;
  }
  sources.set(key, read);
}

// Escape a value for an HTML double-quoted attribute. Deliberately a local
// copy of the helper in `StyleSheet/index.js` rather than an import: that
// module is the CSS pipeline, and this one must not depend on it.
function escapeForAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function nonceAttr(options: HydrationStateOptions): string {
  const nonce = options.nonce;
  return nonce != null && nonce !== ''
    ? ` nonce="${escapeForAttr(nonce)}"`
    : '';
}

function collect(): { [key: string]: mixed } {
  const state = {};
  sources.forEach((read, key) => {
    let value;
    try {
      value = read();
    } catch (error) {
      // One bad source must not cost the others their snapshot. Every key
      // is independently optional — a missing one degrades that subsystem
      // to the live client value, which is today's behaviour — whereas
      // aborting the emission would turn one consumer's bug into a
      // page-wide hydration mismatch for subsystems that were working,
      // in the middle of a response that is already on the wire.
      if (process.env.NODE_ENV !== 'production') {
        console.error(
          `react-native-web: the hydration state source for "${key}" threw; ` +
            'that key is omitted from this response and will fall back to ' +
            'the live client value.',
          error
        );
      }
      return;
    }
    if (value == null || typeof value !== 'object') {
      if (process.env.NODE_ENV !== 'production') {
        console.error(
          `react-native-web: the hydration state source for "${key}" ` +
            'returned a non-object; sources must return a JSON-serialisable ' +
            'record. That key is omitted from this response.'
        );
      }
      return;
    }
    state[key] = value;
  });
  return state;
}

/**
 * The `<script>` tag that carries this request's device state to the
 * client, ready to be inlined verbatim into the response.
 *
 * Reads every registered source through its public API, so inside
 * `runInRequestScope` it picks up that request's values automatically and
 * two concurrent renders each emit their own.
 *
 * The payload is written as an object literal rather than a JSON string:
 * there is nothing for the client to parse, and nothing to escape twice.
 * `<` is escaped to `<` throughout — a valid escape inside a JS string
 * literal, and the one rule that closes both ways out of a script element
 * (`</script` and `<!--`) at once.
 *
 * U+2028/U+2029 are escaped for the same reason they are in
 * `StyleSheet/index.js`: `JSON.stringify` leaves them raw because they are
 * legal inside a JSON string, but this payload is parsed as *JavaScript*,
 * and before ES2019 both characters were line terminators there — a raw one
 * ends the statement early and the rest of the object literal becomes a
 * syntax error that takes the whole inline script with it. Relying on every
 * client engine being new enough is a bet with no upside. Built-in sources
 * emit numbers and a two-value enum, but `registerHydrationState` exists
 * precisely to accept consumer state, which can be any string a user typed.
 */
export function takeHydrationStateHTML(
  options?: HydrationStateOptions = Object.freeze({})
): string {
  return `<script${nonceAttr(options)}>${takeHydrationStateScript()}</script>`;
}

/**
 * The same payload as `takeHydrationStateHTML()` with no `<script>` wrapper \u2014
 * for a document whose `<head>` is React's own markup.
 *
 * A React-rendered `<head>` cannot take the tag: every `<script>` in it has
 * to be an element React rendered, so what the app needs is the source text
 * to put in `dangerouslySetInnerHTML`, and the nonce goes on the JSX element
 * rather than into a string this module builds.
 *
 *     <script
 *       dangerouslySetInnerHTML={{ __html: takeHydrationStateScript() }}
 *       nonce={nonce}
 *     />
 *
 * It exists because the alternative is unwrapping the tag with a regex, which
 * is what this library's own e2e server was doing \u2014 a parser for a format
 * this file is the sole producer of, written at the call site, one attribute
 * away from silently returning the whole tag.
 *
 * Same escaping, same single-take semantics, same `collect()` \u2014 the two are
 * one emission with two spellings, not two payloads. Emitting both into one
 * document is harmless but pointless: the second assignment overwrites the
 * first with an identical object.
 */
export function takeHydrationStateScript(): string {
  const json = JSON.stringify(collect())
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `window.${GLOBAL_KEY}=${json}`;
}

// The built-ins. See "WHAT IS REGISTERED, AND WHAT IS NOT" above for why
// this lives here and not in each device module.
[
  Dimensions.unstable_hydrationStore,
  Appearance.unstable_hydrationStore
].forEach((store: HydrationStore<$FlowFixMe>) => {
  registerHydrationState(store.hydrationKey, store.read);
});
