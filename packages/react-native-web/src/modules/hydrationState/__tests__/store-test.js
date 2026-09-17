/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The frozen server snapshot, on its own.
 *
 * Two properties matter and neither is observable from the outside once it
 * has gone wrong — a mutated or replaced snapshot shows up as a hydration
 * mismatch in whichever Suspense boundary happened to hydrate late:
 *
 *   1. Immutability. The value is read by boundaries hydrating at
 *      arbitrary, unrelated moments; every one of them has to see what the
 *      first one saw.
 *   2. Never throwing. The global it reads is written into an HTML response
 *      that can be truncated, CSP-blocked, or clobbered by another script.
 *      Every failure has to degrade to "no snapshot" — which callers
 *      already handle by falling back to the live value — and not to a
 *      crash during hydration.
 *
 * Each case gets a fresh module registry, because the parse is a one-time
 * lazy step by design.
 */

const GLOBAL_KEY = '__RNW_HYDRATION__';

function withGlobal(value, fn) {
  if (value === undefined) {
    delete window[GLOBAL_KEY];
  } else {
    window[GLOBAL_KEY] = value;
  }
  let result;
  jest.isolateModules(() => {
    result = fn(require('../store'));
  });
  return result;
}

afterEach(() => {
  delete window[GLOBAL_KEY];
});

describe('modules/hydrationState/store', () => {
  describe('reading the global', () => {
    test('an object literal is read, per key', () => {
      withGlobal(
        {
          Appearance: { colorScheme: 'dark' },
          Dimensions: { window: { width: 360 } }
        },
        (store) => {
          expect(store.getServerValue('Appearance')).toEqual({
            colorScheme: 'dark'
          });
          expect(store.getServerValue('Dimensions').window.width).toBe(360);
        }
      );
    });

    test('a JSON string is parsed', () => {
      // The emitter writes an object literal, but a framework carrying the
      // payload through its own serialisation channel hands over a string.
      withGlobal('{"Appearance":{"colorScheme":"dark"}}', (store) => {
        expect(store.getServerValue('Appearance')).toEqual({
          colorScheme: 'dark'
        });
      });
    });

    test('an unknown key is null, not undefined', () => {
      withGlobal({ Appearance: { colorScheme: 'dark' } }, (store) => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
          expect(store.getServerValue('Nope')).toBeNull();
        } finally {
          spy.mockRestore();
        }
      });
    });

    test('the parse happens once and the result is identity-stable', () => {
      // `useSyncExternalStore` calls `getServerSnapshot()` twice on mount
      // and warns if the two results differ, so this is not cosmetic.
      withGlobal({ Appearance: { colorScheme: 'dark' } }, (store) => {
        const first = store.getServerValue('Appearance');
        expect(store.getServerValue('Appearance')).toBe(first);
      });
    });

    test('everything reachable is deep-frozen', () => {
      withGlobal({ Dimensions: { window: { width: 360 } } }, (store) => {
        const value = store.getServerValue('Dimensions');
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.window)).toBe(true);
      });
    });
  });

  describe('resilience', () => {
    // Every one of these has to produce `null` rather than throw: this runs
    // during the first render of a hydrating tree, where an exception is
    // not a degraded snapshot but a blank page.
    test('an absent global', () => {
      withGlobal(undefined, (store) => {
        expect(store.getServerValue('Dimensions')).toBeNull();
      });
    });

    test('a null global', () => {
      withGlobal(null, (store) => {
        expect(store.getServerValue('Dimensions')).toBeNull();
      });
    });

    test('a non-JSON string', () => {
      withGlobal('this is not json {{{', (store) => {
        expect(store.getServerValue('Dimensions')).toBeNull();
      });
    });

    test('a scalar global', () => {
      withGlobal(42, (store) => {
        expect(store.getServerValue('Dimensions')).toBeNull();
      });
    });

    test('a well-formed global with a scalar entry drops that entry only', () => {
      withGlobal(
        { Appearance: { colorScheme: 'dark' }, Broken: 'nope' },
        (store) => {
          const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
          try {
            expect(store.getServerValue('Broken')).toBeNull();
          } finally {
            spy.mockRestore();
          }
          expect(store.getServerValue('Appearance')).not.toBeNull();
        }
      );
    });

    test('a global whose getter throws', () => {
      let store;
      jest.isolateModules(() => {
        Object.defineProperty(window, GLOBAL_KEY, {
          configurable: true,
          get() {
            throw new Error('blocked');
          }
        });
        store = require('../store');
        expect(store.getServerValue('Dimensions')).toBeNull();
      });
      delete window[GLOBAL_KEY];
    });

    test('a cyclic global does not hang the freeze', () => {
      const cyclic = { name: 'loop' };
      cyclic.self = cyclic;
      withGlobal({ Cyclic: cyclic }, (store) => {
        const value = store.getServerValue('Cyclic');
        expect(Object.isFrozen(value)).toBe(true);
        expect(value.self).toBe(value);
      });
    });
  });

  describe('the missing-key warning', () => {
    /**
     * A key absent from a snapshot the page *did* emit means the server
     * broke the contract: `registerHydrationState` is called once, at
     * server entry, before any render, and a registration that happens
     * later — from a module imported lazily inside a Suspense boundary —
     * is not supported. The markup still streams and still gets hydrated,
     * against the live client value, and mismatches. The warning names a
     * cause that is otherwise invisible from either side.
     *
     * The false-positive cases matter more than the warning does, which is
     * why each of them is pinned below.
     */
    function captureErrors(fn) {
      const calls = [];
      const spy = jest
        .spyOn(console, 'error')
        .mockImplementation((...args) => calls.push(args.join(' ')));
      try {
        fn();
      } finally {
        spy.mockRestore();
      }
      return calls;
    }

    test('warns once per key when the snapshot exists but lacks it', () => {
      withGlobal({ Dimensions: { window: { width: 360 } } }, (store) => {
        const calls = captureErrors(() => {
          store.getServerValue('Locale');
          store.getServerValue('Locale');
          store.getServerValue('Currency');
        });
        expect(calls).toHaveLength(2);
        expect(calls[0]).toContain('"Locale" was not registered');
        expect(calls[0]).toContain('registerHydrationState()');
        expect(calls[1]).toContain('"Currency" was not registered');
      });
    });

    test('is silent when no snapshot was emitted at all', () => {
      // The legitimate "not using the emitter" setup — `unstable_setForHydration`
      // or nothing — which must never be nagged.
      withGlobal(undefined, (store) => {
        expect(
          captureErrors(() => {
            store.getServerValue('Dimensions');
            store.getServerValue('Locale');
          })
        ).toEqual([]);
      });
    });

    test('is silent for a key supplied through setServerValue', () => {
      withGlobal({ Dimensions: { window: { width: 360 } } }, (store) => {
        store.setServerValue('Appearance', { colorScheme: 'dark' });
        expect(
          captureErrors(() => {
            store.getServerValue('Appearance');
          })
        ).toEqual([]);
      });
    });

    test('is silent for a key the snapshot does carry', () => {
      withGlobal({ Dimensions: { window: { width: 360 } } }, (store) => {
        expect(
          captureErrors(() => {
            store.getServerValue('Dimensions');
          })
        ).toEqual([]);
      });
    });

    test('a malformed global counts as no snapshot', () => {
      // Nothing was successfully parsed, so there is no basis for claiming
      // a key is missing from it.
      withGlobal('not json {{{', (store) => {
        expect(
          captureErrors(() => {
            store.getServerValue('Dimensions');
          })
        ).toEqual([]);
      });
    });
  });

  describe('the parse is a one-time step', () => {
    test('a global that arrives after the first read is ignored', () => {
      // The latch is the whole "frozen for the life of the page" promise.
      // A payload that turns up later belongs to some other render — a
      // second document written into the same realm, another script
      // claiming the global — and adopting it would move the value out
      // from under every boundary that has not hydrated yet, which is the
      // one failure this module exists to prevent.
      withGlobal(undefined, (store) => {
        expect(store.getServerValue('Appearance')).toBeNull();
        window[GLOBAL_KEY] = { Appearance: { colorScheme: 'dark' } };
        expect(store.getServerValue('Appearance')).toBeNull();
      });
    });
  });

  describe('setServerValue', () => {
    test('records a value and freezes it in place', () => {
      withGlobal(undefined, (store) => {
        const value = { colorScheme: 'dark' };
        store.setServerValue('Appearance', value);
        // The very same object, not a copy: the caller installs it as the
        // live value too, and sharing the reference is what keeps
        // `getSnapshot() === getServerSnapshot()` during a forced
        // hydration.
        expect(store.getServerValue('Appearance')).toBe(value);
        expect(Object.isFrozen(value)).toBe(true);
      });
    });

    test('the first write wins', () => {
      // The hazard this guards: by the time a second value could arrive,
      // boundaries have already hydrated against the first one.
      withGlobal(undefined, (store) => {
        store.setServerValue('Appearance', { colorScheme: 'dark' });
        store.setServerValue('Appearance', { colorScheme: 'light' });
        expect(store.getServerValue('Appearance').colorScheme).toBe('dark');
      });
    });

    test('a scalar is ignored', () => {
      withGlobal(undefined, (store) => {
        store.setServerValue('Appearance', 'dark');
        expect(store.getServerValue('Appearance')).toBeNull();
      });
    });

    test('the page global outranks a later setServerValue', () => {
      // Both describe the same render, so they should agree. When they do
      // not, the global is the one every boundary can see — including the
      // ones that hydrated before this call happened.
      withGlobal({ Appearance: { colorScheme: 'dark' } }, (store) => {
        store.setServerValue('Appearance', { colorScheme: 'light' });
        expect(store.getServerValue('Appearance').colorScheme).toBe('dark');
      });
    });

    test('a setServerValue before any read still survives the later parse', () => {
      // The lazy parse must not clobber a key that is already recorded for
      // a key the global does not carry.
      withGlobal({ Dimensions: { window: { width: 360 } } }, (store) => {
        store.setServerValue('Appearance', { colorScheme: 'light' });
        expect(store.getServerValue('Dimensions').window.width).toBe(360);
        expect(store.getServerValue('Appearance').colorScheme).toBe('light');
      });
    });
  });
});
