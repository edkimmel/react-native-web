/**
 * The whole document through React, with `<head>` itself inside the stream.
 *
 * This is the shape `/document` cannot express. There the style anchors come
 * from a `StyleSheet.takeShellGroups()` snapshot the server takes *before* the
 * render and passes down as a prop — which is only possible while `<head>` is
 * static. Put a Suspense boundary in `<head>` (or above it) and the anchors
 * have to be React elements that render whenever that boundary resolves, so
 * the snapshot has to be taken by the element itself. That is
 * `<StyleSheet.Anchors />`.
 *
 * Three shapes, so the specs can separate what the design guarantees from
 * what merely happens to work:
 *
 *   anchors=shell   `<head>` contains a Suspense boundary, but the anchors
 *                   are rendered above it, in the part of `<head>` that goes
 *                   out with the shell. The RECOMMENDED shape: the anchors
 *                   are in the first flush, so RNW's client sheet finds them
 *                   when it boots and creates none of its own.
 *   anchors=late    the anchors are INSIDE the boundary, so they do not exist
 *                   until it resolves — which, on both majors, is after the
 *                   client bundle has already booted RNW. The hard case.
 *   above=1         the boundary is above `<head>`: the whole `<html>`
 *                   element comes out of it. React >= 19.1's Suspense-aware
 *                   preamble withholds the entire response until it resolves,
 *                   so `<head>` is complete before any byte goes out.
 *
 * Nothing here passes the shell down as a prop, on either side — which is the
 * other half of the point. The server's anchors come from the component's own
 * render; the client's come from the anchors already in the document. The two
 * agree byte for byte because `insertRule` never writes back to an element's
 * text, so whatever a streamed chunk inserted is invisible to `innerHTML`.
 */

import { Suspense } from 'react';
import { StyleSheet } from '@edkimmel/react-native-web';
import App from './App.js';
import { boundaryGate } from './gate.js';

// The contents of the head boundary. `<meta>` rather than a comment so a spec
// can assert the segment actually arrived, and so the anchors have a
// React-owned non-style sibling next to them when they are in here too.
function LateHeadContent(props) {
  boundaryGate('head');
  return (
    <>
      <meta content="1" name="rnw-late-head" />
      {props.anchors ? <StyleSheet.Anchors /> : null}
    </>
  );
}

function DocumentShell(props) {
  const lateAnchors = props.anchorMode !== 'shell';
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width" name="viewport" />
        <title>RNW streaming SSR e2e (streaming head)</title>
        {/* Both inline scripts are passed as source text so the client can
            reproduce them byte for byte; see DocumentApp.js. */}
        <script dangerouslySetInnerHTML={{ __html: props.hydrationJs }} />
        <script dangerouslySetInnerHTML={{ __html: props.bootstrapJs }} />
        {lateAnchors ? null : <StyleSheet.Anchors />}
        {props.above ? (
          // The boundary is above us, so by the time anything renders here it
          // has already resolved: this is a plain child of <head>.
          <LateHeadContent anchors={lateAnchors} />
        ) : (
          <Suspense fallback={null}>
            <LateHeadContent anchors={lateAnchors} />
          </Suspense>
        )}
      </head>
      <body>
        <div id="root">
          <App {...props.appProps} />
        </div>
      </body>
    </html>
  );
}

function LateDocument(props) {
  boundaryGate('document');
  return <DocumentShell {...props} />;
}

export default function StreamingHeadApp(props) {
  if (props.above) {
    // No fallback markup: a fallback for a boundary that owns <html> would
    // have to be a whole second document. `null` is what a real app would
    // use, and it is also what makes React's preamble the only thing
    // deciding when the first byte goes out.
    return (
      <Suspense fallback={null}>
        <LateDocument {...props} />
      </Suspense>
    );
  }
  return <DocumentShell {...props} />;
}
