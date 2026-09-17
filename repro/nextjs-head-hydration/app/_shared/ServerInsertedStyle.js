'use client';

import { useServerInsertedHTML } from 'next/navigation';

// Scenario E control: content that lands in <head> via React's OWN
// mechanism (the same hook styled-components/Next's CSS-in-JS guide uses),
// not via out-of-band DOM manipulation. React knows about this node - it
// should never desync the sibling walk.
export default function ServerInsertedStyle() {
  useServerInsertedHTML(() => (
    <style data-probe-serverinserted="e" key="probe-server-inserted">
      {`/* scenario E: React-owned, inserted via useServerInsertedHTML */`}
    </style>
  ));
  return null;
}
