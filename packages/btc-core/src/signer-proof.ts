import { Buffer } from 'buffer';
import { PsbtV2 } from '@caravan/psbt';
import { sha256 } from '@noble/hashes/sha256';
import { address as bitcoinAddress, payments, networks, Transaction } from 'bitcoinjs-lib';

import { bip32 } from './crypto/ecc';
import { stripMasterPrefix, toCanonicalXpub } from './descriptor/normalize';
import {
  PsbtBuildError,
  reverseTxidHex,
} from './psbt/build';
import { inspectPsbtV2 } from './psbt/inspect';
import { verifySegwitV0SignatureAgainstPubkey } from './psbt/verify';
import type { DescriptorKey } from './types';

export const ASYLIA_SIGNER_PROOF_CHAIN = 0 as const;
export const ASYLIA_SIGNER_PROOF_INDEX = 1_000_000 as const;
export const ASYLIA_SIGNER_PROOF_INPUT_SATS = 1_000 as const;
export const ASYLIA_SIGNER_PROOF_OUTPUT_SATS = 999 as const;

export type SignerProofSigner = {
  fingerprint: string;
  derivationRoot: string;
  xpub: string;
};

export type SignerProofPsbt = {
  psbtBase64: string;
  challengeHash: string;
  address: string;
  txid: string;
};

export class SignerProofError extends Error {
  override readonly name = 'SignerProofError';
}

export function buildSignerProofPsbt(input: {
  challengeMessage: string;
  signer: SignerProofSigner;
}): SignerProofPsbt {
  const challengeHash = sha256Hex(input.challengeMessage.trim());
  const key = descriptorKey(input.signer);
  const slot = signerProofSlot(key);
  const funding = fakeFundingTransaction(challengeHash, slot.address);
  const psbt = new PsbtV2();
  psbt.PSBT_GLOBAL_TX_VERSION = 2;
  psbt.PSBT_GLOBAL_FALLBACK_LOCKTIME = 0;
  psbt.addInput({
    previousTxId: reverseTxidHex(funding.getId()),
    outputIndex: 0,
    witnessUtxo: {
      amount: ASYLIA_SIGNER_PROOF_INPUT_SATS,
      script: slot.scriptPubKey,
    },
    nonWitnessUtxo: Buffer.from(funding.toHex(), 'hex'),
    witnessScript: slot.witnessScript,
    bip32Derivation: slot.bip32Derivation,
  });
  psbt.addOutput({
    amount: ASYLIA_SIGNER_PROOF_OUTPUT_SATS,
    script: slot.scriptPubKey,
    witnessScript: slot.witnessScript,
    bip32Derivation: slot.bip32Derivation,
  });

  return {
    psbtBase64: psbt.serialize('base64'),
    challengeHash,
    address: slot.address,
    txid: funding.getId(),
  };
}

export function verifySignerProofPsbt(input: {
  challengeMessage: string;
  signer: SignerProofSigner;
  proofPsbtBase64: string;
}): boolean {
  let expected;
  let actual;
  try {
    expected = inspectPsbtV2(buildSignerProofPsbt({
      challengeMessage: input.challengeMessage,
      signer: input.signer,
    }).psbtBase64);
    actual = inspectPsbtV2(input.proofPsbtBase64);
  } catch {
    return false;
  }

  if (actual.inputs.length !== 1 || actual.outputs.length !== 1) return false;
  if (expected.inputs.length !== 1 || expected.outputs.length !== 1) return false;

  const actualInput = actual.inputs[0]!;
  const expectedInput = expected.inputs[0]!;
  const actualOutput = actual.outputs[0]!;
  const expectedOutput = expected.outputs[0]!;

  if (actual.txVersion !== expected.txVersion) return false;
  if (actual.fallbackLocktime !== expected.fallbackLocktime) return false;
  if (actualInput.txid !== expectedInput.txid) return false;
  if (actualInput.vout !== expectedInput.vout) return false;
  if (actualInput.valueSats !== expectedInput.valueSats) return false;
  if (!bytesEqual(actualInput.scriptPubKey, expectedInput.scriptPubKey)) return false;
  if (!bytesEqual(actualInput.witnessScript, expectedInput.witnessScript)) return false;
  if (actualOutput.amountSats !== expectedOutput.amountSats) return false;
  if (!bytesEqual(actualOutput.scriptPubKey, expectedOutput.scriptPubKey)) return false;

  const actualDerivation = actualInput.bip32Derivation[0];
  const expectedDerivation = expectedInput.bip32Derivation[0];
  if (!actualDerivation || !expectedDerivation) return false;
  if (!bytesEqual(actualDerivation.pubkey, expectedDerivation.pubkey)) return false;
  if (!bytesEqual(actualDerivation.masterFingerprint, expectedDerivation.masterFingerprint)) return false;
  if (actualDerivation.path !== expectedDerivation.path) return false;

  const sig = actualInput.partialSigs.find((candidate) =>
    bytesEqual(candidate.pubkey, expectedDerivation.pubkey),
  );
  if (!sig) return false;

  return verifySegwitV0SignatureAgainstPubkey(
    actual,
    0,
    expectedDerivation.pubkey,
    sig.signature,
  );
}

function fakeFundingTransaction(challengeHash: string, address: string): Transaction {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.from(challengeHash, 'hex'), 0);
  tx.addOutput(
    bitcoinAddress.toOutputScript(address, networks.bitcoin),
    BigInt(ASYLIA_SIGNER_PROOF_INPUT_SATS),
  );
  return tx;
}

function signerProofSlot(key: DescriptorKey): {
  address: string;
  scriptPubKey: Buffer;
  witnessScript: Buffer;
  bip32Derivation: Array<{
    pubkey: Buffer;
    masterFingerprint: Buffer;
    path: string;
  }>;
} {
  const canonicalXpub = toCanonicalXpub(key.xpub);
  if (!canonicalXpub) {
    throw new PsbtBuildError('Signer proof xpub is not valid base58check.');
  }
  const node = bip32().fromBase58(canonicalXpub, networks.bitcoin);
  const child = node.derive(ASYLIA_SIGNER_PROOF_CHAIN).derive(ASYLIA_SIGNER_PROOF_INDEX);
  const pubkey = Buffer.from(child.publicKey);
  const p2ms = payments.p2ms({ m: 1, pubkeys: [pubkey], network: networks.bitcoin });
  const p2wsh = payments.p2wsh({ redeem: p2ms, network: networks.bitcoin });
  if (!p2wsh.address || !p2wsh.output || !p2ms.output) {
    throw new PsbtBuildError('bitcoinjs-lib returned an incomplete signer proof script.');
  }
  return {
    address: p2wsh.address,
    scriptPubKey: Buffer.from(p2wsh.output),
    witnessScript: Buffer.from(p2ms.output),
    bip32Derivation: [{
      pubkey,
      masterFingerprint: Buffer.from(key.fingerprint, 'hex'),
      path: `m/${key.derivationPath}/${ASYLIA_SIGNER_PROOF_CHAIN}/${ASYLIA_SIGNER_PROOF_INDEX}`,
    }],
  };
}

function descriptorKey(signer: SignerProofSigner): DescriptorKey {
  const fingerprint = signer.fingerprint.trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(fingerprint)) {
    throw new PsbtBuildError('Signer proof fingerprint must be 8 lowercase hex characters.');
  }
  const xpub = signer.xpub.trim();
  const derivationPath = stripMasterPrefix(signer.derivationRoot.trim());
  if (!xpub || !derivationPath) {
    throw new PsbtBuildError('Signer proof xpub and derivation root are required.');
  }
  return { fingerprint, derivationPath, xpub };
}

function sha256Hex(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
