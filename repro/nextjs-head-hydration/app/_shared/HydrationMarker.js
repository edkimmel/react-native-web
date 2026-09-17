'use client';

import { useEffect } from 'react';

// Module top-level: runs the instant this client chunk is evaluated by the
// browser, i.e. as early as the client JS is running at all (well before
// hydrateRoot's own commit phase, though after any deferred bundle fetch).
if (typeof window !== 'undefined') {
  window.__PROBE = window.__PROBE || {};
  window.__PROBE.bundleEvalAt = performance.now();

  window.addEventListener('error', function (e) {
    window.__PROBE.log = window.__PROBE.log || [];
    window.__PROBE.log.push(
      'pageerror: ' + (e.error ? e.error.message : e.message)
    );
  });
}

export default function HydrationMarker() {
  useEffect(() => {
    window.__PROBE = window.__PROBE || {};
    window.__PROBE.hydratedAt = performance.now();
    window.__PROBE.hydrated = true;
  }, []);

  return null;
}
