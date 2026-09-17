import { headers } from 'next/headers';
import { parseScenario, buildInstrumentationScript } from './_shared/scenario';
import HydrationMarker from './_shared/HydrationMarker';
import ServerInsertedStyle from './_shared/ServerInsertedStyle';

// A single root layout renders the WHOLE document (<html>/<head>/<body>) so
// that `hydrateRoot(document, …)` (App Router's own entry point, see
// packages/next/src/client/app-index.tsx) owns everything, exactly like the
// consumer app this is modeling. Which probe scenario to set up is decided
// per-request from `?scenario=&position=`, forwarded here by middleware.js
// as a header because layouts do not receive `searchParams`.
export default async function RootLayout({ children }) {
  const h = await headers();
  const search = h.get('x-probe-search') || '';
  const config = parseScenario(search);
  const instrumentation = buildInstrumentationScript(config);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{`probe:${config.scenario}/${config.position}`}</title>
        {/* Sibling anchors, standing in for our per-priority-bucket <style>
            anchors in the real react-native-web streaming fork. */}
        {/* Deliberately empty: real per-priority-bucket anchors carry no
            rules of their own, just a stable place to insert next to. Empty
            <style> tags are also textually indistinguishable from each
            other during hydration, which is exactly what lets a same-tag
            foreign node get silently misbound instead of hard-erroring on
            a text mismatch (see FINDINGS.md). */}
        <style data-probe-anchor="0" />
        <style data-probe-anchor="1" />
        <style data-probe-anchor="2" />
        <style data-probe-anchor="3" />
        {config.useServerInserted && <ServerInsertedStyle />}
      </head>
      <body>
        <div data-probe-anchor="b0">body probe 0</div>
        <div data-probe-anchor="b1">body probe 1</div>
        <div data-probe-anchor="b2">body probe 2</div>
        {children}
        <HydrationMarker />
        {/*
          Runs LAST: every anchor/probe above is already present in the DOM
          by the time an inline, non-deferred <script> this far down the
          document is reached during synchronous HTML parsing - long before
          Next's own hydration bundle (loaded via deferred/async <script
          src>, see tests/probe.spec.js which additionally throttles it)
          gets to call hydrateRoot(). This is the "inline script that moves
          a node before hydration" from the real bug, boiled down to its
          essence: a plain DOM mutation React's SSR pass never knew about.
        */}
        <script
          dangerouslySetInnerHTML={{ __html: instrumentation }}
          data-probe-instrumentation="true"
          suppressHydrationWarning
        />
      </body>
    </html>
  );
}
