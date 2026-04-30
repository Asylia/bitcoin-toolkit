# @asylia/btc-core

Framework-agnostic Bitcoin primitives for the Asylia self-custody platform:
native-SegWit P2WSH multisig descriptors, BIP-48 derivation, deterministic
address generation, PSBT v2 construction and inspection, signature verification,
and coin-selection helpers.

This is the core audit package behind Asylia's wallet. It contains no Vue, DOM,
Supabase, browser storage, or product UI code. The same functions can run in the
wallet SPA, a future Capacitor signer, Node-based audit tooling, or independent
review harnesses.

Keywords: Bitcoin, multisig, P2WSH, `wsh(sortedmulti(...))`, BIP-48, BIP-380,
PSBT v2, BIP-370, descriptor checksum, hardware wallet signing, TypeScript,
self-custody.

## Maintainer And Support

`@asylia/btc-core` is maintained by [Asylian21](https://github.com/Asylian21).

> **Support Asylia Bitcoin tooling**
>
> If this work helps your wallet, audit, integration, or research, you can
> support ongoing development with a Bitcoin donation:
> `bc1qrdchup8497xz0972v35q4nr0fx5egghf0z23c3`

## Status

`0.1.0-dev`. The package already ships the active Asylia wallet primitives, but
the public API can still change before the first audited stable release.

## Script Policy

`@asylia/btc-core` supports exactly one wallet script family:

```text
wsh(sortedmulti(N, key1, key2, ...))
```

Asylia uses the native-SegWit BIP-48 multisig branch:

```text
m/48'/0'/0'/2'
```

The package does not expose a generic script-type switch. Nested SegWit
P2SH-P2WSH (`sh(wsh(...))`), Taproot, legacy P2PKH, and arbitrary scripts are
intentionally out of scope. A single script family keeps descriptor building,
address derivation, PSBT construction, hardware-wallet mapping, and audits small
enough to reason about carefully.

## Public API

Every public export comes from `src/index.ts`. The most important surfaces are:

| Area | Exports |
| --- | --- |
| Descriptors | `buildWshSortedMultiDescriptor`, `descriptorChecksum`, `withChecksum`, `toCanonicalXpub` |
| Imports | `parseAsyliaVaultConfig`, `parseCaravanWalletConfig`, `parseSparrowWalletConfig`, `parseDescriptorImport` |
| Vault identity | `vaultIdentityKey` |
| Address derivation | `deriveWshSortedMultiAddress`, `deriveWshSortedMultiAddressBatch`, `buildWshSortedMultiInstance` |
| Address parsing | `parseBitcoinAddress`, `describeBitcoinAddressType` |
| PSBT build/inspect | `buildWshSortedMultiPsbt`, `extractPsbtInputs`, `inspectPsbtV2`, `addressFromScript`, `bip32PathToAddressN` |
| Signatures | `addPartialSignaturesToPsbt`, `computeBip143SighashAll`, `verifySegwitV0SignatureAgainstPubkey`, `findSegwitV0SignatureOwner`, `findSegwitV0SignatureOwnerForPsbt` |
| Finalization | `countPsbtSigners`, `collectSignerFingerprints`, `finaliseAndExtractTransaction` |
| Coin selection | `selectCoinsLargestFirst`, `selectCoinsLargestFirstFixedFee`, `maxSpendableSats` |

## Example

```ts
import {
  buildWshSortedMultiDescriptor,
  deriveWshSortedMultiAddress,
} from '@asylia/btc-core';

const keys = [
  {
    fingerprint: 'd34db33f',
    derivationPath: "48'/0'/0'/2'",
    xpub: 'xpub...',
  },
  {
    fingerprint: 'f00dbabe',
    derivationPath: "48'/0'/0'/2'",
    xpub: 'xpub...',
  },
  {
    fingerprint: '8badf00d',
    derivationPath: "48'/0'/0'/2'",
    xpub: 'xpub...',
  },
] as const;

const descriptor = buildWshSortedMultiDescriptor({
  network: 'mainnet',
  requiredSignatures: 2,
  keys,
});

const firstReceive = deriveWshSortedMultiAddress({
  network: 'mainnet',
  requiredSignatures: 2,
  keys,
  chain: 0,
  index: 0,
});
```

## Import Guarantees

Import helpers normalize Asylia, Caravan, Sparrow, raw BIP-380 descriptor, and
Bitcoin Core `importdescriptors` inputs into one `ParsedMultisigImport` shape.
Validation is strict by design:

- mainnet only,
- native P2WSH only,
- valid BIP-380 checksum when supplied,
- valid fingerprints, derivation paths, and xpub material,
- deterministic signer ordering for duplicate detection.

Malformed input is rejected at the boundary instead of becoming a broken vault
row downstream.

## PSBT and Hardware Wallets

The PSBT surface is designed for hardware-wallet adapters:

- `buildWshSortedMultiPsbt` creates PSBT v2 spends with witness scripts and
  per-cosigner BIP-32 derivation metadata.
- `inspectPsbtV2` gives adapters a typed view of inputs, outputs, existing
  partial signatures, and derivation records.
- `computeBip143SighashAll` and `findSegwitV0SignatureOwner` let adapters verify
  that a returned signature belongs to the expected cosigner before it is merged.
- `addressFromScript` lets adapters recover standard recipient addresses for
  device prompts.

## Not in Scope

This package does not:

- store seed phrases, private keys, passphrases, or hardware-wallet secrets,
- fetch blockchain data,
- broadcast transactions,
- own wallet persistence,
- render UI,
- depend on Vue, Supabase, or any Asylia application module,
- support scripts outside `wsh(sortedmulti(...))`.

If a feature needs upstream chain data, use `@asylia/blockchain-data-btc`. If it
needs a device SDK, use `@asylia/hw-trezor` or `@asylia/hw-ledger`.

## Testing

```bash
yarn workspace @asylia/btc-core type-check
yarn workspace @asylia/btc-core test
yarn workspace @asylia/btc-core test:coverage
```

## Versioning and Audit Stance

Until the first stable release, breaking changes are allowed. Stable releases
will use semantic versioning, changelog entries, git tags, and documented audit
scope. Vulnerability disclosure is covered in [`SECURITY.md`](./SECURITY.md).

## License

MIT - see [`LICENSE`](./LICENSE).
