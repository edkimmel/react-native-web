/**
 * The whole document, rendered through React, for the `/document` route.
 *
 * This is the configuration STREAMING-SSR.md lists as unverified: React owns
 * <head>, and the relocation script mutates that same <head> before
 * `hydrateRoot(document, …)` ever runs.
 *
 * The head children have to be reconstructible on the client byte for byte,
 * which is why the two inline scripts are passed in as source text and the
 * style anchors as `[group, cssText]` pairs. The client entry rebuilds both
 * from the document itself; see client.js.
 */

import App from './App.js';

export default function DocumentApp(props) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta content="width=device-width" name="viewport" />
        <title>RNW streaming SSR e2e (document)</title>
        {/* The hydration snapshot. `takeHydrationStateHTML()` returns a
            complete <script> tag; a React-rendered document needs the inner
            source instead, so the server unwraps it. */}
        <script dangerouslySetInnerHTML={{ __html: props.hydrationJs }} />
        <script dangerouslySetInnerHTML={{ __html: props.bootstrapJs }} />
        {/* The shell: one anchor per compiler group, ascending, empty groups
            included. These are what the streamed deltas relocate against. */}
        {props.styles.map(([group, css]) => (
          <style
            dangerouslySetInnerHTML={{ __html: css }}
            data-rnw-group={group}
            key={group}
          />
        ))}
      </head>
      <body>
        <div id="root">
          <App {...props.appProps} />
        </div>
      </body>
    </html>
  );
}
