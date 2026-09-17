/**
 * Copyright (c) Nicolas Gallagher.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { ComponentType, Node } from 'react';

import type { StyleElementProps } from './getStyleElements';

import AppContainer from './AppContainer';
import getStyleElementsImpl, {
  createStyleFormatGuard
} from './getStyleElements';
import invariant from 'fbjs/lib/invariant';
import render, { hydrate } from '../render';
import StyleSheet from '../StyleSheet';
import React from 'react';

export type Application = {
  unmount: () => void
};

export default function renderApplication<Props: Object>(
  RootComponent: ComponentType<Props>,
  WrapperComponent?: ?ComponentType<*>,
  callback?: () => void,
  options: {
    hydrate: boolean,
    initialProps: Props,
    rootTag: any
  }
): Application {
  const { hydrate: shouldHydrate, initialProps, rootTag } = options;
  const renderFn = shouldHydrate ? hydrate : render;

  invariant(rootTag, 'Expect to have a valid rootTag, instead got ', rootTag);

  return renderFn(
    <AppContainer
      WrapperComponent={WrapperComponent}
      ref={callback}
      rootTag={rootTag}
    >
      <RootComponent {...initialProps} />
    </AppContainer>,
    rootTag
  );
}

export function getApplication(
  RootComponent: ComponentType<Object>,
  initialProps: Object,
  WrapperComponent?: ?ComponentType<*>
): {|
  element: Node,
  getStyleElement: (Object) => Node,
  getStyleElements: (?StyleElementProps) => Array<Node>
|} {
  const element = (
    <AppContainer WrapperComponent={WrapperComponent} rootTag={{}}>
      <RootComponent {...initialProps} />
    </AppContainer>
  );
  // A document must use one stylesheet format or the other, never both.
  const recordStyleFormat = createStyleFormatGuard();
  // Don't escape CSS text
  const getStyleElement = (props) => {
    recordStyleFormat('legacy');
    const sheet = StyleSheet.getSheet();
    return (
      <style
        {...props}
        dangerouslySetInnerHTML={{ __html: sheet.textContent }}
        id={sheet.id}
      />
    );
  };
  // The streaming-compatible format: one <style data-rnw-group="G"> per
  // compiler group, ascending. See ./getStyleElements.
  const getStyleElements = (props) => {
    recordStyleFormat('grouped');
    return getStyleElementsImpl(props);
  };
  return { element, getStyleElement, getStyleElements };
}
