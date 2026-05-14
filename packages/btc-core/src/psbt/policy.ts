import { Buffer } from 'buffer';
import { Transaction } from 'bitcoinjs-lib';

import { buildWshSortedMultiInstance } from '../address/derive.ts';
import { bip32 } from '../crypto/ecc.ts';
import { toCanonicalXpub } from '../descriptor/normalize.ts';
import { networkOf } from '../network.ts';
import type { BitcoinNetwork, DescriptorKey } from '../types.ts';
import {
  addressFromScript,
  inspectPsbtV2,
  type InspectedPsbt,
  type InspectedPsbtInput,
  type InspectedPsbtOutput,
} from './inspect.ts';
import { verifySegwitV0SignatureAgainstPubkey } from './verify.ts';

export type WshSortedMultiPsbtPolicyInputLock = {
  txid: string;
  vout: number;
  valueSats: number;
  chain: 0 | 1;
  addressIndex: number;
};

export type WshSortedMultiPsbtPolicyExpectedOutput = {
  address: string;
  amountSats: number;
};

export type WshSortedMultiPsbtPolicyExpectedChange =
  WshSortedMultiPsbtPolicyExpectedOutput & {
    chain: 1;
    index: number;
  };

export type WshSortedMultiPsbtPolicyInput = {
  psbtBase64: string;
  vault: {
    requiredSignatures: number;
    network: BitcoinNetwork;
    keys: readonly DescriptorKey[];
  };
  expectedInputs: readonly WshSortedMultiPsbtPolicyInputLock[];
  recipientAllowlist: readonly string[];
  expectedRecipient: WshSortedMultiPsbtPolicyExpectedOutput;
  expectedChange: WshSortedMultiPsbtPolicyExpectedChange | null;
  expectedVbytes: number;
  maxFeeSats: number;
  maxFeeRateSatsPerVByte: number;
  minAmountSats: number;
  maxAmountSats: number;
  expectedSignerFingerprint?: string;
  requiredSignedFingerprint?: string;
  finalRawTxHex?: string;
};

export type WshSortedMultiPsbtPolicyViolationCode =
  | 'invalid_psbt'
  | 'unsupported_network'
  | 'input_count_mismatch'
  | 'input_not_expected'
  | 'input_missing'
  | 'input_value_mismatch'
  | 'input_script_mismatch'
  | 'input_derivation_mismatch'
  | 'recipient_missing'
  | 'recipient_not_allowlisted'
  | 'recipient_amount_out_of_range'
  | 'change_output_count_mismatch'
  | 'change_output_mismatch'
  | 'fee_negative'
  | 'fee_too_high'
  | 'fee_rate_too_high'
  | 'invalid_vbytes'
  | 'signature_unknown_pubkey'
  | 'signature_invalid'
  | 'expected_signer_missing'
  | 'required_signer_signature_missing'
  | 'final_tx_invalid'
  | 'final_tx_output_mismatch';

export type WshSortedMultiPsbtPolicyViolation = {
  code: WshSortedMultiPsbtPolicyViolationCode;
  message: string;
  path?: string;
};

export type WshSortedMultiPsbtPolicySummary = {
  inputCount: number;
  outputCount: number;
  inputTotalSats: number;
  outputTotalSats: number;
  feeSats: number;
  feeRateSatsPerVByte: number | null;
  recipientAmountSats: number;
  changeAmountSats: number;
  signedFingerprints: readonly string[];
};

export type WshSortedMultiPsbtPolicyResult =
  | { ok: true; summary: WshSortedMultiPsbtPolicySummary }
  | {
      ok: false;
      violations: readonly WshSortedMultiPsbtPolicyViolation[];
      summary?: WshSortedMultiPsbtPolicySummary;
    };

type ExpectedDerivation = {
  fingerprint: string;
  path: string;
  pubkey: Uint8Array;
};

type OutputWithIndex = {
  index: number;
  output: InspectedPsbtOutput;
};

/**
 * Reusable PSBT safety gate for Asylia's current wallet policy:
 * native-SegWit `wsh(sortedmulti(...))`, mainnet, one external
 * recipient, and exactly one wallet change output.
 */
export function checkWshSortedMultiPsbtPolicy(
  input: WshSortedMultiPsbtPolicyInput,
): WshSortedMultiPsbtPolicyResult {
  const violations: WshSortedMultiPsbtPolicyViolation[] = [];
  let inspected: InspectedPsbt;
  try {
    inspected = inspectPsbtV2(input.psbtBase64);
  } catch (cause) {
    return {
      ok: false,
      violations: [{
        code: 'invalid_psbt',
        message: `PSBT could not be decoded: ${(cause as Error).message}`,
      }],
    };
  }

  const summary = buildSummary(inspected, input.expectedVbytes);

  if (input.vault.network !== 'mainnet') {
    violations.push({
      code: 'unsupported_network',
      message: `Only mainnet PSBTs are signable (got ${input.vault.network as string}).`,
      path: 'vault.network',
    });
  }

  validateInputs(input, inspected, violations);
  validateOutputs(input, inspected, violations);
  validateFees(input, summary, violations);
  validatePartialSignatures(input, inspected, violations);

  if (input.finalRawTxHex) {
    validateFinalRawTx(input.finalRawTxHex, inspected, violations);
  }

  if (violations.length > 0) {
    return { ok: false, violations, summary };
  }
  return { ok: true, summary };
}

function validateInputs(
  policy: WshSortedMultiPsbtPolicyInput,
  inspected: InspectedPsbt,
  violations: WshSortedMultiPsbtPolicyViolation[],
): void {
  const expected = new Map<string, WshSortedMultiPsbtPolicyInputLock>();
  for (const lock of policy.expectedInputs) {
    expected.set(outpointKey(lock.txid, lock.vout), lock);
  }

  if (inspected.inputs.length !== policy.expectedInputs.length) {
    violations.push({
      code: 'input_count_mismatch',
      message:
        `PSBT has ${inspected.inputs.length} input(s), expected ${policy.expectedInputs.length}.`,
      path: 'inputs',
    });
  }

  const seen = new Set<string>();
  for (let index = 0; index < inspected.inputs.length; index += 1) {
    const actual = inspected.inputs[index]!;
    const key = outpointKey(actual.txid, actual.vout);
    const lock = expected.get(key);
    if (!lock) {
      violations.push({
        code: 'input_not_expected',
        message: `Input ${actual.txid}:${actual.vout} is not an expected wallet lock.`,
        path: `inputs.${index}`,
      });
      continue;
    }
    seen.add(key);
    if (actual.valueSats !== lock.valueSats) {
      violations.push({
        code: 'input_value_mismatch',
        message:
          `Input ${actual.txid}:${actual.vout} value is ${actual.valueSats} sats, expected ${lock.valueSats}.`,
        path: `inputs.${index}.valueSats`,
      });
    }
    validateWalletInputSlot(policy, actual, lock, index, violations);
  }

  for (const lock of policy.expectedInputs) {
    const key = outpointKey(lock.txid, lock.vout);
    if (!seen.has(key)) {
      violations.push({
        code: 'input_missing',
        message: `Expected input ${lock.txid}:${lock.vout} is missing from the PSBT.`,
        path: 'inputs',
      });
    }
  }
}

function validateWalletInputSlot(
  policy: WshSortedMultiPsbtPolicyInput,
  actual: InspectedPsbtInput,
  lock: WshSortedMultiPsbtPolicyInputLock,
  inputIndex: number,
  violations: WshSortedMultiPsbtPolicyViolation[],
): void {
  let instance;
  let expectedDerivations: readonly ExpectedDerivation[];
  try {
    instance = buildWshSortedMultiInstance({
      requiredSignatures: policy.vault.requiredSignatures,
      keys: policy.vault.keys,
      network: 'mainnet',
      chain: lock.chain,
      index: lock.addressIndex,
    });
    expectedDerivations = deriveExpectedDerivations(
      policy.vault.keys,
      'mainnet',
      lock.chain,
      lock.addressIndex,
    );
  } catch (cause) {
    violations.push({
      code: 'input_derivation_mismatch',
      message: `Could not derive expected wallet input slot: ${(cause as Error).message}`,
      path: `inputs.${inputIndex}.bip32Derivation`,
    });
    return;
  }

  if (
    !bytesEqual(actual.scriptPubKey, instance.p2wsh.output ?? new Uint8Array()) ||
    !bytesEqual(actual.witnessScript, instance.p2ms.output ?? new Uint8Array())
  ) {
    violations.push({
      code: 'input_script_mismatch',
      message:
        `Input ${actual.txid}:${actual.vout} script does not match vault slot ${lock.chain}/${lock.addressIndex}.`,
      path: `inputs.${inputIndex}.scriptPubKey`,
    });
  }

  validateDerivationBlock(
    actual.bip32Derivation,
    expectedDerivations,
    `inputs.${inputIndex}.bip32Derivation`,
    violations,
  );
}

function validateOutputs(
  policy: WshSortedMultiPsbtPolicyInput,
  inspected: InspectedPsbt,
  violations: WshSortedMultiPsbtPolicyViolation[],
): void {
  const allowlist = new Set(
    policy.recipientAllowlist.map((address) => address.trim().toLowerCase()),
  );
  const changeCandidates = inspected.outputs
    .map((output, index) => ({ index, output }))
    .filter(({ output }) => output.witnessScript !== null || output.bip32Derivation.length > 0);

  if (!policy.expectedChange) {
    if (changeCandidates.length !== 0) {
      violations.push({
        code: 'change_output_count_mismatch',
        message: `PSBT must not include wallet change for this no-change spend (got ${changeCandidates.length}).`,
        path: 'outputs',
      });
    }
  } else if (changeCandidates.length !== 1) {
    violations.push({
      code: 'change_output_count_mismatch',
      message: `PSBT must have exactly one wallet change output (got ${changeCandidates.length}).`,
      path: 'outputs',
    });
  } else {
    validateChangeOutput(policy, changeCandidates[0]!, violations);
  }

  const changeIndexes = new Set(changeCandidates.map((candidate) => candidate.index));
  let expectedRecipientSeen = false;
  for (let index = 0; index < inspected.outputs.length; index += 1) {
    const output = inspected.outputs[index]!;
    if (changeIndexes.has(index)) continue;
    const address = addressFromScript(output.scriptPubKey, 'mainnet');
    if (!address || !allowlist.has(address.toLowerCase())) {
      violations.push({
        code: 'recipient_not_allowlisted',
        message: address
          ? `Output ${index} pays a non-allowlisted recipient address (${address}).`
          : `Output ${index} is not a standard mainnet recipient script.`,
        path: `outputs.${index}.scriptPubKey`,
      });
      continue;
    }
    if (
      address.toLowerCase() === policy.expectedRecipient.address.trim().toLowerCase() &&
      output.amountSats === policy.expectedRecipient.amountSats
    ) {
      expectedRecipientSeen = true;
    }
  }

  if (!expectedRecipientSeen) {
    violations.push({
      code: 'recipient_missing',
      message:
        `Expected recipient ${policy.expectedRecipient.address} for ${policy.expectedRecipient.amountSats} sats is missing.`,
      path: 'outputs',
    });
  }

  if (
    policy.expectedRecipient.amountSats < policy.minAmountSats ||
    policy.expectedRecipient.amountSats > policy.maxAmountSats
  ) {
    violations.push({
      code: 'recipient_amount_out_of_range',
      message:
        `Recipient amount ${policy.expectedRecipient.amountSats} sats is outside policy interval ${policy.minAmountSats}-${policy.maxAmountSats}.`,
      path: 'expectedRecipient.amountSats',
    });
  }
}

function validateChangeOutput(
  policy: WshSortedMultiPsbtPolicyInput,
  candidate: OutputWithIndex,
  violations: WshSortedMultiPsbtPolicyViolation[],
): void {
  const expectedChange = policy.expectedChange;
  if (!expectedChange) return;
  let instance;
  let expectedDerivations: readonly ExpectedDerivation[];
  try {
    instance = buildWshSortedMultiInstance({
      requiredSignatures: policy.vault.requiredSignatures,
      keys: policy.vault.keys,
      network: 'mainnet',
      chain: expectedChange.chain,
      index: expectedChange.index,
    });
    expectedDerivations = deriveExpectedDerivations(
      policy.vault.keys,
      'mainnet',
      expectedChange.chain,
      expectedChange.index,
    );
  } catch (cause) {
    violations.push({
      code: 'change_output_mismatch',
      message: `Could not derive expected change slot: ${(cause as Error).message}`,
      path: `outputs.${candidate.index}`,
    });
    return;
  }

  const address = addressFromScript(candidate.output.scriptPubKey, 'mainnet');
  if (
    candidate.output.amountSats !== expectedChange.amountSats ||
    address?.toLowerCase() !== expectedChange.address.trim().toLowerCase() ||
    !bytesEqual(candidate.output.scriptPubKey, instance.p2wsh.output ?? new Uint8Array()) ||
    !bytesEqual(candidate.output.witnessScript ?? new Uint8Array(), instance.p2ms.output ?? new Uint8Array())
  ) {
    violations.push({
      code: 'change_output_mismatch',
      message:
        `Change output ${candidate.index} does not match expected wallet change ${expectedChange.address}:${expectedChange.amountSats}.`,
      path: `outputs.${candidate.index}`,
    });
  }

  validateDerivationBlock(
    candidate.output.bip32Derivation,
    expectedDerivations,
    `outputs.${candidate.index}.bip32Derivation`,
    violations,
  );
}

function validateFees(
  policy: WshSortedMultiPsbtPolicyInput,
  summary: WshSortedMultiPsbtPolicySummary,
  violations: WshSortedMultiPsbtPolicyViolation[],
): void {
  if (summary.feeSats < 0) {
    violations.push({
      code: 'fee_negative',
      message: `PSBT outputs exceed inputs by ${Math.abs(summary.feeSats)} sats.`,
      path: 'feeSats',
    });
  }
  if (summary.feeSats > policy.maxFeeSats) {
    violations.push({
      code: 'fee_too_high',
      message: `PSBT fee is ${summary.feeSats} sats, policy cap is ${policy.maxFeeSats}.`,
      path: 'feeSats',
    });
  }
  if (!Number.isFinite(policy.expectedVbytes) || policy.expectedVbytes <= 0) {
    violations.push({
      code: 'invalid_vbytes',
      message: `Expected vbytes must be a positive number (got ${policy.expectedVbytes}).`,
      path: 'expectedVbytes',
    });
    return;
  }
  if (
    summary.feeRateSatsPerVByte !== null &&
    summary.feeRateSatsPerVByte > policy.maxFeeRateSatsPerVByte
  ) {
    violations.push({
      code: 'fee_rate_too_high',
      message:
        `PSBT feerate is ${summary.feeRateSatsPerVByte.toFixed(8)} sat/vB, policy cap is ${policy.maxFeeRateSatsPerVByte}.`,
      path: 'feeRateSatsPerVByte',
    });
  }
}

function validatePartialSignatures(
  policy: WshSortedMultiPsbtPolicyInput,
  inspected: InspectedPsbt,
  violations: WshSortedMultiPsbtPolicyViolation[],
): void {
  const vaultFingerprints = new Set(
    policy.vault.keys.map((key) => key.fingerprint.trim().toLowerCase()),
  );
  const expectedSigner = policy.expectedSignerFingerprint?.trim().toLowerCase();
  const requiredSigned = policy.requiredSignedFingerprint?.trim().toLowerCase();

  for (let inputIndex = 0; inputIndex < inspected.inputs.length; inputIndex += 1) {
    const psbtInput = inspected.inputs[inputIndex]!;
    if (
      expectedSigner &&
      !psbtInput.bip32Derivation.some((entry) =>
        bytesToHex(entry.masterFingerprint) === expectedSigner
      )
    ) {
      violations.push({
        code: 'expected_signer_missing',
        message: `Input ${inputIndex} does not contain derivation data for signer ${expectedSigner}.`,
        path: `inputs.${inputIndex}.bip32Derivation`,
      });
    }

    const signedFingerprints = new Set<string>();
    for (const sig of psbtInput.partialSigs) {
      const owner = psbtInput.bip32Derivation.find((entry) =>
        bytesEqual(entry.pubkey, sig.pubkey)
      );
      if (!owner) {
        violations.push({
          code: 'signature_unknown_pubkey',
          message: `Input ${inputIndex} carries a partial signature for an unknown pubkey.`,
          path: `inputs.${inputIndex}.partialSigs`,
        });
        continue;
      }
      const fingerprint = bytesToHex(owner.masterFingerprint);
      if (!vaultFingerprints.has(fingerprint)) {
        violations.push({
          code: 'signature_unknown_pubkey',
          message: `Input ${inputIndex} signature owner ${fingerprint} is not a vault signer.`,
          path: `inputs.${inputIndex}.partialSigs`,
        });
      }
      if (
        !verifySegwitV0SignatureAgainstPubkey(
          inspected,
          inputIndex,
          sig.pubkey,
          sig.signature,
        )
      ) {
        violations.push({
          code: 'signature_invalid',
          message: `Input ${inputIndex} partial signature does not verify against its claimed pubkey.`,
          path: `inputs.${inputIndex}.partialSigs`,
        });
      }
      signedFingerprints.add(fingerprint);
    }

    if (requiredSigned && !signedFingerprints.has(requiredSigned)) {
      violations.push({
        code: 'required_signer_signature_missing',
        message: `Input ${inputIndex} is not signed by expected signer ${requiredSigned}.`,
        path: `inputs.${inputIndex}.partialSigs`,
      });
    }
  }
}

function validateFinalRawTx(
  finalRawTxHex: string,
  inspected: InspectedPsbt,
  violations: WshSortedMultiPsbtPolicyViolation[],
): void {
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(finalRawTxHex);
  } catch (cause) {
    violations.push({
      code: 'final_tx_invalid',
      message: `Final raw transaction could not be decoded: ${(cause as Error).message}`,
      path: 'finalRawTxHex',
    });
    return;
  }

  if (tx.outs.length !== inspected.outputs.length) {
    violations.push({
      code: 'final_tx_output_mismatch',
      message:
        `Final transaction has ${tx.outs.length} output(s), PSBT has ${inspected.outputs.length}.`,
      path: 'finalRawTxHex.outputs',
    });
    return;
  }

  for (let index = 0; index < tx.outs.length; index += 1) {
    const txOutput = tx.outs[index]!;
    const psbtOutput = inspected.outputs[index]!;
    if (
      Number(txOutput.value) !== psbtOutput.amountSats ||
      !bytesEqual(txOutput.script, psbtOutput.scriptPubKey)
    ) {
      violations.push({
        code: 'final_tx_output_mismatch',
        message: `Final transaction output ${index} does not match the PSBT output.`,
        path: `finalRawTxHex.outputs.${index}`,
      });
    }
  }
}

function validateDerivationBlock(
  actual: InspectedPsbtInput['bip32Derivation'],
  expected: readonly ExpectedDerivation[],
  path: string,
  violations: WshSortedMultiPsbtPolicyViolation[],
): void {
  if (actual.length !== expected.length) {
    violations.push({
      code: 'input_derivation_mismatch',
      message: `Derivation block has ${actual.length} entrie(s), expected ${expected.length}.`,
      path,
    });
  }

  const expectedFingerprints = new Set(expected.map((entry) => entry.fingerprint));
  for (const entry of actual) {
    const fingerprint = bytesToHex(entry.masterFingerprint);
    if (!expectedFingerprints.has(fingerprint)) {
      violations.push({
        code: 'input_derivation_mismatch',
        message: `Derivation block contains unknown signer fingerprint ${fingerprint}.`,
        path,
      });
    }
  }

  for (const entry of expected) {
    const actualEntry = actual.find((candidate) =>
      bytesToHex(candidate.masterFingerprint) === entry.fingerprint
    );
    if (!actualEntry) {
      violations.push({
        code: 'input_derivation_mismatch',
        message: `Derivation block is missing signer fingerprint ${entry.fingerprint}.`,
        path,
      });
      continue;
    }
    if (
      normalizePath(actualEntry.path) !== normalizePath(entry.path) ||
      !bytesEqual(actualEntry.pubkey, entry.pubkey)
    ) {
      violations.push({
        code: 'input_derivation_mismatch',
        message: `Derivation for signer ${entry.fingerprint} does not match expected path/pubkey.`,
        path,
      });
    }
  }
}

function buildSummary(
  inspected: InspectedPsbt,
  expectedVbytes: number,
): WshSortedMultiPsbtPolicySummary {
  const inputTotalSats = inspected.inputs.reduce(
    (sum, input) => sum + input.valueSats,
    0,
  );
  const outputTotalSats = inspected.outputs.reduce(
    (sum, output) => sum + output.amountSats,
    0,
  );
  const feeSats = inputTotalSats - outputTotalSats;
  const signedFingerprints = new Set<string>();
  for (const psbtInput of inspected.inputs) {
    for (const sig of psbtInput.partialSigs) {
      const owner = psbtInput.bip32Derivation.find((entry) =>
        bytesEqual(entry.pubkey, sig.pubkey)
      );
      if (owner) signedFingerprints.add(bytesToHex(owner.masterFingerprint));
    }
  }
  const changeOutputs = inspected.outputs.filter((output) =>
    output.witnessScript !== null || output.bip32Derivation.length > 0
  );
  return {
    inputCount: inspected.inputs.length,
    outputCount: inspected.outputs.length,
    inputTotalSats,
    outputTotalSats,
    feeSats,
    feeRateSatsPerVByte: expectedVbytes > 0 ? feeSats / expectedVbytes : null,
    recipientAmountSats: 0,
    changeAmountSats: changeOutputs.reduce((sum, output) => sum + output.amountSats, 0),
    signedFingerprints: Array.from(signedFingerprints).sort(),
  };
}

function deriveExpectedDerivations(
  keys: readonly DescriptorKey[],
  network: BitcoinNetwork,
  chain: 0 | 1,
  index: number,
): readonly ExpectedDerivation[] {
  const factory = bip32();
  const resolvedNetwork = networkOf(network);
  return keys.map((key, keyIndex) => {
    const xpub = toCanonicalXpub(key.xpub.trim());
    if (xpub === null) {
      throw new Error(`Key #${keyIndex + 1}: xpub could not be canonicalised.`);
    }
    const node = factory.fromBase58(xpub, resolvedNetwork);
    const child = node.derive(chain).derive(index);
    const root = stripLeadingMaster(key.derivationPath);
    return {
      fingerprint: key.fingerprint.trim().toLowerCase(),
      path: root.length > 0 ? `m/${root}/${chain}/${index}` : `m/${chain}/${index}`,
      pubkey: child.publicKey as Uint8Array,
    };
  });
}

function outpointKey(txid: string, vout: number): string {
  return `${txid.trim().toLowerCase()}:${vout}`;
}

function stripLeadingMaster(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === 'm' || trimmed === 'M') return '';
  if (trimmed.startsWith('m/') || trimmed.startsWith('M/')) return trimmed.slice(2);
  return trimmed;
}

function normalizePath(path: string): string {
  return path.trim().replace(/h/gi, "'").replace(/^M\//, 'm/');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
