/**
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  getProcessState,
  getScopedState,
  hasRequestScope,
  runInRequestScope
} from '../index.browser';

// jsdom: `canUseDOM` is true, so this is the ordinary client case. The
// browser build has no AsyncLocalStorage and must stay a silent no-op
// singleton store — the historical behavior of RNW's module-level `let`s.
describe('modules/asyncContext browser build in the browser', () => {
  test('runInRequestScope is a silent pass-through', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(runInRequestScope(() => 'ran')).toBe('ran');
    expect(hasRequestScope()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('state is a process singleton inside and outside runInRequestScope', () => {
    const outside = getScopedState('singleton', () => ({ v: 0 }));
    outside.v = 7;
    runInRequestScope(() => {
      const inside = getScopedState('singleton', () => ({ v: 0 }));
      expect(inside).toBe(outside);
      inside.v = 8;
    });
    expect(outside.v).toBe(8);
    expect(getProcessState('singleton', () => ({ v: 0 }))).toBe(outside);
  });
});
