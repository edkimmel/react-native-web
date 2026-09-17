/**
 * The client entry, bundled by esbuild with `platform: 'browser'` so the
 * `browser` field map in the package's package.json is honoured.
 */

import {
  Appearance,
  AppRegistry,
  Dimensions
} from '@edkimmel/react-native-web';
// The server entry point, imported ON PURPOSE from the browser bundle: the
// `browser` field map is what makes it safe, and spec 5 exists to prove it
// still is. `react-native-web/server` resolves through the checked-in
// `server/package.json` directory shim.
import { createStyleInjectionTransform } from '@edkimmel/react-native-web/server';
import { hydrateRoot } from 'react-dom/client';
import App from './App.js';
import DocumentApp from './DocumentApp.js';
import StreamingHeadApp from './StreamingHeadApp.js';

const config = window.__E2E__;

// For the "no Node builtins in the browser bundle" spec: this is the browser
// build of the streaming adapter, which exists only to throw.
window.__RNW_STREAMING_ADAPTER__ = createStyleInjectionTransform;

// So specs can read the LIVE device values and show they differ from the
// frozen server snapshot the boundaries hydrate against.
window.__RNW__ = { Appearance, Dimensions };

function serializeConfig(value) {
  // Must match the server byte for byte, or React reports a mismatch on the
  // <script> that carries it. JSON round-trips key order for string keys.
  return `window.__E2E__=${JSON.stringify(value).replace(/</g, '\\u003c')}`;
}

function readShellGroups(groups) {
  return groups.map((group) => {
    const anchor = document.querySelector(
      `style[data-rnw-group="${group}"]:not([data-rnw-delta])`
    );
    return [group, anchor == null ? '' : anchor.innerHTML];
  });
}

if (config.route === 'streaming-head') {
  // Deliberately NO `styles` prop, and no `config.groups`: on this route
  // the anchors are `<StyleSheet.Anchors />`'s own business on both sides.
  // The server reads the sheet during its render; the client reads the
  // anchors already in the document. Handing the client a snapshot would
  // hide the thing under test.
  window.__DOC_ROOT__ = hydrateRoot(
    document,
    <StreamingHeadApp
      above={config.above}
      anchorMode={config.anchorMode}
      appProps={config.appProps}
      bootstrapJs={serializeConfig(config)}
      hydrationJs={config.hydrationJs}
    />
  );
} else if (config.route === 'document') {
  // Kept on window so a spec can unmount and see which DOM nodes React
  // believes it owns.
  window.__DOC_ROOT__ = hydrateRoot(
    document,
    <DocumentApp
      appProps={config.appProps}
      bootstrapJs={serializeConfig(config)}
      hydrationJs={config.hydrationJs}
      styles={readShellGroups(config.groups)}
    />
  );
} else {
  AppRegistry.registerComponent('App', () => App);
  AppRegistry.runApplication('App', {
    hydrate: true,
    initialProps: config.appProps,
    rootTag: document.getElementById('root')
  });
}

window.__E2E_CLIENT_STARTED__ = true;
