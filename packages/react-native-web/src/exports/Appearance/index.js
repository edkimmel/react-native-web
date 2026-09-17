/**
 * Copyright (c) Nicolas Gallagher.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use client';

import type { HydrationStore } from '../../modules/hydrationState/store';
import invariant from 'fbjs/lib/invariant';
import canUseDOM from '../../modules/canUseDom';
import { getProcessState, getScopedState } from '../../modules/asyncContext';
import {
  getServerValue,
  setServerValue
} from '../../modules/hydrationState/store';

export type ColorSchemeName = 'light' | 'dark';

export type AppearancePreferences = {|
  colorScheme: ColorSchemeName
|};

// `colorScheme: null` means "nobody has declared a scheme", which is the
// state the client is normally in: the live media query below stays the
// source of truth and behavior is byte-for-byte what it was before this
// state existed. Only an explicit `set` / `unstable_setForHydration` makes
// it non-null.
type AppearanceState = {|
  colorScheme: ?ColorSchemeName
|};

type AppearanceListener = (preferences: AppearancePreferences) => void;
type DOMAppearanceListener = (ev: MediaQueryListEvent) => any;

function getQuery(): MediaQueryList | null {
  return canUseDOM && window.matchMedia != null
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

const query = getQuery();

const createDefaultAppearance = (): AppearanceState => ({
  colorScheme: null
});

// The color scheme is per-request state for the same reason the viewport
// is: an app that server-renders a user's saved dark-mode preference has
// to declare it per render, and `renderToPipeableStream` interleaves
// concurrent renders, so a plain module-level `let` would hand one user's
// scheme to another. On the client and outside any request scope this is
// a process singleton, so nothing about the browser changes.
//
// Like Dimensions, a fresh scope starts as a copy of the process default
// rather than as `null`, so an app that declares one scheme once at module
// scope keeps working and per-request `set` calls layer on top of it.
function getAppearance(): AppearanceState {
  return getScopedState('Appearance', () => ({
    colorScheme: getProcessState('Appearance', createDefaultAppearance)
      .colorScheme
  }));
}

function getMediaColorScheme(): ColorSchemeName {
  return query && query.matches ? 'dark' : 'light';
}

// A caller's listener to the DOM adapters registered on its behalf — one
// per live subscription, in the order they were added.
//
// One adapter per subscription rather than one memoised adapter per
// listener, for the reason spelled out at length in `AccessibilityInfo`:
// `MediaQueryList` is an `EventTarget` and dedups by
// `(type, listener, capture)`, so subscribing the same listener twice with
// a memoised adapter registers a single DOM listener and the first
// `remove()` cancels the survivor's only registration. Two `addChangeListener`
// calls have to mean two subscriptions, and two `remove()`s to end them.
const listenerMapping = new WeakMap<
  AppearanceListener,
  Array<DOMAppearanceListener>
>();

// Subscriptions are runtime state added post-mount, so — as with the
// Dimensions listeners — they stay module-level rather than per-request;
// no media query change events fire on the server anyway.
//
// The WeakMap above maps a caller's listener to its DOM adapters but cannot
// be enumerated, and `unstable_restoreFromHydration` has to be able to tell
// subscribers that control has passed back to the media query. Hence the
// parallel list. An array rather than a `Set`, so that a listener subscribed
// twice is notified twice — one notification per subscription, which is
// what the media query itself would deliver. It holds the same references
// the MediaQueryList already holds strongly; `remove()` clears both.
const listeners: Array<AppearanceListener> = [];

let setForHydration = false;

// ---------------------------------------------------------------------------
// Hydration store
//
// The `useSyncExternalStore` triple behind `useColorScheme`, plus the
// server-side read that puts this request's scheme on the wire. Attached to
// the default export as one `unstable_` namespace rather than as named
// module exports — see the same note in `Dimensions/index.js` for why named
// exports are not an option here.
// ---------------------------------------------------------------------------

const HYDRATION_KEY = 'Appearance';

// Module-level, so `useSyncExternalStore` does not re-subscribe on every
// render.
function subscribeToColorScheme(callback: () => void): () => void {
  const subscription = Appearance.addChangeListener(() => {
    callback();
  });
  return subscription.remove;
}

// A string, so snapshot identity stability is free — no caching needed to
// satisfy React's twice-per-render `getSnapshot` check.
function getColorSchemeSnapshot(): ColorSchemeName {
  return Appearance.getColorScheme();
}

/**
 * The scheme the server rendered with. Sharper than the Dimensions case:
 * the client *can* answer this question and can answer it differently,
 * because `matchMedia('(prefers-color-scheme: dark)')` only ever reports
 * the OS setting while the server may have rendered the user's own saved
 * choice. Falls back to the live value when no snapshot was provided, so an
 * app that wires up nothing is unaffected.
 */
function getColorSchemeServerSnapshot(): ColorSchemeName {
  if (!canUseDOM) {
    return Appearance.getColorScheme();
  }
  const serverValue = getServerValue(HYDRATION_KEY);
  const serverColorScheme =
    serverValue != null ? serverValue.colorScheme : null;
  return serverColorScheme === 'dark' || serverColorScheme === 'light'
    ? serverColorScheme
    : Appearance.getColorScheme();
}

function readForHydration(): mixed {
  return { colorScheme: Appearance.getColorScheme() };
}

const Appearance = {
  /**
   * The `useSyncExternalStore` triple plus the server-side read, for
   * `useColorScheme` and for the hydration state emitter. Not public API.
   */
  unstable_hydrationStore: ({
    getServerSnapshot: getColorSchemeServerSnapshot,
    getSnapshot: getColorSchemeSnapshot,
    hydrationKey: HYDRATION_KEY,
    read: readForHydration,
    subscribe: subscribeToColorScheme
  }: HydrationStore<ColorSchemeName>),

  getColorScheme(): ColorSchemeName {
    const { colorScheme } = getAppearance();
    return colorScheme != null ? colorScheme : getMediaColorScheme();
  },

  /**
   * Declare the color scheme this server render should use, isolated to
   * the current request when called inside `runInRequestScope`. Mirrors
   * `Dimensions.set`, including refusing to run in the browser, where the
   * media query is the only legitimate source of truth.
   */
  set(preferences: ?AppearancePreferences): void {
    if (preferences) {
      if (canUseDOM) {
        invariant(false, 'Appearance cannot be set in the browser');
      } else if (preferences.colorScheme != null) {
        getAppearance().colorScheme = preferences.colorScheme;
      }
    }
  },

  addChangeListener(listener: AppearanceListener): { remove: () => void } {
    const mappedListener = ({ matches }: MediaQueryListEvent) => {
      // While hydration values are forced, the media query is not the
      // source of truth: forwarding a change now would tear the tree
      // away from the markup being hydrated.
      // `unstable_restoreFromHydration` re-reads the query and notifies
      // once the override is dropped.
      if (setForHydration) {
        return;
      }
      listener({ colorScheme: matches ? 'dark' : 'light' });
    };
    const mapped = listenerMapping.get(listener);
    if (mapped == null) {
      listenerMapping.set(listener, [mappedListener]);
    } else {
      mapped.push(mappedListener);
    }
    listeners.push(listener);
    if (query) {
      query.addListener(mappedListener);
    }

    // Cancels THIS subscription, not every subscription that shares the
    // listener, and is idempotent: a second call finds its adapter already
    // gone and does nothing rather than taking a sibling's place.
    let removed = false;
    function remove(): void {
      if (removed) return;
      removed = true;
      const mapped = listenerMapping.get(listener);
      if (mapped != null) {
        const index = mapped.indexOf(mappedListener);
        if (index > -1) mapped.splice(index, 1);
        if (mapped.length === 0) listenerMapping.delete(listener);
      }
      if (query) {
        query.removeListener(mappedListener);
      }
      const notifyIndex = listeners.indexOf(listener);
      if (notifyIndex > -1) listeners.splice(notifyIndex, 1);
    }

    return { remove };
  },

  /**
   * Force the color scheme the server rendered with, for the duration of
   * hydration.
   *
   * Dimensions needs this because the server cannot know the real
   * viewport; Appearance needs it for the sharper reason that the client
   * *can* answer and can answer differently. `Appearance.set` exists so a
   * request can render the scheme the user chose — a cookie, an account
   * setting — and that choice is exactly the case where
   * `matchMedia('(prefers-color-scheme: dark)')` disagrees, because it
   * only ever reports the OS setting. Without this, the first client
   * render of such a page returns the OS scheme, React reports a
   * hydration mismatch, and the page flashes the wrong theme.
   */
  unstable_setForHydration(preferences: ?AppearancePreferences): void {
    if (preferences) {
      if (!canUseDOM) {
        invariant(
          false,
          'Appearance unstable_setForHydration should only be used in the browser'
        );
      } else if (preferences.colorScheme != null) {
        setForHydration = true;
        getAppearance().colorScheme = preferences.colorScheme;
        // Also record it as the frozen server snapshot, for the boundaries
        // that have not hydrated yet. The live value is still set, and must
        // be: `Appearance.getColorScheme()` callers during hydration see
        // the server's scheme today and have to keep seeing it. The store
        // keeps the first write only, so a later call cannot move what a
        // late boundary hydrates against.
        setServerValue(HYDRATION_KEY, {
          colorScheme: preferences.colorScheme
        });
      }
    }
  },

  /**
   * Hand control back to the media query once hydration has committed.
   *
   * Notifies change listeners when the query disagrees with the forced
   * value, for the same reason `Dimensions.unstable_restoreFromHydration`
   * does: nothing else will. A media query that never changed does not
   * re-fire — we merely stopped ignoring it — so without a notification
   * here every subscriber holds the forced scheme forever. Callers that
   * want the user's own preference to outlive hydration should simply not
   * call this.
   */
  unstable_restoreFromHydration(): void {
    // Deliberately does NOT touch the frozen server snapshot: a boundary
    // that has not hydrated yet must still see the scheme the markup was
    // rendered with, which is what makes restoring safe at any moment.
    if (!setForHydration) {
      return;
    }
    setForHydration = false;
    const state = getAppearance();
    const forcedColorScheme = state.colorScheme;
    state.colorScheme = null;
    const colorScheme = getMediaColorScheme();
    if (colorScheme !== forcedColorScheme) {
      // Copy first: a listener is entitled to unsubscribe from inside its
      // own notification, and splicing the array being iterated would skip
      // whichever subscription followed it.
      listeners.slice().forEach((listener) => {
        listener({ colorScheme });
      });
    }
  }
};

export default Appearance;
