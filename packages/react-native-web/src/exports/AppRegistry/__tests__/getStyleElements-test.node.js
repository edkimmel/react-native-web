/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `AppRegistry.getApplication().getStyleElements()` — the grouped, streaming
 * compatible counterpart to upstream's single-sheet `getStyleElement()`.
 *
 * The properties under test are the ones the streaming pipeline depends on:
 * every group is present as an anchor (including the empty ones), the
 * per-request delta watermark moves with the shell, and the two formats can
 * never be emitted from the same render.
 */

import AppRegistry from '..';
import React from 'react';
import ReactDOMServer from 'react-dom/server';
import StyleSheet from '../../StyleSheet';
import View from '../../View';
import { orderedGroups } from '../../StyleSheet/compiler';
import { runInRequestScope } from '../../../modules/asyncContext';

const NoopComponent = () => React.createElement('div');

// The process-wide sheet dedups by selector, so every test that needs a
// genuinely new rule has to use a value nothing else has used.
let px = 1000;
const uniq = () => px++;

function register(name = 'App', Component = NoopComponent) {
  AppRegistry.registerComponent(name, () => Component);
  return AppRegistry.getApplication(name, {});
}

describe('AppRegistry getStyleElements', () => {
  test('emits one <style> per compiler group, ascending, including empty groups', () => {
    const { getStyleElements } = register();
    const elements = getStyleElements();

    expect(Array.isArray(elements)).toBe(true);
    expect(elements.map((el) => el.props['data-rnw-group'])).toEqual(
      orderedGroups.map(String)
    );

    // The empty ones are the point: they are the anchors a later streamed
    // chunk inserts its delta against.
    const empty = elements.filter(
      (el) => el.props.dangerouslySetInnerHTML.__html === ''
    );
    expect(empty.length).toBeGreaterThan(0);

    // Keyed, so React does not warn about an array of children.
    elements.forEach((el) => {
      expect(el.key).toBe(`rnw-group-${el.props['data-rnw-group']}`);
    });
  });

  test('the array renders through renderToStaticMarkup', () => {
    const { getStyleElements } = register();
    const html = ReactDOMServer.renderToStaticMarkup(getStyleElements());

    const groups = html
      .match(/data-rnw-group="[^"]*"/g)
      .map((attr) => attr.slice('data-rnw-group="'.length, -1));
    expect(groups).toEqual(orderedGroups.map(String));
    expect(html).not.toContain('react-native-stylesheet');
    expect(html.startsWith('<style data-rnw-group="0"')).toBe(true);
  });

  test('renders the same markup as StyleSheet.takeShellHTML()', () => {
    // Not just "looks similar": the whole point of routing through
    // takeShellHTML is that adapters can mix an AppRegistry shell with
    // streamed deltas and get byte-identical anchors.
    const { getStyleElements } = register();
    const viaElements = ReactDOMServer.renderToStaticMarkup(getStyleElements());
    const viaString = StyleSheet.takeShellHTML();
    expect(viaElements).toBe(viaString);
  });

  test('contains the rules added by later renders', () => {
    const width = uniq();
    const styles = StyleSheet.create({ root: { borderWidth: width } });
    const Component = () => React.createElement(View, { style: styles.root });
    const { getStyleElements } = register('LateApp', Component);

    const html = ReactDOMServer.renderToStaticMarkup(getStyleElements());
    expect(html).toContain(`border-bottom-width:${width}px`);
  });

  describe('nonce', () => {
    test('is applied to every emitted element', () => {
      const nonce = '2Bz9RM/UHvBbmo3jK/PbYZ==';
      const { getStyleElements } = register();
      const elements = getStyleElements({ nonce });

      elements.forEach((el) => {
        expect(el.props.nonce).toBe(nonce);
      });

      const html = ReactDOMServer.renderToStaticMarkup(elements);
      expect(html.match(/nonce="/g)).toHaveLength(orderedGroups.length);
      // React escapes the attribute; the raw value must not leak.
      expect(html).toContain('nonce="2Bz9RM/UHvBbmo3jK/PbYZ=="');
    });

    test('props cannot override the group attribute or the CSS text', () => {
      const { getStyleElements } = register();
      const elements = getStyleElements({
        'data-rnw-group': 'nope',
        dangerouslySetInnerHTML: { __html: 'nope{}' }
      });
      expect(elements[0].props['data-rnw-group']).toBe('0');
      expect(elements[0].props.dangerouslySetInnerHTML.__html).not.toBe(
        'nope{}'
      );
    });

    test('"id" is rejected: it would be duplicated across every element', () => {
      const { getStyleElements } = register();
      expect(() => getStyleElements({ id: 'react-native-stylesheet' })).toThrow(
        /duplicate ids/
      );
    });
  });

  describe('per-request delta watermark', () => {
    test('resets the delta, so the shell is not re-sent as a chunk', () => {
      runInRequestScope(() => {
        const width = uniq();
        StyleSheet.create({ before: { borderWidth: width } });

        const { getStyleElements } = register('DeltaApp');
        const shell = ReactDOMServer.renderToStaticMarkup(getStyleElements());
        expect(shell).toContain(`border-bottom-width:${width}px`);

        // Everything up to this point travelled in the shell.
        expect(StyleSheet.takeDeltaHTML()).toBe('');
      });
    });

    test('rules added after the shell still arrive as a delta', () => {
      runInRequestScope(() => {
        const width = uniq();
        const { getStyleElements } = register('DeltaApp2');
        const shell = ReactDOMServer.renderToStaticMarkup(getStyleElements());
        expect(shell).not.toContain(`border-bottom-width:${width}px`);

        StyleSheet.create({ late: { borderWidth: width } });
        expect(StyleSheet.takeDeltaHTML()).toContain(
          `border-bottom-width:${width}px`
        );
      });
    });
  });

  describe('mixing the two formats', () => {
    test('throws when the legacy sheet is emitted after the grouped one', () => {
      const { getStyleElement, getStyleElements } = register();
      getStyleElements();
      expect(() => getStyleElement()).toThrow(/never safe/);
    });

    test('throws when the grouped sheet is emitted after the legacy one', () => {
      const { getStyleElement, getStyleElements } = register();
      getStyleElement();
      expect(() => getStyleElements()).toThrow(/never safe/);
    });

    test('is detected across separate getApplication() calls in one request', () => {
      runInRequestScope(() => {
        register('MixA').getStyleElements();
        expect(() => register('MixB').getStyleElement()).toThrow(/never safe/);
      });
    });

    test('does not leak between requests', () => {
      runInRequestScope(() => {
        register('IsolatedA').getStyleElements();
      });
      expect(() => {
        runInRequestScope(() => {
          register('IsolatedB').getStyleElement();
        });
      }).not.toThrow();
    });

    test('repeat calls to the same accessor are fine', () => {
      const { getStyleElements } = register();
      expect(() => {
        getStyleElements();
        getStyleElements();
      }).not.toThrow();
    });
  });

  describe('legacy getStyleElement is unchanged', () => {
    test('still returns a single <style id="react-native-stylesheet">', () => {
      const { getStyleElement } = register();
      const element = getStyleElement();
      const sheet = StyleSheet.getSheet();

      expect(element.type).toBe('style');
      expect(element.props.id).toBe('react-native-stylesheet');
      expect(element.props.dangerouslySetInnerHTML.__html).toBe(
        sheet.textContent
      );
      expect(element.props['data-rnw-group']).toBeUndefined();

      const html = ReactDOMServer.renderToStaticMarkup(element);
      expect(html.startsWith('<style id="react-native-stylesheet">')).toBe(
        true
      );
      expect(html).not.toContain('data-rnw-group');
      // Still the marker-delimited single-sheet format.
      expect(html).toContain('[stylesheet-group="0"]{}');
    });

    test('still forwards props to the single <style>', () => {
      const nonce = '2Bz9RM/UHvBbmo3jK/PbYZ==';
      const { getStyleElement } = register();
      expect(getStyleElement({ nonce }).props.nonce).toBe(nonce);
    });

    test('does not move the delta watermark', () => {
      // getStyleElement is not a streaming API and never claimed to be; it
      // must stay a pure read of the sheet.
      runInRequestScope(() => {
        const width = uniq();
        StyleSheet.create({ legacy: { borderWidth: width } });
        register('LegacyDelta').getStyleElement();
        expect(StyleSheet.takeDeltaHTML()).toContain(
          `border-bottom-width:${width}px`
        );
      });
    });
  });
});
