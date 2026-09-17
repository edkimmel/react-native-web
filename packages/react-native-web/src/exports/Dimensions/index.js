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

import type { EventSubscription } from '../../vendor/react-native/vendor/emitter/EventEmitter';
import type { HydrationStore } from '../../modules/hydrationState/store';
import invariant from 'fbjs/lib/invariant';
import canUseDOM from '../../modules/canUseDom';
import { getProcessState, getScopedState } from '../../modules/asyncContext';
import {
  getServerValue,
  setServerValue
} from '../../modules/hydrationState/store';

export type DisplayMetrics = {|
  fontScale: number,
  height: number,
  scale: number,
  width: number
|};

type DimensionsValue = {|
  window: DisplayMetrics,
  screen: DisplayMetrics
|};

type DimensionKey = 'window' | 'screen';

type DimensionEventListenerType = 'change';

const createDefaultDimensions = (): DimensionsValue => ({
  window: {
    fontScale: 1,
    height: 0,
    scale: 1,
    width: 0
  },
  screen: {
    fontScale: 1,
    height: 0,
    scale: 1,
    width: 0
  }
});

// `dimensions` is the only piece of module state that needs per-request
// isolation: each SSR render writes its own `window` / `screen` values via
// `Dimensions.set`, and `Dimensions.get` reads them back. On the client
// and outside any request scope this returns a stable process singleton.
//
// A new scope starts as a copy of the process default rather than as
// zeros, so the established pattern of seeding viewport metrics once at
// module scope keeps working. A shallow clone per key is enough:
// `Dimensions.set` replaces `window` and `screen` wholesale rather than
// mutating their fields.
function getDimensions(): DimensionsValue {
  return getScopedState('Dimensions', () => {
    const base = getProcessState('Dimensions', createDefaultDimensions);
    return {
      window: { ...base.window },
      screen: { ...base.screen }
    };
  });
}

// Event listeners are runtime subscriptions added post-mount; on the
// server no resize events fire. Keeping these module-level matches the
// historical singleton behavior and avoids spurious per-request maps.
const listeners = {};

let shouldInit = canUseDOM;
let setForHydration = false;

function update() {
  if (!canUseDOM) {
    return;
  }

  // While hydration values are forced, a resize must not overwrite them.
  // `unstable_restoreFromHydration` clears the flag before calling update().
  if (setForHydration) {
    return;
  }

  const win = window;
  let height;
  let width;

  /**
   * iOS does not update viewport dimensions on keyboard open/close.
   * window.visualViewport(https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)
   * is used instead of document.documentElement.clientHeight (which remains as a fallback)
   */
  if (win.visualViewport) {
    const visualViewport = win.visualViewport;
    /**
     * We are multiplying by scale because height and width from visual viewport
     * also react to pinch zoom, and become smaller when zoomed. But it is not desired
     * behaviour, since originally documentElement client height and width were used,
     * and they do not react to pinch zoom.
     */
    height = Math.round(visualViewport.height * visualViewport.scale);
    width = Math.round(visualViewport.width * visualViewport.scale);
  } else {
    const docEl = win.document.documentElement;
    height = docEl.clientHeight;
    width = docEl.clientWidth;
  }

  const dimensions = getDimensions();
  dimensions.window = {
    fontScale: 1,
    height,
    scale: win.devicePixelRatio || 1,
    width
  };

  dimensions.screen = {
    fontScale: 1,
    height: win.screen.height,
    scale: win.devicePixelRatio || 1,
    width: win.screen.width
  };
}

function notifyChange() {
  if (Array.isArray(listeners['change'])) {
    const dimensions = getDimensions();
    listeners['change'].forEach((handler) => handler(dimensions));
  }
}

// `update()` always assigns fresh objects, so identity tells us nothing
// about whether the numbers moved.
function sameMetrics(a: DisplayMetrics, b: DisplayMetrics): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.scale === b.scale &&
    a.fontScale === b.fontScale
  );
}

function handleResize() {
  update();
  notifyChange();
}

// ---------------------------------------------------------------------------
// Hydration store
//
// The `useSyncExternalStore` triple behind `useWindowDimensions`, plus the
// server-side read that puts this request's metrics on the wire. Kept off
// the public `Dimensions` surface as a single `unstable_` namespace: none of
// it is React Native API, and `Dimensions.subscribe` sitting next to
// `Dimensions.addEventListener` would read like a second public
// subscription API.
//
// It is a property of the default export rather than a set of named module
// exports for a concrete reason: `babel-plugin-add-module-exports` collapses
// `module.exports` to the default only while a module has no named exports,
// so adding one silently changes the CommonJS shape of
// `dist/cjs/exports/Dimensions` from the class to `{ default }`, breaking
// every deep `require` of it — including two test files in this repo.
// ---------------------------------------------------------------------------

const HYDRATION_KEY = 'Dimensions';

// Stable module-level identity: `useSyncExternalStore` re-subscribes
// whenever `subscribe` changes, so a fresh closure per render would tear
// down and re-establish the listener on every render.
function subscribeToWindow(callback: () => void): () => void {
  const subscription = Dimensions.addEventListener('change', callback);
  return () => {
    subscription.remove();
  };
}

// Identity is stable without any caching of our own: `getDimensions()`
// returns the same state object for the life of the scope, and `window` is
// only ever *replaced* on it (by `update()` and `set()`), never mutated in
// place. So repeated reads between changes return the same reference, which
// is what React requires — it calls `getSnapshot()` twice per render in
// development and warns if the results differ.
function getWindowSnapshot(): DisplayMetrics {
  return Dimensions.get('window');
}

/**
 * What the server rendered this subtree with — the value React must use for
 * *every* subtree it hydrates, however late that happens.
 *
 * On the server the request-scoped value IS the server value, so there is
 * nothing to look up. On the client it comes from the frozen snapshot, and
 * falls back to the live value when there is none: an app that wires up
 * neither `takeHydrationStateHTML()` nor `unstable_setForHydration()` behaves
 * exactly as it did before this existed.
 */
function getWindowServerSnapshot(): DisplayMetrics {
  if (!canUseDOM) {
    return Dimensions.get('window');
  }
  const serverValue = getServerValue(HYDRATION_KEY);
  const serverWindow = serverValue != null ? serverValue.window : null;
  return serverWindow != null ? serverWindow : Dimensions.get('window');
}

// Both metrics go on the wire, not just `window`: `Dimensions.get('screen')`
// is readable imperatively during hydration too, and a render that consults
// it has the same problem for the same reason.
function readForHydration(): mixed {
  return {
    screen: Dimensions.get('screen'),
    window: Dimensions.get('window')
  };
}

export default class Dimensions {
  static unstable_hydrationStore: HydrationStore<DisplayMetrics> = {
    getServerSnapshot: getWindowServerSnapshot,
    getSnapshot: getWindowSnapshot,
    hydrationKey: HYDRATION_KEY,
    read: readForHydration,
    subscribe: subscribeToWindow
  };

  static get(dimension: DimensionKey): DisplayMetrics {
    if (shouldInit && !setForHydration) {
      shouldInit = false;
      update();
    }
    const dimensions = getDimensions();
    invariant(dimensions[dimension], `No dimension set for key ${dimension}`);
    return dimensions[dimension];
  }

  static set(initialDimensions: ?DimensionsValue): void {
    if (initialDimensions) {
      if (canUseDOM) {
        invariant(false, 'Dimensions cannot be set in the browser');
      } else {
        const dimensions = getDimensions();
        if (initialDimensions.screen != null) {
          dimensions.screen = initialDimensions.screen;
        }
        if (initialDimensions.window != null) {
          dimensions.window = initialDimensions.window;
        }
      }
    }
  }

  static addEventListener(
    type: DimensionEventListenerType,
    handler: (DimensionsValue) => void
  ): EventSubscription {
    listeners[type] = listeners[type] || [];
    listeners[type].push(handler);

    return {
      remove: () => {
        this.removeEventListener(type, handler);
      }
    };
  }

  static removeEventListener(
    type: DimensionEventListenerType,
    handler: (DimensionsValue) => void
  ): void {
    if (Array.isArray(listeners[type])) {
      listeners[type] = listeners[type].filter(
        (_handler) => _handler !== handler
      );
    }
  }

  // `unstable_`, not the `unsafe_` this was first called: react-native's
  // prefix for a pre-1.0 escape hatch is `unstable_` (React's is `UNSAFE_`,
  // for a different thing entirely), and this class already carries
  // `unstable_hydrationStore` — one namespace, one prefix, and it is the
  // ecosystem's. `Appearance.unstable_restoreFromHydration` moved with it.
  static unstable_setForHydration(initialDimensions: ?DimensionsValue): void {
    if (initialDimensions) {
      if (!canUseDOM) {
        invariant(
          false,
          'Dimensions unstable_setForHydration should only be used in the browser'
        );
      } else {
        setForHydration = true;
        // The forced values stand in for what update() would have read, so
        // the lazy first-get initialization is already satisfied.
        shouldInit = false;
        const dimensions = getDimensions();
        if (initialDimensions.screen != null) {
          dimensions.screen = initialDimensions.screen;
        }
        if (initialDimensions.window != null) {
          dimensions.window = initialDimensions.window;
        }
        // Record the same values as the frozen server snapshot, for the
        // boundaries that have not hydrated yet. Setting the live value is
        // kept as well, and must be: imperative `Dimensions.get()` callers
        // during hydration see the server value today and have to keep
        // seeing it. The store takes the first write only, so a second call
        // moves the live value without disturbing what late boundaries
        // hydrate against.
        setServerValue(HYDRATION_KEY, {
          screen: dimensions.screen,
          window: dimensions.window
        });
      }
    }
  }

  static unstable_restoreFromHydration(): void {
    // Deliberately does NOT touch the frozen server snapshot. That is the
    // whole point of this design: restoring is safe at any moment, because a
    // boundary that has not hydrated yet still reads the snapshot rather
    // than the live value, and so still agrees with the markup it is
    // reconciling against.
    //
    // Notify, unlike a bare `update()`. Nothing else will: `handleResize` is
    // the only notifier, and the resize that prompted the caller to restore
    // has typically already been handled — with `setForHydration` still set,
    // so `update()` returned early and the event was consumed for nothing.
    // Without a notification here every `useWindowDimensions` consumer keeps
    // the server's forced size until some *later* resize happens to arrive.
    // Same reasoning as `Appearance.unstable_restoreFromHydration`. That
    // notification is load-bearing twice over now: it is also what drives
    // the post-restore re-render through `useSyncExternalStore`.
    const dimensions = getDimensions();
    const previousWindow = dimensions.window;
    const previousScreen = dimensions.screen;
    setForHydration = false;
    update();
    if (
      !sameMetrics(previousWindow, dimensions.window) ||
      !sameMetrics(previousScreen, dimensions.screen)
    ) {
      notifyChange();
    }
  }
}

if (canUseDOM) {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', handleResize, false);
  } else {
    window.addEventListener('resize', handleResize, false);
  }
}
