/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Dimensions from '..';
import { runInRequestScope } from '../../../modules/asyncContext';

// In the Node test environment `canUseDOM` is false, so `Dimensions.set`
// is permitted (it throws in the browser). This is the same call shape
// the SSR pipeline uses to seed per-request viewport metrics.

const zeroDimensions = () => ({
  window: { fontScale: 1, height: 0, scale: 1, width: 0 },
  screen: { fontScale: 1, height: 0, scale: 1, width: 0 }
});

describe('apis/Dimensions per-request scoping', () => {
  // Several tests below seed the process default. Reset it so the tests
  // asserting the pristine default hold regardless of ordering.
  afterEach(() => {
    Dimensions.set(zeroDimensions());
  });

  test('set + get inside a request scope reads back the per-request value', () => {
    runInRequestScope(() => {
      Dimensions.set({
        window: { fontScale: 1, height: 700, scale: 1, width: 360 },
        screen: { fontScale: 1, height: 800, scale: 1, width: 360 }
      });
      expect(Dimensions.get('window').width).toBe(360);
      expect(Dimensions.get('screen').height).toBe(800);
    });
  });

  test("concurrent scopes do not see each other's viewport values", async () => {
    const widths = [320, 768, 1024, 1440];
    const reads = await Promise.all(
      widths.map((width) =>
        runInRequestScope(async () => {
          Dimensions.set({
            window: { fontScale: 1, height: 1080, scale: 1, width },
            screen: { fontScale: 1, height: 1080, scale: 1, width }
          });
          // Yield to the microtask queue so other scopes interleave
          // between Dimensions.set and Dimensions.get.
          await Promise.resolve();
          return Dimensions.get('window').width;
        })
      )
    );
    expect(reads).toEqual(widths);
  });

  test('writes inside a scope do not leak to the process default', () => {
    runInRequestScope(() => {
      Dimensions.set({
        window: { fontScale: 1, height: 700, scale: 1, width: 360 },
        screen: { fontScale: 1, height: 800, scale: 1, width: 360 }
      });
      expect(Dimensions.get('window').width).toBe(360);
    });
    // Outside any scope: the process default is still the initial zeros.
    expect(Dimensions.get('window').width).toBe(0);
    expect(Dimensions.get('screen').width).toBe(0);
  });

  test('a scope inherits values set outside any scope', () => {
    // The established SSR pattern: seed viewport metrics once at module
    // scope, then render every request against them.
    Dimensions.set({
      window: { fontScale: 1, height: 900, scale: 2, width: 1280 },
      screen: { fontScale: 1, height: 1000, scale: 2, width: 1280 }
    });
    runInRequestScope(() => {
      expect(Dimensions.get('window').width).toBe(1280);
      expect(Dimensions.get('window').height).toBe(900);
      expect(Dimensions.get('screen').height).toBe(1000);
      expect(Dimensions.get('window').scale).toBe(2);
    });
  });

  test("inheritance is per-scope: one scope's override does not reach another", async () => {
    Dimensions.set({
      window: { fontScale: 1, height: 900, scale: 1, width: 1280 },
      screen: { fontScale: 1, height: 900, scale: 1, width: 1280 }
    });

    const [overridden, inherited] = await Promise.all([
      runInRequestScope(async () => {
        Dimensions.set({
          window: { fontScale: 1, height: 640, scale: 1, width: 320 },
          screen: { fontScale: 1, height: 640, scale: 1, width: 320 }
        });
        await Promise.resolve();
        return Dimensions.get('window').width;
      }),
      runInRequestScope(async () => {
        await Promise.resolve();
        return Dimensions.get('window').width;
      })
    ]);

    expect(overridden).toBe(320);
    expect(inherited).toBe(1280);
    // The override did not write through to the process default either.
    expect(Dimensions.get('window').width).toBe(1280);
  });

  test('a scope gets a copy, not the process default object', () => {
    Dimensions.set({
      window: { fontScale: 1, height: 900, scale: 1, width: 1280 },
      screen: { fontScale: 1, height: 900, scale: 1, width: 1280 }
    });
    const processWindow = Dimensions.get('window');
    runInRequestScope(() => {
      expect(Dimensions.get('window')).not.toBe(processWindow);
      expect(Dimensions.get('window')).toEqual(processWindow);
    });
  });
});
