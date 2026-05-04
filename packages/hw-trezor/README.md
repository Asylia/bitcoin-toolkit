<p align="center">
  <img src="../../apps/wallet/resources/logo.svg" alt="Asylia" width="96" />
</p>

# @asylia/hw-trezor

Trezor hardware-wallet adapter for the Asylia self-custody platform. It wraps
`@trezor/connect-web` behind a narrow Asylia-shaped API for initialization,
environment checks, xpub export, address display, live events, and PSBT signing.

The wallet UI never imports Trezor Connect directly. Every device interaction
that can influence a Bitcoin vault passes through this package, making the
security boundary easy to audit and reuse outside the Vue app.

Keywords: Trezor, Bitcoin hardware wallet, Trezor Connect, PSBT signing, P2WSH
multisig, BIP-48, BIP-380 descriptor, xpub export, self-custody, TypeScript.

## Maintainer And Support

`@asylia/hw-trezor` is maintained by [Asylian21](https://github.com/Asylian21).

> **Support Asylia Bitcoin tooling**
>
> If this work helps your wallet, audit, integration, or research, you can
> support ongoing development with a Bitcoin donation:
> `bc1qrdchup8497xz0972v35q4nr0fx5egghf0z23c3`

## Status

`1.0.0`. Initialization, environment detection, xpub export, address
display, live events, and `wsh(sortedmulti(...))` PSBT signing are implemented.

## Installation

```bash
npm install @asylia/hw-trezor @asylia/btc-core
```

## Why This Package Exists

Hardware-wallet code is a hard security boundary:

- It speaks to a physical device the user trusts.
- It requests xpub material and master fingerprints.
- It maps PSBT data into device prompts.
- It receives signatures that may authorize Bitcoin spends.
- It must normalize vendor failures into predictable application states.

Pulling the Trezor integration out of the wallet SPA keeps the audited surface
small, isolates vendor SDK upgrades, and leaves room for a future Capacitor
signer to reuse the same logic.

## Public API

Every public export is defined by the source barrel and published from the
package root.

| Export | Purpose |
| --- | --- |
| `initTrezor(manifest)` | Idempotent Trezor Connect bootstrap. |
| `detectTrezorEnvironment()` | Browser/transport capability probe for UX guidance. |
| `recommendationFromEnvironment()` | Converts environment state into recommended next steps. |
| `exportTrezorRoot({ derivationPath, scriptType })` | Prompts the device for the BIP-48 multisig root xpub and master fingerprint. |
| `displayWshSortedMultiAddress(input)` | Requests an on-device display of a derived P2WSH multisig address. |
| `signWshSortedMultiPsbt(input)` | Translates a PSBT v2 into Trezor's transaction format, collects signatures, verifies ownership, and merges partial signatures back into the PSBT. |
| `subscribeToTrezorEvents(handler)` | Streams device, prompt, and transport events for UI steppers and diagnostics. |
| Public types | Adapter result, manifest, device info, script type, export/sign/display inputs, and normalized errors. |

All high-level flows return `AdapterResult<T>`: `{ ok: true, data }` or
`{ ok: false, error }`. UI code should render adapter errors directly instead of
catching and pattern-matching raw vendor exceptions.

## Example

```ts
import {
  exportTrezorRoot,
  initTrezor,
  signWshSortedMultiPsbt,
} from '@asylia/hw-trezor';

await initTrezor({
  appName: 'Asylia Wallet',
  appUrl: 'https://wallet.asylia.io',
  email: 'support@asylia.io',
});

const exported = await exportTrezorRoot({
  derivationPath: "m/48'/0'/0'/2'",
  scriptType: 'p2wsh',
});

if (exported.ok) {
  const { xpub, masterFingerprint, device } = exported.data;
  // Persist xpub + masterFingerprint as signer metadata.
}

const signed = await signWshSortedMultiPsbt({
  psbtBase64,
  vault: {
    requiredSignatures: 2,
    keys: descriptorKeys,
  },
  signerFingerprint: 'd34db33f',
});
```

## Derivation and Script Policy

Asylia targets native-SegWit BIP-48 multisig only:

```text
wsh(sortedmulti(...)) at m/48'/0'/0'/2'
```

From that xpub depth, the wallet derives receive and change addresses with
unhardened `/0/i` and `/1/i` children without asking the device again.

The nested-SegWit BIP-48 branch (`m/48'/0'/0'/1'`, `sh(wsh(...))`) is not
supported. The `TrezorScriptType` union intentionally exposes only `p2wsh`.

## Master Fingerprint

Trezor returns descriptor-shaped public-key metadata. The adapter parses the
leading 8-character hex fingerprint and returns it as
`masterFingerprint`, which is the signer identity Asylia stores for matching
future signatures.

Trezor Model One cannot return the descriptor field required for this flow. The
adapter returns `descriptor_unavailable` so the wallet can show precise upgrade
guidance instead of a generic failure.

## Web Transport Model

The adapter uses Trezor Connect's `coreMode: 'auto'` resolution:

- local Trezor service or Suite transport available: iframe mode with event
  streaming into the SPA,
- otherwise: popup mode, with Trezor Connect owning browser-side prompts.

PIN, passphrase, permission, and export approval prompts are owned by Trezor
Connect and the physical Trezor device. `@trezor/connect-web` is USB-only in the
browser; Bluetooth belongs to a future native mobile signer path.

## Signing Model

Trezor Connect does not sign PSBT payloads directly. It signs a Trezor-native
transaction shape. `signWshSortedMultiPsbt` bridges that gap:

1. Inspect the PSBT v2 with `@asylia/btc-core`.
2. Translate inputs into Trezor `SPENDWITNESS` entries with multisig metadata.
3. Translate external outputs and vault change outputs into device-readable
   prompts.
4. Preserve PSBT version and locktime so signatures are over the transaction the
   wallet will actually finalize.
5. Verify returned signatures against the expected cosigner pubkeys.
6. Re-attribute signatures when a different valid passphrase wallet signs from
   the same physical device.
7. Merge verified signatures back into the PSBT with the SIGHASH_ALL byte.

If no vault cosigner owns a returned signature, the adapter refuses it. Broken
or misattributed partial signatures should never reach the proposal store.

## Error Model

Vendor failures are normalized into stable `TrezorErrorCode` values:

```text
init_failed | manifest_required | cancelled | device_disconnected |
device_not_found | device_in_use | device_locked | device_timeout |
firmware_too_old | descriptor_unavailable | invalid_path |
transport_unavailable | unknown
```

The wallet renders the adapter's user-facing message. It should not depend on
Trezor Connect's raw error strings.

## Not in Scope

This package does not:

- persist xpubs, fingerprints, or signatures,
- store seed phrases or private keys,
- render UI,
- fetch chain data,
- build descriptors or PSBTs from scratch,
- support non-Asylia script families.

Descriptor construction and PSBT helpers live in `@asylia/btc-core`.

## Testing

```bash
yarn workspace @asylia/hw-trezor type-check
yarn workspace @asylia/hw-trezor test
```

## Versioning and Audit Stance

The package uses semver for stable releases. See [`SECURITY.md`](./SECURITY.md)
for the disclosure process and security scope.

## License

MIT - see [`LICENSE`](./LICENSE).
