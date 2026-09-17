// Everything the Node server needs out of the app bundle.
//
// React, react-dom/server and the library itself are re-exported from here
// rather than `require`d by server.js so that ONE esbuild resolution
// decides which copy of React the whole process uses. In the default build
// all three are `external`, so Node resolves them itself and the server
// runs against `dist/cjs` exactly as a consumer would; with
// `E2E_REACT_DIR` set they are bundled through an esbuild alias instead,
// and the server, the app and the library all get the same aliased React.
export * as rnw from '@edkimmel/react-native-web';
// The server-only half of the SSR surface — the stream transform, the
// hydration payload, the scope accessors — lives behind its own entry point
// so it never reaches a browser bundle. `build.js` keeps this external too,
// or the server would end up with a second copy of the library's state.
export * as rnwServer from '@edkimmel/react-native-web/server';
export { default as React } from 'react';
export { renderToPipeableStream } from 'react-dom/server';
export { default as App } from './App.js';
export { default as DocumentApp } from './DocumentApp.js';
export { default as StreamingHeadApp } from './StreamingHeadApp.js';
export { setRequestDelay } from './gate.js';
