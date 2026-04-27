/**
 * SDK shim for `@trezor/connect-web`.
 *
 * The vendor package is published as CommonJS with both
 *
 *   exports.default = TrezorConnect
 *   __exportStar(require('@trezor/connect/lib/exports'), exports)
 *
 * present on the same module. Vite + esbuild handle this shape
 * inconsistently across versions: depending on the prebundle cache state
 * an `import TrezorConnect from '@trezor/connect-web'` can resolve to
 * either the real `TrezorConnect` factory object (with `.init`,
 * `.getPublicKey`, …) or to the entire module namespace, where the
 * factory hides one level deeper under `.default`. The latter shape
 * surfaces as `TypeError: TrezorConnect.init is not a function` at the
 * very first call.
 *
 * This wrapper imports the package once, normalises both shapes into the
 * factory object, and re-exports it under the same name. Every other
 * file in this package imports `TrezorConnect` from here so the fix
 * lives in exactly one place and the rest of the adapter stays naive
 * about the bundler quirk.
 */

import TrezorConnectImport from '@trezor/connect-web';

type SdkType = typeof TrezorConnectImport;

const raw = TrezorConnectImport as unknown as SdkType & { default?: SdkType };

// Prefer the `.default` indirection if present (broken Vite shape) and
// fall back to the value itself when the bundler already unwrapped it.
export const TrezorConnect: SdkType = raw.default ?? raw;
