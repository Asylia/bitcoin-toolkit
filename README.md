<p align="center">
  <img src="assets/asylia-logo.svg" alt="Asylia" width="96" />
</p>

# Asylia Project: Bitcoin Toolkit

Auditable Bitcoin TypeScript packages for the Asylia self-custody platform.

Asylia is a Bitcoin self-custody project focused on native-SegWit multisig
vaults, hardware-wallet signing, PSBT collaboration, and calm long-term treasury
operations. This repository is the public open-source boundary of that project:
the code here is the part external reviewers should be able to inspect without
needing the private wallet application, brand system, Supabase configuration, or
internal tooling.

Keywords: Bitcoin self-custody, multisig wallet, P2WSH, `wsh(sortedmulti(...))`,
BIP-48, BIP-380 descriptors, PSBT v2, Trezor, Ledger, chain-data failover,
hardware wallet TypeScript, Bitcoin wallet SDK.

## Maintainer And Support

Asylia Bitcoin Toolkit is maintained by [Asylian21](https://github.com/Asylian21).

> **Support Asylia Bitcoin tooling**
>
> If this work helps your wallet, audit, integration, or research, you can
> support ongoing development with a Bitcoin donation:
> `bc1qrdchup8497xz0972v35q4nr0fx5egghf0z23c3`

## What This Repository Contains

The toolkit contains framework-agnostic packages used by the Asylia wallet to
derive addresses, build and inspect PSBTs, talk to hardware wallets, fetch
Bitcoin chain data, and share typed domain contracts across security boundaries.
It also contains public-safe release security audit records under `audits/` so
reviewers can connect release claims to concrete scope, model versions, findings,
and residual risk.

It intentionally does not contain:

- the Asylia wallet UI,
- marketing and brand assets,
- the proprietary design system,
- Supabase project configuration,
- mobile shell code,
- deployment secrets or internal operations tooling.

## Packages

| Package | Purpose |
| --- | --- |
| `@asylia/btc-core` | Native-SegWit P2WSH multisig descriptors, BIP-48 derivation, address generation, PSBT v2 build/inspect/finalize helpers, signature verification, and coin selection. |
| `@asylia/blockchain-data-btc` | Normalized Bitcoin chain-data API across Mempool.space, Blockstream.info, Esplora mirrors, Blockchain.com, Blockcypher, fiat-rate providers, and a caller-owned edge fallback. |
| `@asylia/hw-ledger` | Ledger WebHID adapter for environment checks, xpub export, wallet-policy registration, address display, and PSBT signing. |
| `@asylia/hw-trezor` | Trezor Connect adapter for initialization, environment checks, xpub export, address display, and PSBT signing. |
| `@asylia/shared-types` | Shared domain contracts for vaults, signers, descriptors, derivation paths, amounts, UTXOs, PSBT proposals, and audit events. |

## Installation

```bash
npm install @asylia/btc-core
npm install @asylia/blockchain-data-btc
npm install @asylia/hw-ledger @asylia/btc-core
npm install @asylia/hw-trezor @asylia/btc-core
```

The first stable npm release is `1.0.0` for all four published packages. The
hardware-wallet adapters declare `@asylia/btc-core` as a peer dependency so
wallet applications keep one shared Bitcoin primitive implementation.

## Security Model

Asylia keeps the audit surface small on purpose:

- One Bitcoin network target in the current product: mainnet.
- One multisig script family: `wsh(sortedmulti(...))`.
- One BIP-48 script branch: `m/48'/0'/0'/2'`.
- Vendor SDKs stay behind hardware adapter packages.
- Browser and server consumers receive normalized error/result shapes instead of
  raw vendor strings.
- The wallet stores xpubs, fingerprints, proposals, and metadata. It does not
  store seed phrases, private keys, or hardware-wallet secrets.

The packages in this repository are MIT-licensed so auditors, operators, and
downstream builders can verify the logic that handles descriptors, scripts,
chain data, devices, and transactions.

## Development

```bash
corepack enable
yarn install
yarn lint
yarn type-check
yarn test
```

Useful package-level commands:

```bash
yarn workspace @asylia/btc-core test
yarn workspace @asylia/blockchain-data-btc type-check
yarn workspace @asylia/hw-trezor lint
yarn workspace @asylia/hw-ledger test
```

## Publishing

The four npm packages are released from this public repository by the
**Release Packages** workflow:

1. `@asylia/btc-core`
2. `@asylia/blockchain-data-btc`
3. `@asylia/hw-ledger`
4. `@asylia/hw-trezor`

The private Asylia monorepo remains the source of code truth. Its sync workflow
exports only the allowlisted package files into this repository. When the synced
package contents change after the initial release, the export writes a patch
Changeset so GitHub Actions can open a Version Packages PR.

## Versioning

Changesets owns public package versions, changelogs, and npm publish decisions.
The release workflow behaves as follows:

- If a sync contains package changes and a Changeset, it opens or updates a
  Version Packages PR.
- Merging that Version Packages PR updates versions and changelogs, then
  publishes only packages whose versions are not already on npm.
- If a sync contains no package changes, no version is published.
- The `1.x` line is the stable public API: patch releases are compatible
  fixes, minor releases add compatible capabilities, and major releases are
  reserved for breaking changes.

Prefer npm Trusted Publishing for this repository. If Trusted Publishing is not
configured, add an npm automation token as the `NPM_TOKEN` secret.

## Security

Please report vulnerabilities privately to security@asylia.io. Do not open
public GitHub issues for suspected vulnerabilities in descriptor, key,
hardware-wallet, chain-data, or transaction-handling code.

Public release audit summaries live under `audits/`. They intentionally avoid
secrets, user data, private operational detail, and weaponized exploit steps.
