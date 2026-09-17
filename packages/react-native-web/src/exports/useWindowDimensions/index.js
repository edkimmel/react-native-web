/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @flow strict-local
 */

'use client';

import type { DisplayMetrics } from '../Dimensions';

import Dimensions from '../Dimensions';
// Flow 0.148's bundled React libdef predates `useSyncExternalStore`, which
// React has exported since 18.0 — the floor of this package's `react` peer
// dependency. The suppression is uncoded because 0.148 does not recognise
// `missing-export` as a suppressible code; it covers this import specifier
// and nothing else.
// $FlowFixMe
import { useSyncExternalStore } from 'react';

const { getServerSnapshot, getSnapshot, subscribe } =
  Dimensions.unstable_hydrationStore;

/**
 * The window metrics, tracking resizes.
 *
 * `useSyncExternalStore` rather than `useState(() => Dimensions.get(...))`
 * plus an effect, and the difference only shows up under streaming SSR.
 * Seeding state from module-level device state captures whatever that state
 * happens to be *when this particular component first renders* — and with
 * progressive hydration, that is not one moment but many: a Suspense
 * boundary's first client render happens when its chunk lands, potentially
 * long after the root became interactive. If the viewport moved in between
 * (a resize, or the `unstable_restoreFromHydration` an app is supposed to
 * call once the root is interactive), every boundary that had not hydrated
 * yet renders values the server never used, and React reports a hydration
 * mismatch — or, worse, silently throws away the server markup for that
 * boundary and re-renders it on the client.
 *
 * React calls `getServerSnapshot` for every subtree it hydrates, whenever
 * it hydrates it, so each boundary re-reads the frozen server value, matches
 * its markup, and then reconciles to the live value in a passive effect as
 * an ordinary update.
 */
export default function useWindowDimensions(): DisplayMetrics {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
