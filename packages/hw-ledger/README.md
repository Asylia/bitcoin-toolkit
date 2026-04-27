# @asylia/hw-ledger

**Status:** xpub export, wallet-policy registration, environment /
event surfaces, and PSBT signing are implemented.

Ledger adapter for the Asylia wallet. Wraps `ledger-bitcoin` (the
official TypeScript client for the modern Bitcoin app v2+) and
`@ledgerhq/hw-transport-webhid` behind an Asylia-shaped adapter (init,
derive xpub, register policy, sign PSBT) so the wallet UI never talks
to a hardware-wallet SDK directly.

## Why a separate package

Same reasoning as `@asylia/hw-trezor`: hardware-wallet code is a hard
security boundary and must be auditable, upgradeable in isolation, and
reusable from the future Capacitor signer.

## Why MIT

Same reasoning as `@asylia/btc-core` and `@asylia/hw-trezor`: this
package is security-critical and the rest of the Bitcoin tooling
ecosystem (including LedgerHQ's own libraries) is MIT.

## Public API

Every file below `src/` is private to this package. The stable surface
is the set of exports re-emitted from `src/index.ts`:

- `initLedger(options?)` — idempotent pre-flight. Validates the page
  is served over HTTPS and that `navigator.hid` exists. Returns a
  normalised `transport_unavailable` error otherwise.
- `exportLedgerRoot({ derivationPath, scriptType })` — single
  user-facing flow that opens a WebHID session, verifies the running
  Bitcoin app version (≥ 2.1.0), reads the master fingerprint, and
  exports the BIP-32 extended public key at the requested path.
  Returns `{ xpub, xpubMultisig, masterFingerprint, device }`. Asylia
  always calls `getExtendedPubkey(..., display: true)`, so the user
  explicitly approves the public-key export on the Ledger screen even
  when the Bitcoin app would otherwise allow a silent BIP-48 read.
- `detectLedgerEnvironment()` — pure probe that reports WebHID
  support, browser family (Chromium / Safari / Firefox / …), and
  whether the user has already authorised a Ledger on this origin.
  Safe to call on any mount; never triggers a permission prompt.
- `buildLedgerWalletPolicy(input)` /
  `registerLedgerWalletPolicy(input)` — deterministic multisig policy
  preview + one-time on-device registration. Registration returns the
  32-byte policy HMAC that Asylia persists and reuses for signing.
- `signWshSortedMultiPsbt(input)` — opens WebHID, verifies the running
  Bitcoin app and connected master fingerprint, signs the PSBT with the
  registered wallet policy + HMAC, verifies returned partial signatures,
  and merges them back into the PSBT. The wallet builds inputs with
  `nonWitnessUtxo` from raw funding transactions so the Ledger Bitcoin
  app can verify them without showing the unverified-inputs warning.
- `subscribeToLedgerEvents(handler)` — live stream combining raw
  `navigator.hid.onconnect` / `ondisconnect` beacons with synthetic
  `app_connected` / `awaiting_button` / `finalising` /
  `transport_error` events
  emitted by the export / registration / signing flows.
- `findAuthorisedLedgerDevice()` / `hasAuthorisedLedgerDevice()` —
  silent introspection against `navigator.hid.getDevices()`.
- `friendlyProductName(info)` — HID descriptor → marketing name
  (`"Ledger Nano X"`, `"Ledger Stax"`, …).

All functions return the same `AdapterResult<T>` discriminant used by
`@asylia/hw-trezor`, so the wallet UI can render both families through
a single `{ ok, data | error }` pattern.

## Error model

Every Ledger SDK failure — APDU status words (`0x6985`, `0x6B0C`,
`0x6A82`, …) and named errors from `@ledgerhq/errors`
(`LockedDeviceError`, `TransportOpenUserCancelled`, …) — is mapped
onto the `LedgerErrorCode` union:

```
'init_failed' | 'cancelled' | 'device_disconnected' |
'device_not_found' | 'device_in_use' | 'device_locked' |
'device_timeout' | 'app_not_open' | 'wrong_app' | 'wrong_device' |
'app_outdated' | 'firmware_too_old' | 'descriptor_unavailable' |
'invalid_path' | 'transport_unavailable' | 'permission_denied' |
'gesture_required' | 'unknown'
```

Paired user-facing copy lives in `errors.ts`. The wallet UI should
never pattern-match on vendor strings — the wizard renders the
adapter's `message` verbatim.

## Events

`subscribeToLedgerEvents` returns an `UnsubscribeFn`. Events fire in
one of the following shapes:

- `{ phase: 'device_connected' | 'device_disconnected', device }`
- `{ phase: 'app_connected', appName, appVersion }`
- `{ phase: 'awaiting_button', intent }`
- `{ phase: 'finalising', message }`
- `{ phase: 'transport_error', message }`

Use this stream to drive a four-step stepper in the UI; the wizard in
the wallet SPA (`apps/wallet/src/components/ledger-connect-wizard`)
is the canonical consumer.

## Logging

Every meaningful step in the adapter prints a structured `[hw-ledger]`
log line to the browser console. Pair these with the service layer's
`[asylia/ledger]` lines and the wizard's `[asylia/ledger-wizard]`
lines to reconstruct every UI → adapter → device hop during a support
investigation.

## Not in scope

- Persistence of any device-derived material.
- UI primitives.
- Bitcoin script logic (lives in `@asylia/btc-core`).

## Versioning + audit stance

See [`SECURITY.md`](./SECURITY.md). The package is `0.1.0-dev` until
it ships its first audited stable API. Every upstream LedgerHQ
dependency is pinned to a specific minor version.

## License

MIT — see [`LICENSE`](./LICENSE).
