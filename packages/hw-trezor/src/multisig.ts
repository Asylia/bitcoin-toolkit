/**
 * Shared Trezor multisig wire-shape helpers.
 *
 * Trezor Connect represents `wsh(sortedmulti(...))` wallets as a
 * `multisig` block: one account-level HD node per cosigner, the
 * receive/change leaf suffix, the threshold, and an explicit
 * lexicographic ordering flag. Both signing and address-display flows
 * must build this shape identically or the device will reason about a
 * different wallet than the one Asylia derives locally.
 */
import bs58check from 'bs58check';
import type { DescriptorKey, PsbtBip32Derivation } from '@asylia/btc-core';

/** Minimal HD-node shape Trezor's protobuf accepts for multisig pubkeys. */
export type TrezorHDNode = {
  depth: number;
  fingerprint: number;
  child_num: number;
  chain_code: string;
  public_key: string;
};

/** One cosigner entry in a Trezor multisig block. */
export type TrezorMultisigEntry = {
  node: TrezorHDNode;
  address_n: number[];
};

export type TrezorMultisig = {
  pubkeys: TrezorMultisigEntry[];
  signatures: string[];
  m: number;
  pubkeys_order: number;
};

export type TrezorCosignerNode = {
  key: DescriptorKey;
  node: TrezorHDNode;
};

/**
 * Trezor's own enum: `MultisigPubkeysOrder.LEXICOGRAPHIC = 1`. Mirrored
 * here as a literal so the adapter does not have to import the SDK's
 * internal enum module.
 */
const MULTISIG_PUBKEYS_ORDER_LEXICOGRAPHIC = 1;

export function buildTrezorCosignerNodes(
  keys: readonly DescriptorKey[],
): TrezorCosignerNode[] {
  return keys.map((key) => ({
    key,
    node: parseXpubToHDNode(key.xpub.trim()),
  }));
}

export function buildTrezorMultisigBlock(params: {
  cosignerNodes: readonly TrezorCosignerNode[];
  requiredSignatures: number;
  chain: 0 | 1;
  index: number;
  /**
   * Optional PSBT bip32Derivation block for signing. Address display has
   * no existing signatures, so it omits this and receives an all-empty
   * signatures array.
   */
  bip32Derivation?: readonly PsbtBip32Derivation[];
  existingPartialSigs?: readonly { pubkey: Uint8Array; signature: Uint8Array }[];
}): TrezorMultisig {
  const pubkeys = params.cosignerNodes.map((cosigner) => ({
    node: cosigner.node,
    address_n: [params.chain, params.index],
  }));

  const entries = params.bip32Derivation ?? [];
  const existingPartialSigs = params.existingPartialSigs ?? [];
  const signatures = params.cosignerNodes.map((cosigner) => {
    const fp = cosigner.key.fingerprint.toLowerCase();
    const entry = entries.find((candidate) => bytesToHex(candidate.masterFingerprint) === fp);
    if (!entry) return '';
    const existing = existingPartialSigs.find((sig) => bytesEqual(sig.pubkey, entry.pubkey));
    if (!existing) return '';
    return bytesToHex(existing.signature.slice(0, existing.signature.length - 1));
  });

  return {
    pubkeys,
    signatures,
    m: params.requiredSignatures,
    pubkeys_order: MULTISIG_PUBKEYS_ORDER_LEXICOGRAPHIC,
  };
}

/**
 * Decode a base58check-encoded extended public key into the Trezor
 * `HDNodeType` shape. The byte layout is fixed by BIP-32 and is the
 * same regardless of SLIP-132 prefix.
 */
export function parseXpubToHDNode(xpub: string): TrezorHDNode {
  let decoded: Uint8Array;
  try {
    decoded = bs58check.decode(xpub);
  } catch (cause) {
    throw new Error(
      `Cosigner xpub is not valid base58check: ${(cause as Error).message}`,
      { cause },
    );
  }
  if (decoded.length !== 78) {
    throw new Error(
      `Cosigner xpub has unexpected length ${decoded.length} (expected 78).`,
    );
  }
  const view = new DataView(
    decoded.buffer,
    decoded.byteOffset,
    decoded.byteLength,
  );
  return {
    depth: decoded[4]!,
    fingerprint: view.getUint32(5, false),
    child_num: view.getUint32(9, false),
    chain_code: bytesToHex(decoded.slice(13, 45)),
    public_key: bytesToHex(decoded.slice(45, 78)),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
