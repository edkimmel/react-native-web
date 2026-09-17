/**
 * Flow 0.148 does not know the `node:` prefixed form of Node's core
 * modules. Only the surface this package uses is declared here; the shapes
 * come from Flow's own `stream` libdef.
 *
 * @flow
 */

declare module 'node:stream' {
  declare export class Transform extends stream$Transform {}
  declare export class Writable extends stream$Writable {}
}
