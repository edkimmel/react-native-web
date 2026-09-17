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

import type { ColorSchemeName } from '../Appearance';
import Appearance from '../Appearance';
// Flow 0.148's bundled React libdef predates `useSyncExternalStore`, which
// React has exported since 18.0 — the floor of this package's `react` peer
// dependency. The suppression is uncoded because 0.148 does not recognise
// `missing-export` as a suppressible code; it covers this import specifier
// and nothing else.
// $FlowFixMe
import { useSyncExternalStore } from 'react';

const { getServerSnapshot, getSnapshot, subscribe } =
  Appearance.unstable_hydrationStore;

/**
 * The active color scheme, tracking changes.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect, for the
 * reason spelled out in `useWindowDimensions`: under streaming SSR a
 * Suspense boundary's first client render can happen long after the root's,
 * and only `getServerSnapshot` gives every one of them the value the server
 * actually rendered with. The stakes are higher here than for the viewport —
 * the client can answer this question, and answers it differently whenever
 * the user's saved theme is not their OS theme, so a late boundary would
 * flash and mismatch rather than merely be a few pixels out.
 *
 * This also removes a subscription bug: the effect it replaces had no
 * dependency array, so it tore down and re-established the `Appearance`
 * listener on every single render.
 */
export default function useColorScheme(): ColorSchemeName {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
