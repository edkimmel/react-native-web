/**
 * Copyright (c) Nicolas Gallagher.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Dimensions from '..';

describe('apis/Dimensions', () => {
  test('get', () => {
    const handler = jest.fn();
    Dimensions.addEventListener('change', handler);
    expect(Dimensions.get('screen')).toMatchInlineSnapshot(`
      {
        "fontScale": 1,
        "height": 0,
        "scale": 1,
        "width": 0,
      }
    `);
    expect(Dimensions.get('window')).toMatchInlineSnapshot(`
      {
        "fontScale": 1,
        "height": 768,
        "scale": 1,
        "width": 1024,
      }
    `);
    expect(handler).toHaveBeenCalledTimes(0);
  });

  test('set', () => {
    expect(() => Dimensions.set({})).toThrow();
  });

  test('addEventListener', () => {
    const handler = jest.fn();
    const subscription = Dimensions.addEventListener('change', handler);
    window.dispatchEvent(new Event('resize'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenLastCalledWith({
      window: Dimensions.get('window'),
      screen: Dimensions.get('screen')
    });
    subscription.remove();
    window.dispatchEvent(new Event('resize'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('removeEventListener', () => {
    const handler = jest.fn();
    Dimensions.removeEventListener('change', handler);
    window.dispatchEvent(new Event('resize'));
    expect(handler).toHaveBeenCalledTimes(0);
  });

  test('unstable_setForHydration values survive a resize', () => {
    Dimensions.unstable_setForHydration({
      window: { fontScale: 1, height: 700, scale: 1, width: 360 },
      screen: { fontScale: 1, height: 800, scale: 1, width: 360 }
    });
    expect(Dimensions.get('window').width).toBe(360);

    // A resize between set and restore must not undo the forced values;
    // the whole point of the override is that layout matches the server.
    window.dispatchEvent(new Event('resize'));
    expect(Dimensions.get('window').width).toBe(360);
    expect(Dimensions.get('screen').height).toBe(800);

    Dimensions.unstable_restoreFromHydration();
    expect(Dimensions.get('window').width).toBe(1024);
    expect(Dimensions.get('window').height).toBe(768);
  });
});
