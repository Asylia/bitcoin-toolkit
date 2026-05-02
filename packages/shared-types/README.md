<p align="center">
  <img src="https://raw.githubusercontent.com/Asylia/asylia.io/main/apps/wallet/resources/logo.svg" alt="Asylia" width="96" />
</p>

# @asylia/shared-types

Shared TypeScript domain contracts for the Asylia self-custody platform.

This package is intentionally types-only. It exists so the wallet, Bitcoin core,
hardware-wallet adapters, chain-data package, server tooling, audit harnesses,
and future mobile signer can speak one vocabulary for vaults, signers,
descriptors, derivation paths, UTXOs, amounts, PSBT proposals, and audit events.

Keywords: Bitcoin wallet types, multisig domain model, vault types, signer
types, PSBT proposal types, TypeScript contracts, self-custody, Asylia.

## Maintainer And Support

`@asylia/shared-types` is maintained by [Asylian21](https://github.com/Asylian21).

> **Support Asylia Bitcoin tooling**
>
> If this work helps your wallet, audit, integration, or research, you can
> support ongoing development with a Bitcoin donation:
> `bc1qrdchup8497xz0972v35q4nr0fx5egghf0z23c3`

## Status

`0.0.0-dev`. The first exported value is the package version constant while the
shared domain model is promoted out of the wallet and auditable packages.

## Why This Package Exists

Asylia has several security boundaries:

- the wallet application,
- Bitcoin descriptor and PSBT primitives,
- Ledger and Trezor adapters,
- chain-data providers,
- Supabase-backed product state,
- future mobile signer and backend tooling.

Those boundaries should not each invent their own version of a `Vault`,
`Signer`, `DescriptorKey`, `Sats`, or `PsbtProposal`. A dedicated types package
keeps the language consistent and makes review easier.

## Design Principles

- **Types only.** No runtime dependencies and no shipped JavaScript behavior
  beyond constants.
- **Boundary-first.** Types describe contracts between packages, not private
  implementation details inside one module.
- **Branded units.** Amounts and identifiers should be typed so sats/BTC,
  fingerprint/xpub, and receive/change index mistakes become compiler errors.
- **Discriminated states.** Proposal, signer, vault, and sync states should be
  unions with explicit transitions instead of broad string bags.
- **Vendor isolation.** Third-party SDK shapes stay inside the adapter package
  that owns them. Shared types expose Asylia's normalized shape only.

## Planned Surface

| Module | Planned contracts |
| --- | --- |
| `vault.ts` | `Vault`, `VaultStatus`, `VaultPolicy`, `VaultMetadata` |
| `signer.ts` | `Signer`, `SignerKind`, `SignerFingerprint`, `SignerCapabilities` |
| `descriptor.ts` | `Descriptor`, `DescriptorPolicy`, `DescriptorKey`, `DescriptorChecksum` |
| `derivation.ts` | `DerivationPath`, `Bip48Path`, `Fingerprint`, `Xpub` |
| `amount.ts` | Branded `Sats`, `Btc`, fee-rate, and fiat display contracts |
| `utxo.ts` | UTXO, outpoint, confirmation, and lock-state contracts |
| `psbt.ts` | `PsbtProposal`, proposal status, signer progress, and timeline events |
| `audit.ts` | Audit log entries and wallet timeline events |
| `errors.ts` | Cross-boundary `AsyliaError` discriminants |

## Public Distribution

`@asylia/shared-types` is part of the public
[`Asylia/bitcoin-toolkit`](https://github.com/Asylia/bitcoin-toolkit) export.
It shares the MIT license because it describes the public contract of the
auditable Bitcoin packages.

## Not in Scope

This package does not contain:

- descriptor builders,
- address derivation,
- PSBT parsing or signing,
- vendor SDK types,
- Supabase row definitions that are private to the app,
- UI component props,
- runtime validation logic.

Runtime Bitcoin behavior belongs in `@asylia/btc-core`; device behavior belongs
in `@asylia/hw-trezor` and `@asylia/hw-ledger`.

## Testing

```bash
yarn workspace @asylia/shared-types type-check
```

## Versioning

The package is still pre-stable. Once the shared model is fully promoted, stable
releases will use semantic versioning and changelog entries so downstream
contracts are easy to audit.

## License

MIT - see [`LICENSE`](./LICENSE).
