# Asylia Bitcoin Toolkit

Auditable Bitcoin TypeScript packages used by the Asylia self-custody wallet.

This repository is the public open-source boundary for Asylia. It contains
framework-agnostic code for descriptors, address derivation, PSBT helpers,
hardware-wallet adapters, chain-data providers, and shared domain types.

The product wallet, brand surface, design system, mobile shells, Supabase
configuration, and internal tooling live in a private product repository and
are intentionally not mirrored here.

## Packages

- `@asylia/btc-core` - native SegWit P2WSH multisig descriptors, address
  derivation, PSBT helpers, and script policy utilities.
- `@asylia/blockchain-data-btc` - normalized Bitcoin chain-data providers
  with failover, cooldowns, rate limiting, and request deduplication.
- `@asylia/hw-ledger` - Ledger wallet policy, xpub, and PSBT signing adapter.
- `@asylia/hw-trezor` - Trezor initialization, xpub, multisig, and PSBT
  signing adapter.
- `@asylia/shared-types` - shared domain contracts for vaults, signers,
  descriptors, UTXOs, and PSBT proposals.

## Development

```bash
corepack enable
yarn install
yarn lint
yarn type-check
yarn test
```

## Security

Please report vulnerabilities privately to security@asylia.io.
