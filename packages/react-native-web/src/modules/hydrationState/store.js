/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/**
 * The frozen server snapshot: the device state as the server saw it, held
 * for the lifetime of the page.
 *
 * Why it has to be frozen, and why "the value the server used" is not the
 * same thing as "the value the module holds right now": under streaming SSR
 * each Suspense boundary hydrates on its own schedule. React renders a
 * boundary's first client pass whenever that boundary's chunk arrives, which
 * may be long after the root became interactive — and it reconciles that
 * pass against markup the server produced at the very start of the response.
 * So every boundary, no matter when it hydrates, has to be able to read the
 * *same* device state the first one did. A value that moves in between (a
 * resize, an `unstable_restoreFromHydration`, anything calling `update()`)
 * turns into a hydration mismatch in every boundary that had not hydrated
 * yet. This module is the one place that value is pinned.
 *
 * Deliberately dumb: it imports nothing from the rest of react-native-web.
 * The device modules (`Dimensions`, `Appearance`) read and write it, so any
 * dependency in the other direction would be a cycle.
 * It also has no module-level side effects — `package.json` declares
 * `"sideEffects": false`, so nothing here may depend on this file having
 * been evaluated at a particular time. Initialisation is lazy, on first
 * read.
 *
 * There are two ways a value gets in, and they must agree:
 *   - `window.__RNW_HYDRATION__`, written by `takeHydrationStateHTML()` on
 *     the server and parsed here on first read;
 *   - `setServerValue`, called by the `unstable_setForHydration` family for
 *     apps that plumb the values across themselves.
 */

/**
 * The contract a device module implements so a hook can subscribe to it and
 * the emitter can serialise it. Lives here, rather than next to the
 * emitter, because this is the only module both device modules already
 * depend on — importing the type from the emitter would be a cycle.
 *
 * `read` is the server half (what goes on the wire) and the other three are
 * the client half (the `useSyncExternalStore` triple). `hydrationKey` ties
 * them together, so the key exists in exactly one place per subsystem
 * instead of being spelled out again in the registry.
 */
export type HydrationStore<T> = {|
  +getServerSnapshot: () => T,
  +getSnapshot: () => T,
  +hydrationKey: string,
  +read: () => mixed,
  +subscribe: (callback: () => void) => () => void
|};

// The global the server emitter writes. Named, not exported: the emitter
// hardcodes the same string, because the two halves ship in different
// bundles (server / browser) and a shared constant would only create the
// illusion that they cannot drift.
const GLOBAL_KEY = '__RNW_HYDRATION__';

const values: Map<string, Object> = new Map();
let parsedGlobal = false;
// Whether the page actually carried a snapshot. Distinct from "the map is
// empty": an app using none of this must not be nagged, and an app that
// emitted a snapshot missing a key has a real problem. See the warning in
// `getServerValue`.
let hasGlobalPayload = false;
const warnedMissingKeys: Set<string> = new Set();

/**
 * Freeze `value` and everything reachable from it.
 *
 * `useSyncExternalStore` requires snapshot identity stability — React calls
 * `getServerSnapshot()` twice on mount and warns if the two results differ —
 * and a snapshot whose *contents* can be mutated is exactly the bug this
 * module exists to prevent, only harder to see. Freezing makes the invariant
 * enforced rather than documented.
 *
 * The `isFrozen` early-out is also what makes this terminate on a cyclic
 * object: the parent is frozen before its children are visited, so a child
 * pointing back at it stops there. The cost is that an object that was
 * already *shallow* frozen by its owner is left as-is; that is the right
 * trade, since the alternative is a stack overflow on input this module does
 * not control.
 */
function deepFreeze(value: mixed): mixed {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  Object.keys(value).forEach((key) => {
    deepFreeze((value: $FlowFixMe)[key]);
  });
  return value;
}

/**
 * Read `window.__RNW_HYDRATION__` once.
 *
 * Every failure mode here is survivable and none of them may throw: a page
 * that never emitted the script, a truncated response that emitted half of
 * it, a non-browser environment with no `window` at all, or another script
 * having claimed the same global. The client half falls back to the live
 * device value in all of those, which is precisely today's behaviour — so
 * the worst case of a bad global is that this fix is absent, not that the
 * page breaks.
 *
 * Both an object literal and a JSON string are accepted. The emitter writes
 * the former (there is nothing to parse, and nothing to double-escape), but
 * a framework that carries the payload through its own serialisation channel
 * will hand over the latter.
 */
function parseGlobal(): void {
  if (parsedGlobal) {
    return;
  }
  parsedGlobal = true;
  try {
    if (typeof window === 'undefined' || window == null) {
      return;
    }
    const raw = (window: $FlowFixMe)[GLOBAL_KEY];
    if (raw == null) {
      return;
    }
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed == null || typeof parsed !== 'object') {
      return;
    }
    hasGlobalPayload = true;
    Object.keys(parsed).forEach((key) => {
      const value = parsed[key];
      // Only object-shaped entries. That is the shape the emitter produces
      // and the shape `getServerValue` promises; a bare scalar on the wire
      // is a consumer bug, and dropping it degrades that one subsystem to
      // the live value rather than handing its reader a surprise type.
      if (value != null && typeof value === 'object') {
        // First writer wins, and the page's own script counts as the first
        // writer even if `setServerValue` ran before this parse. Both
        // describe the same render, so they should agree; when they do not,
        // the global is the one every boundary can see, including boundaries
        // that hydrated before the `unstable_setForHydration` call happened.
        //
        // Unreachable while the `parsedGlobal` latch above holds — this body
        // runs exactly once, and `setServerValue` parses before it writes,
        // so the map is always empty here. It is kept, and cannot be
        // mutation-tested, because it is the half of "first writer wins"
        // that belongs to this side: deleting it would make the two
        // orderings disagree the moment the latch is ever relaxed, which is
        // a change no test would fail on.
        if (!values.has(key)) {
          values.set(key, (deepFreeze(value): $FlowFixMe));
        }
      }
    });
  } catch (error) {
    // Malformed JSON, a getter that throws, a locked-down global — all of
    // them mean "no server snapshot", which callers already handle.
  }
}

/**
 * The frozen server value recorded for `key`, or `null` if there is none.
 *
 * Stable for the lifetime of the page: the same object identity on every
 * call, which is what lets a caller hand it straight to
 * `useSyncExternalStore`'s `getServerSnapshot`.
 */
export function getServerValue(key: string): ?Object {
  parseGlobal();
  const value = values.get(key);
  if (value === undefined) {
    warnMissingKey(key);
    return null;
  }
  return value;
}

/**
 * A key that is missing from a snapshot the page *did* emit.
 *
 * This is a broken contract on the server, not a shortcoming of the
 * client. `registerHydrationState` is the SSR harness's job: it is called
 * once, at server entry, from module scope, before any render — which is
 * what makes every source present when `takeHydrationStateHTML()`
 * serialises the snapshot in the prelude. A registration that happens
 * later, from a module imported lazily inside a Suspense boundary, is not
 * supported. The boundary still renders markup from its per-request state
 * and that markup still streams out and gets hydrated, but its value was
 * never in the snapshot, so the client reads the live value and
 * mismatches. Nothing here can recover it; the point of the warning is to
 * name the cause, which is otherwise invisible from either side.
 *
 * Two cases this must stay silent for, because a false positive here is
 * worse than no warning at all:
 *   - no global at all: the legitimate "not using the emitter" setup,
 *     whether that means `unstable_setForHydration` or nothing;
 *   - a key supplied through `setServerValue`, which is already in the map
 *     and so never reaches this function.
 *
 * The built-ins cannot trip this: `../hydrationState/index.js` imports the
 * device modules directly and registers them at its own module scope, so they are present before the emitter can possibly run. This is
 * about consumer-registered state only.
 */
function warnMissingKey(key: string): void {
  if (process.env.NODE_ENV === 'production') {
    return;
  }
  if (!hasGlobalPayload || warnedMissingKeys.has(key)) {
    return;
  }
  warnedMissingKeys.add(key);
  console.error(
    `react-native-web: "${key}" was not registered when ` +
      'takeHydrationStateHTML() ran, so this page emitted a hydration ' +
      'snapshot without it. registerHydrationState() must be called before ' +
      'rendering, from server-entry module scope; registering from a ' +
      'lazily imported module is not supported. This value falls back to ' +
      'the live client one and may not match the server-rendered markup.'
  );
}

/**
 * Record `value` as the server snapshot for `key`.
 *
 * First writer wins. A second write is dropped rather than applied, because
 * a snapshot that changes mid-page is the failure this module exists to
 * prevent: by the time a second value could arrive, boundaries have already
 * hydrated against the first one, and the ones still waiting must agree with
 * them.
 *
 * `value` is frozen in place rather than copied. That is deliberate — the
 * caller passes the same objects it is also installing as the live value, so
 * sharing the reference keeps `getSnapshot() === getServerSnapshot()` during
 * a forced hydration and saves React the reconciliation pass a copy would
 * force. Freezing the caller's object is safe for the in-tree callers, all
 * of which replace these objects wholesale rather than mutating them.
 */
export function setServerValue(key: string, value: Object): void {
  parseGlobal();
  if (value == null || typeof value !== 'object') {
    return;
  }
  if (values.has(key)) {
    return;
  }
  values.set(key, (deepFreeze(value): $FlowFixMe));
}
