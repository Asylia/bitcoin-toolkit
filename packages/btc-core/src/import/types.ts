/**
 * Shared types for the multisig import parsers.
 *
 * Caravan, Sparrow, and our own Asylia export all describe the same
 * underlying object — a P2WSH `sortedmulti` vault — but each tool uses
 * a slightly different field naming scheme. The parsers in this folder
 * normalise the inputs into this single `ParsedMultisigImport` shape so
 * downstream code (the create-vault flow) can stay format-agnostic.
 */
import type { ScriptPolicy } from '../types';

/** Errors raised by the import parsers. */
export class MultisigImportError extends Error {
  override readonly name = 'MultisigImportError';
}

/** Hardware family extracted from the import payload, when known. */
export type ImportedSignerDevice =
  | 'trezor'
  | 'ledger'
  | 'coldcard'
  | 'bitbox'
  | 'jade'
  | 'specter'
  | 'unknown';

/**
 * One cosigner from a parsed import payload.
 *
 * `fingerprint` and `derivationPath` come from the source file verbatim
 * (after lowercase + `m/` strip) so the parser does not lose
 * information needed by the descriptor builder. `xpub` is preserved in
 * the source's prefix form (`xpub`, `Zpub`, …); the consumer is
 * expected to feed it through `toCanonicalXpub` before persisting.
 */
export type ParsedSigner = {
  /** Master fingerprint, 8 lowercase hex characters. */
  fingerprint: string;
  /** BIP-32 derivation path body, no leading `m/`. */
  derivationPath: string;
  /** BIP-32 extended public key in any SLIP-132 prefix form. */
  xpub: string;
  /** Original cosigner label from the file, when provided. */
  name?: string;
  /** Hardware family hint, when the source mentions it. */
  device?: ImportedSignerDevice;
  /** Free-form model hint (`Trezor Safe 5`, `Ledger Nano X`, …). */
  modelHint?: string;
};

/**
 * Normalised multisig import payload.
 *
 * Holds everything the create-vault flow needs to reconstruct the vault
 * locally: the policy, the cosigners, and the suggested wallet name.
 * The descriptor itself, when present in the source file, is forwarded
 * as a sanity-check anchor so the consumer can compare it against the
 * descriptor it builds from the parsed keys before writing to the DB.
 */
export type ParsedMultisigImport = {
  /** Suggested wallet name, derived from the source file's label. */
  name: string;
  /** Output script policy. Always `wsh-sortedmulti` for now. */
  scriptPolicy: ScriptPolicy;
  /** Threshold (`N` in `N-of-T`). */
  requiredSignatures: number;
  /** Total cosigning keys (`T`). Equals `signers.length`. */
  totalKeys: number;
  /** Cosigners in the order they appeared in the source file. */
  signers: readonly ParsedSigner[];
  /**
   * Verbatim descriptor string from the source file when one was
   * shipped (Caravan, Sparrow `defaultPolicy.miniscript`, Asylia
   * native). Useful as a sanity-check against the descriptor the
   * consumer rebuilds from `signers` before persisting.
   */
  sourceDescriptor?: string;
  /** Source the payload was parsed from. */
  source: 'caravan' | 'sparrow' | 'asylia' | 'descriptor';
};
