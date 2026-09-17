/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The server half: the registry and the `<script>` it emits.
 *
 * Node environment, not jsdom, because everything interesting here is
 * server-only — `Dimensions.set` and `Appearance.set` refuse to run in a
 * browser realm, and request scoping needs `AsyncLocalStorage`.
 *
 * Each test gets a fresh module registry: the registry of sources is
 * module state, and the built-ins register themselves into it when the
 * module is evaluated.
 */

function load() {
  jest.resetModules();
  const hydrationState = require('..');
  return {
    Appearance: require('../../../exports/Appearance'),
    Dimensions: require('../../../exports/Dimensions'),
    registerHydrationState: hydrationState.registerHydrationState,
    runInRequestScope: require('../../asyncContext').runInRequestScope,
    takeHydrationStateHTML: hydrationState.takeHydrationStateHTML
  };
}

// The payload is written as an object literal, so parsing it back is the
// honest way to assert on it — and it also proves the literal is valid JS.
function payloadOf(html) {
  const body = html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  // eslint-disable-next-line no-new-func
  return new Function(
    `var window={};${body};return window.__RNW_HYDRATION__;`
  )();
}

const VIEWPORT = { fontScale: 1, height: 800, scale: 2, width: 360 };

describe('modules/hydrationState emitter', () => {
  test('emits a script assigning the documented shape', () => {
    const {
      Appearance,
      Dimensions,
      runInRequestScope,
      takeHydrationStateHTML
    } = load();

    const html = runInRequestScope(() => {
      Dimensions.set({ screen: VIEWPORT, window: VIEWPORT });
      Appearance.set({ colorScheme: 'dark' });
      return takeHydrationStateHTML();
    });

    expect(html.startsWith('<script>window.__RNW_HYDRATION__=')).toBe(true);
    expect(html.endsWith('</script>')).toBe(true);
    expect(payloadOf(html)).toEqual({
      Appearance: { colorScheme: 'dark' },
      Dimensions: { screen: VIEWPORT, window: VIEWPORT }
    });
  });

  test('reads through the public API, so a request scope is picked up', () => {
    const { Dimensions, runInRequestScope, takeHydrationStateHTML } = load();
    // Outside any scope the process default is emitted, unchanged by what
    // a request did.
    const outside = payloadOf(takeHydrationStateHTML());
    expect(outside.Dimensions.window.width).toBe(0);

    runInRequestScope(() => {
      Dimensions.set({ screen: VIEWPORT, window: VIEWPORT });
    });
    expect(payloadOf(takeHydrationStateHTML()).Dimensions.window.width).toBe(0);
  });

  test('concurrent scopes each emit their own values', async () => {
    // The cross-request leak this whole mechanism would otherwise create:
    // one user's viewport and theme frozen into another user's page.
    const {
      Appearance,
      Dimensions,
      runInRequestScope,
      takeHydrationStateHTML
    } = load();

    const requests = [
      { colorScheme: 'dark', width: 360 },
      { colorScheme: 'light', width: 1280 }
    ];

    const emitted = await Promise.all(
      requests.map(({ colorScheme, width }) =>
        runInRequestScope(async () => {
          const metrics = { fontScale: 1, height: 800, scale: 1, width };
          Dimensions.set({ screen: metrics, window: metrics });
          Appearance.set({ colorScheme });
          // Yield, so the two scopes interleave between the writes and the
          // read rather than running to completion one after the other.
          await Promise.resolve();
          return payloadOf(takeHydrationStateHTML());
        })
      )
    );

    expect(emitted[0].Dimensions.window.width).toBe(360);
    expect(emitted[0].Appearance.colorScheme).toBe('dark');
    expect(emitted[1].Dimensions.window.width).toBe(1280);
    expect(emitted[1].Appearance.colorScheme).toBe('light');
  });

  test('applies and escapes a nonce', () => {
    const { takeHydrationStateHTML } = load();
    expect(takeHydrationStateHTML({ nonce: 'abc123' })).toContain(
      '<script nonce="abc123">'
    );
    // `&` is in the hostile value deliberately. It has to be replaced FIRST
    // or every other escape is itself re-escaped, and a nonce is base64 in
    // practice, so nothing else in the suite would ever carry one.
    expect(
      takeHydrationStateHTML({ nonce: 'a&"><script>alert(1)</script>' })
    ).toContain(
      '<script nonce="a&amp;&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">'
    );
    expect(takeHydrationStateHTML({ nonce: 'a&b' })).not.toContain('&amp;amp;');
  });

  test('an empty nonce emits no attribute at all', () => {
    // `nonce=""` is not "no nonce": a `script-src 'nonce-...'` policy
    // rejects an empty one, so a caller whose nonce is unset must get
    // markup with no attribute rather than markup with an empty one.
    const { takeHydrationStateHTML } = load();
    expect(takeHydrationStateHTML({ nonce: '' })).toMatch(/^<script>/);
    expect(takeHydrationStateHTML({ nonce: null })).toMatch(/^<script>/);
  });

  test('U+2028 and U+2029 in a value cannot terminate the statement', () => {
    // The payload is a JS object literal, not a parsed JSON string.
    // `JSON.stringify` leaves these two raw because they are legal inside a
    // JSON string, but before ES2019 they were line terminators in
    // JavaScript — a raw one ends `window.__RNW_HYDRATION__ = {...` early
    // and the remainder is a syntax error that takes the whole inline
    // script down.
    const { registerHydrationState, takeHydrationStateHTML } = load();
    registerHydrationState('Sep', () => ({ value: 'a\u2028b\u2029c' }));

    const html = takeHydrationStateHTML();
    expect(html).not.toContain('\u2028');
    expect(html).not.toContain('\u2029');
    expect(html).toContain('a\\u2028b\\u2029c');

    // ...and it is still the same string on the other side.
    const source = html.slice(html.indexOf('>') + 1, html.lastIndexOf('<'));
    const scope = {};
    // eslint-disable-next-line no-new-func
    new Function('window', source)(scope);
    expect(scope.__RNW_HYDRATION__.Sep.value).toBe('a\u2028b\u2029c');
  });

  test('a value containing </script> cannot break out of the tag', () => {
    // The injection this escaping exists for: a user-controlled string
    // reaching a registered source. `<` is escaped throughout, which closes
    // both `</script` and `<!--` at once.
    const { registerHydrationState, takeHydrationStateHTML } = load();
    registerHydrationState('Evil', () => ({
      value: '</script><script>window.pwned=1</script><!--'
    }));

    const html = takeHydrationStateHTML();
    // Exactly one script element, and no raw `<` anywhere in the payload.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('\\u003c/script>');
    // ...and it still round-trips to the original string.
    expect(payloadOf(html).Evil.value).toBe(
      '</script><script>window.pwned=1</script><!--'
    );
  });
});

describe('modules/hydrationState registry', () => {
  test('a consumer key is emitted alongside the built-ins', () => {
    const {
      registerHydrationState,
      runInRequestScope,
      takeHydrationStateHTML
    } = load();
    const { getScopedState } = require('../../asyncContext');

    // The shape a downstream SSR helper actually has: its own per-request
    // state behind the same scope, with the same hydration problem.
    registerHydrationState('Locale', () => ({
      locale: getScopedState('Locale', () => ({ locale: 'en' })).locale
    }));

    const html = runInRequestScope(() => {
      getScopedState('Locale', () => ({ locale: 'en' })).locale = 'fr';
      return takeHydrationStateHTML();
    });

    const payload = payloadOf(html);
    expect(payload.Locale).toEqual({ locale: 'fr' });
    expect(payload.Dimensions).toBeDefined();
  });

  test('registration order is preserved, built-ins first', () => {
    const { registerHydrationState, takeHydrationStateHTML } = load();
    registerHydrationState('Zebra', () => ({ z: 1 }));
    expect(Object.keys(payloadOf(takeHydrationStateHTML()))).toEqual([
      'Dimensions',
      'Appearance',
      'Zebra'
    ]);
  });

  test('a duplicate key keeps the first source and reports an error', () => {
    const { registerHydrationState, takeHydrationStateHTML } = load();
    registerHydrationState('Locale', () => ({ locale: 'first' }));

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registerHydrationState('Locale', () => ({ locale: 'second' }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('twice for the key "Locale"');
    } finally {
      spy.mockRestore();
    }

    expect(payloadOf(takeHydrationStateHTML()).Locale.locale).toBe('first');
  });

  test('re-registering a built-in key is refused', () => {
    const { registerHydrationState, takeHydrationStateHTML } = load();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      registerHydrationState('Dimensions', () => ({ hijacked: true }));
    } finally {
      spy.mockRestore();
    }
    expect(payloadOf(takeHydrationStateHTML()).Dimensions.window).toBeDefined();
  });

  test('a bad registration is rejected outright', () => {
    // Not a dev-only warning: there is no useful degraded behavior for a
    // source that cannot be called, and this happens at server start.
    const { registerHydrationState } = load();
    expect(() => registerHydrationState('', () => ({}))).toThrow(
      'non-empty string key'
    );
    expect(() => registerHydrationState('X', null)).toThrow('read() function');
  });

  test('a source that throws costs only its own key', () => {
    // The judgement call: skip the key, keep the response. Every key is
    // independently optional — a missing one falls back to the live client
    // value, which is the pre-existing behavior — whereas aborting the
    // emission would turn one consumer's bug into a page-wide hydration
    // mismatch for subsystems that were working, halfway through a
    // response that is already on the wire.
    const { registerHydrationState, takeHydrationStateHTML } = load();
    registerHydrationState('Broken', () => {
      throw new Error('boom');
    });
    registerHydrationState('Fine', () => ({ ok: true }));

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let html;
    try {
      html = takeHydrationStateHTML();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('"Broken" threw');
    } finally {
      spy.mockRestore();
    }

    const payload = payloadOf(html);
    expect(payload.Broken).toBeUndefined();
    expect(payload.Fine).toEqual({ ok: true });
    expect(payload.Dimensions).toBeDefined();
  });

  test('a source returning a scalar is skipped and reported', () => {
    // The client store only records object-shaped entries, so a scalar
    // would be silently dropped there instead. Rejecting it here keeps the
    // wire and the store agreeing, and says so out loud.
    const { registerHydrationState, takeHydrationStateHTML } = load();
    registerHydrationState('Scalar', () => 42);

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let html;
    try {
      html = takeHydrationStateHTML();
      expect(spy.mock.calls[0][0]).toContain('returned a non-object');
    } finally {
      spy.mockRestore();
    }
    expect(payloadOf(html).Scalar).toBeUndefined();
  });

  test('only what is registered when it is called gets emitted', () => {
    // Documented degradation for a consumer that registers from a lazily
    // imported module: absent from that response's snapshot, and its
    // client side falls back to the live value.
    const { registerHydrationState, takeHydrationStateHTML } = load();
    const before = payloadOf(takeHydrationStateHTML());
    expect(before.Late).toBeUndefined();

    registerHydrationState('Late', () => ({ late: true }));
    expect(payloadOf(takeHydrationStateHTML()).Late).toEqual({ late: true });
  });
});
