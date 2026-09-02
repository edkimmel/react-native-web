/**
 * Copyright (c) Nicolas Gallagher.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import AppRegistry from '..';
import React from 'react';
import { act } from '@testing-library/react';
const NoopComponent = () => React.createElement('div');

describe.each([['concurrent'], ['legacy']])('AppRegistry', (mode) => {
  describe('runApplication', () => {
    let rootTag;

    beforeEach(() => {
      rootTag = document.createElement('div');
      rootTag.id = 'react-root';
      document.body.appendChild(rootTag);
    });

    afterEach(() => {
      document.body.removeChild(rootTag);
    });

    test('callback after render', () => {
      const callback = jest.fn();
      AppRegistry.registerComponent('App', () => NoopComponent);
      act(() => {
        AppRegistry.runApplication('App', {
          initialProps: {},
          rootTag,
          callback,
          mode
        });
      });
      expect(callback).toHaveBeenCalledTimes(1);
    });

    test('unmount ran application', () => {
      const setMountedState = jest.fn();
      const MountedStateComponent = () => {
        React.useEffect(() => {
          setMountedState(true);
          return () => {
            setMountedState(false);
          };
        }, []);
        return <NoopComponent />;
      };

      AppRegistry.registerComponent('App', () => MountedStateComponent);
      let application;
      act(() => {
        application = AppRegistry.runApplication('App', {
          initialProps: {},
          rootTag,
          mode
        });
      });
      expect(setMountedState).toHaveBeenCalledTimes(1);
      expect(setMountedState).toHaveBeenLastCalledWith(true);
      act(() => {
        application.unmount();
      });
      expect(setMountedState).toHaveBeenCalledTimes(2);
      expect(setMountedState).toHaveBeenLastCalledWith(false);
    });

    test('styles roots in different documents', () => {
      AppRegistry.registerComponent('App', () => NoopComponent);
      act(() => {
        AppRegistry.runApplication('App', { initialProps: {}, rootTag, mode });
      });
      // Create iframe context
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);

      const iframeRootTag = document.createElement('div');
      iframeRootTag.id = 'react-iframe-root';
      iframe.contentWindow.document.body.appendChild(iframeRootTag);

      // Run in iframe
      AppRegistry.registerComponent('App', () => NoopComponent);
      act(() => {
        AppRegistry.runApplication('App', {
          initialProps: {},
          rootTag: iframeRootTag,
          mode
        });
      });

      const iframedoc = iframeRootTag.ownerDocument;
      expect(iframedoc).toBe(iframe.contentWindow.document);
      expect(iframedoc).not.toBe(document);

      // Styles are mirrored into the other document as one <style> per
      // group, ascending — the same layout the streaming shell emits, so
      // the cascade order is identical in both documents.
      const styleElements = Array.prototype.slice.call(
        iframedoc.querySelectorAll('style[data-rnw-group]')
      );
      expect(
        styleElements.map((el) => el.getAttribute('data-rnw-group'))
      ).toEqual(['0', '1', '2', '3']);

      const cssText = styleElements.reduce(
        (acc, el) =>
          acc.concat(
            Array.prototype.slice
              .call(el.sheet.cssRules)
              .map((cssRule) => cssRule.cssText)
          ),
        []
      );

      expect(cssText).toMatchSnapshot();
    });
  });
});
