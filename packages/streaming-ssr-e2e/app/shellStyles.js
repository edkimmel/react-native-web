/**
 * Styles compiled at module scope, i.e. while the server process boots and
 * long before any request. Everything here is therefore in the *shell*
 * stylesheet of every response.
 */

import { StyleSheet } from '@edkimmel/react-native-web';

export const shellStyles = StyleSheet.create({
  page: {
    backgroundColor: 'rgb(250, 250, 250)',
    minHeight: 400,
    padding: 16
  },
  // The FOUC probe for the shell. If the shell stylesheet were emitted after
  // the markup it styles, this element would paint at least one frame with a
  // transparent background and auto height.
  banner: {
    backgroundColor: 'rgb(0, 128, 255)',
    height: 64
  },
  fallback: {
    backgroundColor: 'rgb(255, 235, 59)',
    height: 32
  },
  // CASCADE BAIT, half one.
  //
  // `paddingTop` is a longhand: the compiler files it in group 3. It is
  // compiled here, so it travels in the shell and its <style> anchor is in
  // <head> from the first byte.
  //
  // The other half lives in Details.js: a `padding` *shorthand*, group 2,
  // compiled during the boundary render and therefore delivered in a
  // post-shell delta. Both classes land on the same element. Correct
  // behaviour is that the longhand still wins, which is only true if the
  // delta was relocated into <head> behind the group-2 anchor — i.e. above
  // the group-3 anchor. Left in <body> it would come last and win.
  latePaddingTop: {
    paddingTop: 40
  }
});
