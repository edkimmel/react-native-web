/**
 * The shared app, following the end-to-end example in STREAMING-SSR.md.
 */

import { Suspense, lazy, useEffect } from 'react';
import { Text, View } from '@edkimmel/react-native-web';
import {
  useColorScheme,
  useWindowDimensions
} from '@edkimmel/react-native-web';
import { shellStyles } from './shellStyles.js';

// Rendered only after the boundary resolves, so on a cold process its CSS is
// compiled after <head> has already been streamed.
const Details = lazy(() => import('./Details.js'));

function ShellDeviceText() {
  const { height, width } = useWindowDimensions();
  const colorScheme = useColorScheme();
  return (
    <Text id="shell-hooks">{`shell:${width}x${height}:${colorScheme}`}</Text>
  );
}

function ShellStaticText() {
  return <Text id="shell-hooks">shell:static</Text>;
}

export default function App(props) {
  useEffect(() => {
    // Root-hydration signal for the specs. An effect, so it fires once the
    // root has committed.
    window.__APP_MOUNTED__ = (window.__APP_MOUNTED__ || 0) + 1;
  });

  return (
    <View id="page" style={shellStyles.page}>
      <View
        dataSet={{
          expectBg: 'rgb(0, 128, 255)',
          expectPl: '0px',
          expectPt: '0px'
        }}
        id="shell-probe"
        style={shellStyles.banner}
      >
        {/* `?shellHooks=1` puts the device hooks ABOVE the Suspense
            boundary as well. That is a different and much harsher test —
            see progressiveHydration.spec.js. */}
        {props.shellHooks ? <ShellDeviceText /> : <ShellStaticText />}
      </View>
      <Suspense
        fallback={
          <Text id="fallback" style={shellStyles.fallback}>
            Loading…
          </Text>
        }
      >
        <Details {...props} />
      </Suspense>
    </View>
  );
}
