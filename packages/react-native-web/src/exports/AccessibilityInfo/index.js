/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

'use client';

import canUseDOM from '../../modules/canUseDom';

type ReduceMotionListener = (reduceMotion: boolean) => void;
type DOMReduceMotionListener = (ev: MediaQueryListEvent) => any;

function isScreenReaderEnabled(): Promise<*> {
  return new Promise((resolve, reject) => {
    resolve(true);
  });
}

const prefersReducedMotionMedia =
  canUseDOM && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

function isReduceMotionEnabled(): Promise<*> {
  return new Promise((resolve, reject) => {
    resolve(
      prefersReducedMotionMedia ? prefersReducedMotionMedia.matches : true
    );
  });
}

function addChangeListener(fn: DOMReduceMotionListener): void {
  if (prefersReducedMotionMedia != null) {
    prefersReducedMotionMedia.addEventListener != null
      ? prefersReducedMotionMedia.addEventListener('change', fn)
      : prefersReducedMotionMedia.addListener(fn);
  }
}

function removeChangeListener(fn: DOMReduceMotionListener): void {
  if (prefersReducedMotionMedia != null) {
    prefersReducedMotionMedia.removeEventListener != null
      ? prefersReducedMotionMedia.removeEventListener('change', fn)
      : prefersReducedMotionMedia.removeListener(fn);
  }
}

// Maps a caller's handler to the DOM adapters registered on its behalf —
// one per live subscription, in the order they were added.
//
// A WeakMap, not a plain object. Object keys are strings, so the previous
// `handlers[handler] = listener` stringified the function: two distinct
// handlers with identical source text — `() => setFlag(true)` written in
// two components, say — shared one entry, and unsubscribing either one
// detached the other's DOM listener while leaving the survivor believing it
// was still subscribed. Keying by identity fixes that; the WeakMap also
// stops the registry pinning handlers in memory after removal.
//
// An ARRAY of adapters, not one memoised adapter, and that half is not
// optional. `EventTarget` dedups by `(type, listener, capture)`, so handing
// `addEventListener` the same function twice registers ONE listener — two
// subscriptions sharing a handler would collapse into one, and the first
// `remove()` would detach the survivor's only registration. That is a
// strictly worse failure than the one being fixed (silent loss of a live
// subscription, rather than a leak), and it is a regression against the
// behaviour this API has always had: upstream built a fresh closure per
// call, so two subscriptions meant two DOM listeners and removing one left
// the other working. A fresh adapter per subscription restores that, and
// the array is what lets `removeEventListener(event, handler)` — which is
// given no way to say *which* subscription it means — still detach exactly
// one of them.
const listenerMapping = new WeakMap<
  ReduceMotionListener,
  Array<DOMReduceMotionListener>
>();

function trackListener(
  handler: ReduceMotionListener,
  listener: DOMReduceMotionListener
): void {
  const listeners = listenerMapping.get(handler);
  if (listeners == null) {
    listenerMapping.set(handler, [listener]);
  } else {
    listeners.push(listener);
  }
}

/**
 * Detach one registration for `handler`: the named `listener`, or — when
 * the caller cannot name one — the most recent.
 *
 * Both callers are load-bearing, and neither may fall back to the other.
 * The subscription object returned by `addEventListener` knows which adapter
 * is its own, so `remove()` detaches exactly that one and does nothing at
 * all if it is already gone; falling back to "the last one" there would let
 * a subscription whose own registration had been taken by
 * `removeEventListener` eat a sibling's instead.
 * `removeEventListener(event, handler)` has only the handler to go on, so it
 * takes the last registration — which is what upstream's
 * `handlers[handler] = listener` overwrite did, and the only choice that
 * leaves the count right.
 */
function untrackListener(
  handler: ReduceMotionListener,
  listener: ?DOMReduceMotionListener
): void {
  const listeners = listenerMapping.get(handler);
  if (listeners == null || listeners.length === 0) return;
  const index = listener != null ? listeners.indexOf(listener) : -1;
  if (listener != null && index === -1) return;
  const [removed] =
    index > -1 ? listeners.splice(index, 1) : listeners.splice(-1, 1);
  if (listeners.length === 0) listenerMapping.delete(handler);
  removeChangeListener(removed);
}

const AccessibilityInfo = {
  /**
   * Query whether a screen reader is currently enabled.
   *
   * Returns a promise which resolves to a boolean.
   * The result is `true` when a screen reader is enabled and `false` otherwise.
   */
  isScreenReaderEnabled,

  /**
   * Query whether the user prefers reduced motion.
   *
   * Returns a promise which resolves to a boolean.
   * The result is `true` when a screen reader is enabled and `false` otherwise.
   */
  isReduceMotionEnabled,

  /**
   * Deprecated
   */
  fetch: isScreenReaderEnabled,

  /**
   * Add an event handler. Supported events: reduceMotionChanged
   */
  addEventListener: function (eventName: string, handler: Function): Object {
    // Captured once and then cleared by `remove()`, which is what makes a
    // second `remove()` inert. `subscribed` rather than a nullable
    // `listener`, so the adapter stays a function for Flow's benefit.
    const listener: DOMReduceMotionListener = (event: MediaQueryListEvent) => {
      handler(event.matches);
    };
    let subscribed = false;
    if (eventName === 'reduceMotionChanged') {
      trackListener(handler, listener);
      addChangeListener(listener);
      subscribed = true;
    }

    // Always a subscription object, even where there is no media query to
    // subscribe to — every server render, and any browser without
    // `matchMedia`. This used to return `undefined` in that case, so the
    // documented `const { remove } = addEventListener(...)` threw on
    // destructuring, and an unsubscribe in an effect cleanup threw with it.
    //
    // `remove` names the adapter this call registered rather than deferring
    // to `removeEventListener`, so two subscriptions sharing one handler
    // each cancel their own and a second `remove()` on the same
    // subscription is a no-op instead of cancelling the sibling.
    return {
      remove: () => {
        if (subscribed) {
          subscribed = false;
          untrackListener(handler, listener);
        }
      }
    };
  },

  /**
   * Set accessibility focus to a react component.
   */
  setAccessibilityFocus: function (reactTag: number): void {},

  /**
   * Post a string to be announced by the screen reader.
   */
  announceForAccessibility: function (announcement: string): void {},

  /**
   * Remove an event handler.
   */
  removeEventListener: function (eventName: string, handler: Function): void {
    if (eventName === 'reduceMotionChanged') {
      untrackListener(handler, null);
    }
    return;
  }
};

export default AccessibilityInfo;
