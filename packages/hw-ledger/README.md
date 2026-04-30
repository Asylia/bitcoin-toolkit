# @asylia/hw-ledger

Ledger hardware-wallet adapter for the Asylia self-custody platform. It wraps
`@ledgerhq/ledger-bitcoin` and `@ledgerhq/hw-transport-webhid` behind a narrow
Asylia-shaped API for environment checks, xpub export, wallet-policy
registration, address display, and PSBT signing.

The wallet UI never imports LedgerHQ packages directly. Every Ledger protocol
interaction that can influence funds passes through this package, which keeps
the audit boundary explicit and reusable outside the Vue app.

Keywords: Ledger, Bitcoin hardware wallet, WebHID, Ledger Bitcoin app v2,
wallet policy, PSBT signing, P2WSH multisig, BIP-48, self-custody, TypeScript.

## Maintainer And Support

`@asylia/hw-ledger` is maintained by [Asylian21](https://github.com/Asylian21).

> **Support Asylia Bitcoin tooling**
>
> If this work helps your wallet, audit, integration, or research, you can
> support ongoing development with a Bitcoin donation:
> `bc1qrdchup8497xz0972v35q4nr0fx5egghf0z23c3`

## Status

`0.1.0-dev`. Environment detection, xpub export, wallet-policy registration,
address display, live events, and PSBT signing are implemented.

## Why This Package Exists

Hardware-wallet code is a hard security boundary:

- It opens the browser transport to a physical device.
- It requests xpub material and fingerprints.
- It maps a wallet policy into device-approved Ledger state.
- It turns PSBT data into device-side prompts.
- It receives signatures that may authorize Bitcoin spends.

Keeping this code outside the wallet SPA makes the boundary auditable,
upgradeable in isolation, and portable to a future mobile signer.

## Public API

Every public export is re-emitted from `src/index.ts`.

| Export | Purpose |
| --- | --- |
| `initLedger(options?)` | Idempotent pre-flight for secure origin and WebHID availability. |
| `detectLedgerEnvironment()` | Pure browser capability probe. It never opens a permission prompt. |
| `recommendationFromEnvironment()` | Maps browser/device capability into UI guidance. |
| `exportLedgerRoot({ derivationPath, scriptType })` | Opens WebHID, verifies the Bitcoin app, reads the master fingerprint, and exports the requested BIP-32 public root. |
| `buildLedgerWalletPolicy(input)` | Builds the deterministic Ledger multisig policy preview. |
| `registerLedgerWalletPolicy(input)` | Registers the policy on device and returns the HMAC Asylia must persist for future signing. |
| `displayWshSortedMultiAddress(input)` | Requests an on-device address display for a derived P2WSH multisig address. |
| `signWshSortedMultiPsbt(input)` | Signs a PSBT with a registered policy and merges verified partial signatures back into the PSBT. |
| `subscribeToLedgerEvents(handler)` | Streams device, app, prompt, finalization, and transport events for UI steppers and support diagnostics. |
| `findAuthorisedLedgerDevice()`, `hasAuthorisedLedgerDevice()` | Silent `navigator.hid.getDevices()` helpers. |
| `friendlyProductName(info)` | Converts HID descriptors into user-facing Ledger model names. |

All high-level flows return `AdapterResult<T>`: `{ ok: true, data }` or
`{ ok: false, error }`. Callers do not need to catch vendor SDK exceptions in
UI code.

## Ledger Signing Model

Ledger's modern Bitcoin app signs multisig spends through wallet policies. The
Asylia flow is:

1. Build the canonical `wsh(sortedmulti(...))` policy from the vault descriptor
   data.
2. Register that policy once on the Ledger device.
3. Persist the returned policy HMAC in wallet metadata.
4. Build PSBT v2 inputs with witness scripts, BIP-32 derivation records, and raw
   funding transactions when available.
5. Open WebHID for signing, verify the connected Ledger and Bitcoin app, sign
   with the stored policy HMAC, verify returned partial signatures, and merge
   them into the PSBT.

The adapter requires `@asylia/btc-core` for PSBT inspection, script metadata,
and signature verification. Bitcoin script logic does not live in this package.

## Error Model

Ledger SDK failures, APDU status words, transport errors, browser capability
failures, and user cancellations are normalized into the `LedgerErrorCode`
union:

```text
init_failed | cancelled | device_disconnected | device_not_found |
device_in_use | device_locked | device_timeout | app_not_open |
wrong_app | wrong_device | app_outdated | firmware_too_old |
descriptor_unavailable | invalid_path | transport_unavailable |
permission_denied | gesture_required | unknown
```

The wallet renders adapter-provided messages. It should not inspect raw LedgerHQ
error strings.

## Events and Diagnostics

`subscribeToLedgerEvents` returns an `UnsubscribeFn` and emits events such as:

- `device_connected` / `device_disconnected`,
- `app_connected`,
- `awaiting_button`,
- `finalising`,
- `transport_error`.

The wallet's Ledger wizard uses this stream to drive step-by-step UI. Adapter
logs use the `[hw-ledger]` prefix so support can reconstruct UI -> service ->
adapter -> device behavior from browser console output.

## Not in Scope

This package does not:

- persist xpubs, fingerprints, policy HMACs, or signatures,
- store seed phrases or private keys,
- render UI,
- own descriptor policy construction beyond Ledger's device policy format,
- fetch blockchain data,
- support non-Asylia script families.

## Testing

```bash
yarn workspace @asylia/hw-ledger type-check
yarn workspace @asylia/hw-ledger test
```

## Versioning and Audit Stance

The package remains `0.1.0-dev` until the first audited stable API. Upstream
Ledger dependencies are intentionally pinned to specific minor versions. See
[`SECURITY.md`](./SECURITY.md) for the disclosure process and scope.

## License

MIT - see [`LICENSE`](./LICENSE).
