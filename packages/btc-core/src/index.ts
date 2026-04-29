/**
 * `@asylia/btc-core` — Bitcoin primitives for the Asylia platform.
 *
 * Public surface (everything else is private to this package):
 *
 *   - `buildWshSortedMultiDescriptor()` — assemble the canonical
 *     `wsh(sortedmulti(...))#checksum` descriptor for a vault, plus the
 *     BIP-389-free `receiveDescriptor` / `changeDescriptor` siblings
 *     for older tooling.
 *   - `vaultIdentityKey()` — collapse a vault's policy + cosigner set
 *     into a deterministic identity string. Independent of the input
 *     order so logical duplicates (same keys re-listed in another
 *     order, re-imports from a different format) collide on the same
 *     value. Used by the wallet's create + import flows to short-
 *     circuit duplicate creation before the DB write fails.
 *   - `parseAsyliaVaultConfig()` / `parseCaravanWalletConfig()` /
 *     `parseSparrowWalletConfig()` / `parseDescriptorImport()` —
 *     normalise a native Asylia config, Caravan / Sparrow wallet backup
 *     JSON, or a raw BIP-380 descriptor (single multipath, a receive +
 *     change pair, or a Bitcoin Core `importdescriptors` JSON payload)
 *     into the same `ParsedMultisigImport` shape the create flow
 *     consumes. Validation is strict (P2WSH, mainnet, verified BIP-380
 *     checksum, valid xpubs / xfp / paths) so the importer rejects
 *     malformed input at the boundary instead of producing a broken
 *     vault row downstream.
 *   - `deriveWshSortedMultiAddress()` — given the same key set, derive
 *     the on-chain bech32 address for an arbitrary `(chain, index)`
 *     using `bitcoinjs-lib`'s `p2ms` + `p2wsh` payment factories.
 *   - `deriveWshSortedMultiAddressBatch()` — derive a contiguous range
 *     of `(chain, index)` addresses in one call. Optimised for
 *     gap-limit walkers (balance refresh, next-unused lookup).
 *   - `buildWshSortedMultiInstance()` — same derivation but returns the
 *     full bitcoinjs-lib payment instances (`p2wsh`, `p2ms`) so callers
 *     can inspect the underlying scripts (audit logging, PSBT build).
 *   - `parseBitcoinAddress()` / `describeBitcoinAddressType()` —
 *     classify a recipient address into one of the five standard
 *     mainnet templates (P2PKH / P2SH / P2WPKH / P2WSH / P2TR) with
 *     a stable error code (`empty`, `wrong_network`,
 *     `invalid_format`, `unknown_type`). Used by the SPA's send /
 *     pay-to forms to render green / red borders and a precise
 *     reason caption without re-implementing prefix and checksum
 *     logic in every screen.
 *   - `inspectPsbtV2()` — decode an existing PSBT v2 string into a
 *     typed view (inputs, outputs, bip32Derivation, partial sigs)
 *     hardware adapters can iterate over without touching `@caravan/psbt`.
 *   - `addPartialSignaturesToPsbt()` — merge fresh partial signatures
 *     into a PSBT v2 (sighash byte appended automatically).
 *   - `computeBip143SighashAll()`, `verifySegwitV0SignatureAgainstPubkey()`,
 *     `findSegwitV0SignatureOwner()` — post-flight verification:
 *     compute the BIP-143 SIGHASH_ALL hash for a PSBT input and
 *     verify that a partial signature really was produced by a
 *     given pubkey (or any of a set of cosigner pubkeys). Hardware
 *     adapters use this to catch wrong-attribution bugs before they
 *     reach broadcast.
 *   - `reverseTxidHex()` — flip a 64-char hex txid between display
 *     (big-endian) and on-the-wire (little-endian internal) order;
 *     used internally by the builder/inspector to honour BIP-370 but
 *     exposed so debug tooling can reproduce the same conversion.
 *   - `bip32PathToAddressN()` — convert a printable BIP-32 path into
 *     the `address_n` array hardware wallets expect.
 *   - `descriptorChecksum()` / `withChecksum()` — exposed so callers
 *     who already hold a descriptor body can attach a BIP-380 checksum
 *     without going through the full builder.
 *   - `toCanonicalXpub()` — re-encode a SLIP-132 prefix (`Zpub`,
 *     `zpub`, …) into the universal `xpub` form descriptors expect.
 *   - Public types: `BitcoinNetwork`, `ScriptPolicy`, `DescriptorKey`,
 *     `BuildWshSortedMultiInput`, `BuildWshSortedMultiResult`,
 *     `DeriveWshSortedMultiAddressInput`,
 *     `DeriveWshSortedMultiAddressBatchInput`,
 *     `WshSortedMultiAddressEntry`.
 *
 * Script policy is **locked**: only `wsh(sortedmulti(...))` is
 * supported. Nested-SegWit `sh(wsh(...))` (P2SH-P2WSH) is intentionally
 * not on the roadmap — see `README.md` for the rationale.
 *
 * Everything in this package is framework-agnostic (no Vue, no DOM) so
 * it can be reused by the wallet SPA, a future Capacitor signer app,
 * server tooling, and external auditors. See `README.md` and
 * `SECURITY.md` for the audit and contribution stance.
 */

export {
  buildWshSortedMultiDescriptor,
  DescriptorBuildError,
} from './descriptor/multisig';
export {
  vaultIdentityKey,
  VaultIdentityError,
  type VaultIdentityInput,
} from './identity';
export {
  parseAsyliaVaultConfig,
  parseCaravanWalletConfig,
  parseDescriptorImport,
  parseSparrowWalletConfig,
  MultisigImportError,
  type ImportedSignerDevice,
  type ParsedMultisigImport,
  type ParsedSigner,
} from './import';
export {
  descriptorChecksum,
  withChecksum,
} from './descriptor/checksum';
export {
  toCanonicalXpub,
  isFingerprint,
  isDerivationPathBody,
  stripMasterPrefix,
  canonicalizeDerivationPath,
  detectExtendedPubkeyNetwork,
  describeNonMainnetXpub,
  type ExtendedPubkeyNetwork,
} from './descriptor/normalize';
export {
  deriveWshSortedMultiAddress,
  deriveWshSortedMultiAddressBatch,
  buildWshSortedMultiInstance,
  AddressDeriveError,
  type WshSortedMultiInstance,
} from './address/derive';
export {
  parseBitcoinAddress,
  describeBitcoinAddressType,
  type BitcoinAddressType,
  type BitcoinAddressParseError,
  type ParsedBitcoinAddress,
} from './address/parse';

export {
  buildWshSortedMultiPsbt,
  extractPsbtInputs,
  reverseTxidHex,
  PsbtBuildError,
  type PsbtInputOutpoint,
} from './psbt/build';
export {
  inspectPsbtV2,
  addPartialSignaturesToPsbt,
  addressFromScript,
  bip32PathToAddressN,
  PsbtInspectError,
  type InspectedPsbt,
  type InspectedPsbtInput,
  type InspectedPsbtOutput,
  type PsbtBip32Derivation,
  type PsbtPartialSig,
  type PartialSignatureToAdd,
} from './psbt/inspect';
export {
  countPsbtSigners,
  collectSignerFingerprints,
  finaliseAndExtractTransaction,
  PsbtFinaliseError,
} from './psbt/finalize';
export {
  computeBip143SighashAll,
  verifySegwitV0SignatureAgainstPubkey,
  findSegwitV0SignatureOwner,
  findSegwitV0SignatureOwnerForPsbt,
  PsbtVerifyError,
} from './psbt/verify';
export {
  selectCoinsLargestFirst,
  selectCoinsLargestFirstFixedFee,
  maxSpendableSats,
  DEFAULT_DUST_THRESHOLD_SATS,
  DEFAULT_FIXED_VBYTES,
  DEFAULT_PER_INPUT_VBYTES,
  DEFAULT_CHANGE_OUTPUT_VBYTES,
  type CoinSelectInput,
  type CoinSelectResult,
  type FixedFeeCoinSelectInput,
  type FixedFeeCoinSelectResult,
  type MaxSpendableInput,
} from './psbt/coin-select';
export type {
  Utxo,
  Recipient,
  ChangeOutput,
  BuildWshSortedMultiPsbtInput,
  BuildWshSortedMultiPsbtResult,
} from './psbt/types';

export type {
  BitcoinNetwork,
  ScriptPolicy,
  DescriptorKey,
  BuildWshSortedMultiInput,
  BuildWshSortedMultiResult,
  DeriveWshSortedMultiAddressInput,
  DeriveWshSortedMultiAddressBatchInput,
  WshSortedMultiAddressEntry,
} from './types';

export const ASYLIA_BTC_CORE_VERSION = '0.1.0-dev' as const;
