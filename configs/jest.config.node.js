'use strict';

const babelConfig = require('./babel.config.js');

module.exports = {
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/packages/react-native-web/src/vendor/'
  ],
  fakeTimers: {
    enableGlobally: true,
    // React 19's `react-dom/server` Node build binds the microtask scheduler
    // once, at module evaluation: `scheduleMicrotask = queueMicrotask`, which
    // `startWork` then uses to schedule the very first render pass. Because
    // `import` is hoisted above any `jest.useRealTimers()` in a test body,
    // the module captures Sinon's fake `queueMicrotask` and the real-timer
    // call cannot reach the captured binding — Fizz never starts and every
    // streaming test hangs to its timeout. React 18 looked `setImmediate` up
    // through the global on each call, which is why `useRealTimers()` used to
    // be sufficient on its own. Leaving `queueMicrotask` real costs the fake
    // clock nothing: no test schedules or asserts on a microtask.
    //
    // The jsdom config deliberately does NOT need this. React 18's client
    // build captures `queueMicrotask` in the same way, so nothing changed
    // there, and that suite passes on both versions.
    doNotFake: ['queueMicrotask']
  },
  modulePathIgnorePatterns: [
    '<rootDir>/packages/benchmarks/',
    '<rootDir>/packages/react-native-web-docs/',
    '<rootDir>/packages/react-native-web-examples/',
    '<rootDir>/packages/react-native-web/dist/'
  ],
  rootDir: process.cwd(),
  roots: ['<rootDir>/packages'],
  snapshotFormat: {
    printBasicPrototype: false
  },
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/?(*-)+(spec|test).node.[jt]s?(x)'],
  transform: {
    '\\.[jt]sx?$': ['babel-jest', babelConfig()]
  }
};
