# This fork

`@edkimmel/react-native-web` is a fork of [React Native Web](https://necolas.github.io/react-native-web/) that adds streaming-SSR and React Suspense support.

Upstream RNW compiles CSS at runtime into one process-wide sheet that is serialised once, after the render finishes. Under `renderToPipeableStream` that breaks twice over: a Suspense boundary resolving after `</head>` is on the wire compiles rules that have nowhere to go, and concurrent renders interleave through the same module-level state. This fork fixes both.

**[Streaming SSR guide and API reference →](./STREAMING-SSR.md)**

What it adds:

- **Per-request scoping.** `runInRequestScope(fn)` wraps each SSR render so the CSS delta buffer, `Dimensions` and `Appearance` are isolated per request. `configureRequestScope({ AsyncLocalStorage })` is required on non-Node server runtimes. `getScopedState` / `getProcessState` / `hasRequestScope`, from `react-native-web/server`, let downstream SSR helpers use the same scope.
- **A streaming stylesheet.** The server sheet streams as a shell — one `<style data-rnw-group="G">` per compiler group — followed by per-chunk deltas, each a single self-removing inline `<script>` that inserts its rules into the anchors' CSSOM at parse time and leaves no DOM node behind, so late Suspense boundaries arrive styled instead of causing a FOUC and `hydrateRoot(document, …)` still sees exactly the DOM React rendered. Exposed as `StyleSheet.takeShellHTML()` / `takeDeltaHTML()` / `takeShellGroups()`, as [`<StyleSheet.Anchors />`](./STREAMING-SSR.md#stylesheet-anchors) for a `<head>` that is itself inside the stream — which works from React 18.3.1 up, except for a boundary _above_ `<html>`/`<head>`, which needs **React >= 19.1** — and as `AppRegistry.getApplication().getStyleElements()`.
- **One call for the whole server side.** `renderToStreamingResponse({ element, response, head, … })`, from `react-native-web/server`, opens the request scope, applies this request's device state, assembles the document around the stylesheet shell and the hydration snapshot, and pipes React into the response in the order the transform needs — so the orderings that fail silently are not the caller's to get right. See the [quickstart](./STREAMING-SSR.md#quickstart).
- **A ready-made adapter.** Underneath it, `createStyleInjectionTransform({ prelude, epilogue, nonce })` returns a Node `stream.Transform` to pipe `renderToPipeableStream` through. Reach for it directly when React renders `<html>`/`<head>` itself, or when your framework owns the response.
- **Per-request device state, with a hydration snapshot.** `Dimensions.set()` and `Appearance.set({ colorScheme })` on the server, and `react-native-web/server`'s `takeHydrationStateHTML()` to carry those values to the client as a `<script>`. `useWindowDimensions` and `useColorScheme` are built on `useSyncExternalStore`, so every Suspense boundary hydrates against the value the server rendered with, however late it hydrates. `registerHydrationState()` adds your own state to the same snapshot.
- Support for latest StyleX.
- A virtualization fix for lists with very large footers.

Only `runInRequestScope` and `configureRequestScope` are added to the top-level barrel; everything that runs on the server rather than in the tree is behind `react-native-web/server`, and the rest hangs off the API it belongs to (`StyleSheet.Anchors`, `Dimensions.unstable_hydrationStore`).

Everything is additive: an app that never calls these APIs behaves exactly as upstream does.

**React 18.3.1 and every React 19 are supported. One shape has a higher floor: a Suspense boundary _above_ `<html>`/`<head>` needs React >= 19.1**, because it relies on Fizz's Suspense-aware preamble, which shipped in 19.1.0 and is in no 19.0.x release. A boundary _inside_ `<head>` needs no such thing and works from 18.3.1 up.

Green in a real browser on all five of 18.3.1, 19.0.0, 19.1.1, 19.2.0 and 19.3.0 — 32 Playwright specs on Chromium covering the cascade in a live CSSOM, a per-painted-frame FOUC audit, hydration against the server snapshot, `hydrateRoot(document, …)` over a React-rendered `<head>`, and a `<head>` that is itself inside the stream. Rerun it yourself with `npm run e2e:matrix:all` from `packages/streaming-ssr-e2e/`; the runner reads the React that actually ran back out of the run output, so a green row cannot describe a version the harness quietly did not use. See [React version support](./STREAMING-SSR.md#react-version-support) and [real-browser coverage](./STREAMING-SSR.md#real-browser-coverage) for what that does and does not cover.

# React Native for Web

[![npm version][package-badge]][package-url] [![Build Status][ci-badge]][ci-url] [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://reactjs.org/docs/how-to-contribute.html#your-first-pull-request)

"React Native for Web" makes it possible to run [React Native][react-native-url] components and APIs on the web using React DOM.

## Documentation

The [documentation site](https://necolas.github.io/react-native-web/) ([source](https://github.com/necolas/react-native-web/blob/master/packages/react-native-web-docs)) covers installation, guides, and APIs.

## Example

The [examples app](https://p9t5cp.sse.codesandbox.io/) ([source](https://github.com/necolas/react-native-web/blob/master/packages/react-native-web-examples)) demonstrates many available features. Fork the [codesandbox](https://codesandbox.io/s/github/necolas/react-native-web/tree/master/packages/react-native-web-examples) to make changes and see the results.

You'll notice that there is no reference to `react-dom` in components. The `App` component that is shown below is defined using the APIs and Components of React Native, but it can also be rendered on the web using React Native for Web.

```js
// Example component
import React from 'react';
import { AppRegistry, StyleSheet, Text, View } from 'react-native';

class App extends React.Component {
  render() {
    return (
      <View style={styles.box}>
        <Text style={styles.text}>Hello, world!</Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  box: { padding: 10 },
  text: { fontWeight: 'bold' }
});

AppRegistry.registerComponent('App', () => App);
AppRegistry.runApplication('App', { rootTag: document.getElementById('react-root') });
```

## Contributing

Development happens in the open on GitHub and we are grateful for contributions including bugfixes, improvements, and ideas. Read below to learn how you can take part in improving React Native for Web.

### Code of conduct

This project expects all participants to adhere to Meta's OSS [Code of Conduct][code-of-conduct]. Please read the full text so that you can understand what actions will and will not be tolerated.

### Contributing guide

Read the [contributing guide][contributing-url] to learn about the development process, how to propose bugfixes and improvements, and how to build and test your changes to React Native for Web.

### Good first issues

To help you get you familiar with the contribution process, there is a list of [good first issues][good-first-issue-url] that contain bugs which have a relatively limited scope. This is a great place to get started.

## License

React Native for Web is [MIT licensed](./LICENSE). By contributing to React Native for Web, you agree that your contributions will be licensed under its MIT license.

[package-badge]: https://img.shields.io/npm/v/react-native-web.svg?style=flat
[package-url]: https://www.npmjs.com/package/react-native-web
[ci-badge]: https://github.com/necolas/react-native-web/workflows/tests/badge.svg
[ci-url]: https://github.com/necolas/react-native-web/actions
[react-native-url]: https://reactnative.dev/
[contributing-url]: https://github.com/necolas/react-native-web/blob/master/.github/CONTRIBUTING.md
[good-first-issue-url]: https://github.com/necolas/react-native-web/labels/good%20first%20issue
[code-of-conduct]: https://opensource.fb.com/code-of-conduct/
