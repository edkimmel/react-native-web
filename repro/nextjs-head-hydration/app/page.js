import { headers } from 'next/headers';
import { parseScenario } from './_shared/scenario';

export default async function Page() {
  const h = await headers();
  const search = h.get('x-probe-search') || '';
  const config = parseScenario(search);

  return (
    <main data-probe-anchor="content">
      <h1>nextjs-head-hydration probe</h1>
      <p>
        scenario=<code>{config.scenario}</code> position=
        <code>{config.position}</code>
      </p>
      <ul>
        <li>a = &lt;style&gt; in head, between/after anchors</li>
        <li>b = &lt;script&gt; in body (mimics Next flight push)</li>
        <li>c = &lt;style&gt; in body</li>
        <li>d = &lt;script&gt; in head, between/after anchors</li>
        <li>e = control: React-owned style via useServerInsertedHTML</li>
        <li>f = control: React 19 &lt;style precedence&gt;</li>
      </ul>
      {config.usePrecedence && (
        <style
          data-probe-precedence="f"
          href="probe-precedence-f"
          // eslint-disable-next-line react/no-unknown-property -- React 19 stylesheet hoisting
          precedence="probe"
        >
          {'/* scenario F: React 19 hoisted stylesheet resource */'}
        </style>
      )}
    </main>
  );
}
