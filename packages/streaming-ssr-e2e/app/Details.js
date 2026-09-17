/**
 * The contents of the late Suspense boundary.
 *
 * Loaded through `React.lazy`, so on a cold process its module-scope work
 * happens after <head> is already on the wire; and gated by `boundaryGate`,
 * so it resolves late on *every* request, not just the first.
 */

import { StyleSheet, Text, View } from '@edkimmel/react-native-web';
import {
  useColorScheme,
  useWindowDimensions
} from '@edkimmel/react-native-web';
import { boundaryGate } from './gate.js';
import { shellStyles } from './shellStyles.js';

export default function Details(props) {
  // Suspends. Everything below runs only on the retry, after <head> and the
  // shell stylesheet have been flushed.
  boundaryGate();

  const { height, width } = useWindowDimensions();
  const colorScheme = useColorScheme();

  if (typeof document !== 'undefined') {
    // Render-phase instrumentation, on purpose. The FIRST entry pushed here
    // is this boundary's hydration render, and that is the only place the
    // `getServerSnapshot` behaviour is observable: by the time an effect
    // could run, useSyncExternalStore has already reconciled to the live
    // value. Nothing renders in StrictMode here, so there is no double push.
    const log = (window.__DETAIL_RENDERS__ = window.__DETAIL_RENDERS__ || []);
    log.push(`late:${width}x${height}:${colorScheme}`);
  }

  // Compiled DURING the boundary render, and with values that are unique to
  // this request. That is what keeps this test honest across page loads:
  // the delta is derived from the sheet's revision log, so a rule some
  // earlier request already inserted would arrive in *this* request's shell
  // instead of in a delta, and the cascade test would stop testing anything.
  const lateStyles = StyleSheet.create({
    // Group 2 shorthand. Cascade bait, half two — see shellStyles.js.
    box: { padding: props.pad },
    // Group 3. The FOUC probe for the late chunk.
    tint: { backgroundColor: props.tint }
  });

  return (
    <View id="late" style={lateStyles.tint}>
      <View
        dataSet={{
          expectBg: props.tint,
          expectPl: `${props.pad}px`,
          expectPt: '40px'
        }}
        id="late-probe"
        style={[lateStyles.box, lateStyles.tint, shellStyles.latePaddingTop]}
      >
        <Text id="late-hooks">{`late:${width}x${height}:${colorScheme}`}</Text>
      </View>
    </View>
  );
}
