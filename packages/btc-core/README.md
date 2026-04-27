# @asylia/btc-core

**Status:** scaffolded, not yet implemented. Tracks the design from the
`asylia60/packages/asylia-wallets/p2wsh` reference codebase, adapted from
P2SH-wrapped P2WSH to pure native-SegWit P2WSH (`wsh(sortedmulti(...))`)
at the BIP-48 multisig path `m/48'/0'/0'/2'`.

## Script policy (locked)

This package will only ever emit, parse, and reason about a **single**
multisig output script: `wsh(sortedmulti(N, key1, key2, ...))`. Every
descriptor builder, address generator, and PSBT helper is hard-wired to
that shape — there is no script-type parameter to flip.

The legacy nested-SegWit branch — P2SH-P2WSH (`sh(wsh(...))`) at BIP-48
`script_type = 1'` — is **not supported and will not be added**. Keeping
the cryptographic surface narrow is the whole point of this package; one
script means one set of derivation, signing, and finalisation paths to
audit.

Asylia's framework-agnostic Bitcoin core: descriptors, derivation helpers,
address generation, PSBT primitives, and script policy types. Everything in
this package is pure TypeScript with no DOM, no Vue, and no Asylia-specific
service dependencies, so it can be reused by:

- the Asylia wallet SPA (`@asylia/wallet`)
- a future Capacitor signer app
- backend tooling and audit harnesses
- third parties who want to verify what the wallet does to a key, a script,
  or a transaction

## Why MIT

Anything that touches Bitcoin keys, scripts, or transactions in this product
must be **auditable**. The MIT license is the dominant license in the
Bitcoin tooling ecosystem (`bitcoinjs-lib`, `@scure/btc-signer`,
`@trezor/connect`, `@ledgerhq/hw-app-btc`) and matches what reviewers and
contributors expect. The rest of the Asylia repository (apps, marketing,
shared UI) is proprietary; the OSS boundary stops at this package and its
sibling `hw-*` packages.

## Planned scope

Borrowed from the existing Asylia reference codebases (see the root README
"Reuse map" section), adapted to native-SegWit P2WSH multisig:

- `wallet/p2wsh.ts` — `createP2wshWallet()` builder using sorted child
  pubkeys, `p2ms`, and `p2wsh` (adapted from
  `asylia60/packages/asylia-wallets/p2wsh/wallet.ts` by removing the
  outer `p2sh()` wrap so the on-chain script is `wsh(sortedmulti(...))`).
- `wallet/derivation.ts` — BIP32 helpers, descriptor parsing.
  Default multisig branch: `m/48'/0'/0'/2'`.
- `psbt/build.ts`, `psbt/finalize.ts`, `psbt/inspect.ts` — PSBT lifecycle.
- `script/policy.ts` — `2-of-3`, `3-of-5`, ... discriminated unions.
- `address/generate.ts` — deterministic address derivation per policy.

## Already shipping

- `buildWshSortedMultiDescriptor()` — assembles the canonical
  `wsh(sortedmulti(...))#checksum` descriptor (plus BIP-389-free
  receive / change siblings for older tooling).
- `deriveWshSortedMultiAddress()` / `deriveWshSortedMultiAddressBatch()`
  — pure address derivation per `(chain, index)` slot.
- `buildWshSortedMultiInstance()` — same derivation but returns the
  bitcoinjs-lib payment instances for inspection / audit logging.
- `buildWshSortedMultiPsbt()` — full PSBT v2 (BIP-370) builder for a
  spend, complete with witness scripts, per-cosigner
  `bip32Derivation` blocks, and `nonWitnessUtxo` when callers provide
  each input's raw funding transaction.
- `extractPsbtInputs()` — read every PSBT input outpoint to drive the
  wallet-side "is this UTXO locked by another proposal?" check.
- `inspectPsbtV2()` — decode an existing PSBT v2 string into a typed
  view (inputs, outputs, bip32Derivation, partial sigs) hardware
  adapters can iterate over without touching `@caravan/psbt`.
- `addPartialSignaturesToPsbt()` — merge fresh partial signatures into
  a PSBT v2; appends the SIGHASH_ALL byte automatically.
- `bip32PathToAddressN()` — convert a printable BIP-32 path into the
  `address_n` array hardware wallets expect.
- `addressFromScript()` — decode a `scriptPubKey` back into the standard
  bech32 / base58 address; used by hardware adapters that need to
  render an outgoing recipient on the device.
- `selectCoinsLargestFirst()` / `maxSpendableSats()` — coin selection
  + max-amount helpers shared by the wallet's Send flow.

## Not in scope

This package does **not**:

- store seed phrases or private keys
- talk to any blockchain provider directly (that lives in a future
  `@asylia/blockchain-data-btc` package)
- depend on Vue, the DOM, Supabase, or any Asylia application module
- emit or accept any Bitcoin script other than `wsh(sortedmulti(...))` —
  no P2SH, no P2SH-P2WSH (`sh(wsh(...))`), no P2TR, no legacy P2PKH

If a feature requires any of the above, it does not belong here.

## Versioning + audit stance

The package is currently `0.0.0-dev`. Until it ships its first stable API
the public surface may break in any commit. Once an audit-ready API exists,
we will:

- publish under semantic versioning,
- maintain `CHANGELOG.md` (Keep-a-Changelog format),
- tag every audited release in git,
- and document the auditor + scope in `SECURITY.md`.

See [`SECURITY.md`](./SECURITY.md) for vulnerability disclosure.

## License

MIT — see [`LICENSE`](./LICENSE).
