import { Buffer } from 'buffer';
import * as ecc from '@bitcoinerlab/secp256k1';
import { PsbtV2 } from '@caravan/psbt';
import { address as bitcoinAddress, networks, Transaction } from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';

import {
  addPartialSignaturesToPsbt,
  buildWshSortedMultiPsbt,
  checkWshSortedMultiPsbtPolicy,
  computeBip143SighashAll,
  deriveWshSortedMultiAddress,
  finaliseAndExtractTransaction,
  inspectPsbtV2,
  type BitcoinNetwork,
  type Utxo,
  type WshSortedMultiPsbtPolicyInput,
  type WshSortedMultiPsbtPolicyViolationCode,
} from '../index';
import { makeSyntheticBitcoinFixture, type SyntheticBitcoinFixture } from '../__fixtures__/bitcoin';

const POLICY_MIN_AMOUNT_SATS = 500;
const POLICY_MAX_AMOUNT_SATS = 5_000;
const POLICY_MAX_FEE_SATS = 1_000;
const POLICY_MAX_FEE_RATE = 5;
const POLICY_VBYTES = 200;

describe('checkWshSortedMultiPsbtPolicy', () => {
  it('accepts a safe unsigned fixture before device signing', () => {
    const context = policyFixture();

    expect(checkWshSortedMultiPsbtPolicy(context.policy)).toMatchObject({
      ok: true,
      summary: {
        inputCount: 1,
        outputCount: 2,
        feeSats: 1_000,
        feeRateSatsPerVByte: 5,
      },
    });
  });

  it('accepts a threshold-signed PSBT and matching final raw transaction', () => {
    const context = policyFixture();
    const signed = signPsbt(context.policy.psbtBase64, context.fixture, [0, 1]);
    const final = finaliseAndExtractTransaction(signed);

    expect(checkWshSortedMultiPsbtPolicy({
      ...context.policy,
      psbtBase64: signed,
      requiredSignedFingerprint: context.fixture.signers[0]!.descriptor.fingerprint,
      finalRawTxHex: final.hex,
    })).toMatchObject({
      ok: true,
      summary: {
        signedFingerprints: [
          context.fixture.signers[0]!.descriptor.fingerprint,
          context.fixture.signers[1]!.descriptor.fingerprint,
        ].sort(),
      },
    });
  });

  it('accepts a safe no-change spend when the policy expects the wallet to be drained', () => {
    const context = policyFixture();
    const psbtBase64 = buildWshSortedMultiPsbt({
      vault: context.policy.vault,
      utxos: context.fixture.utxos,
      recipients: [{ address: context.fixture.recipientAddress, amountSats: 5_000 }],
      change: null,
    }).psbtBase64;

    expect(checkWshSortedMultiPsbtPolicy({
      ...context.policy,
      psbtBase64,
      expectedChange: null,
      maxFeeSats: 200_000,
      maxFeeRateSatsPerVByte: 1_000,
    })).toMatchObject({
      ok: true,
      summary: {
        outputCount: 1,
        changeAmountSats: 0,
      },
    });
  });

  it.each([
    [
      'extra input',
      () => {
        const context = policyFixture();
        const second = makeFundingUtxo(context.fixture.receiveAddress, 2, 10_000);
        return {
          ...context.policy,
          psbtBase64: buildWshSortedMultiPsbt({
            vault: context.policy.vault,
            utxos: [...context.fixture.utxos, second],
            recipients: [{ address: context.fixture.recipientAddress, amountSats: 5_000 }],
            change: {
              address: context.fixture.changeAddress,
              chain: 1,
              index: 0,
              amountSats: 154_000,
            },
          }).psbtBase64,
          expectedChange: {
            ...context.policy.expectedChange!,
            amountSats: 154_000,
          },
        };
      },
      'input_count_mismatch',
    ],
    [
      'missing input',
      () => {
        const context = policyFixture();
        const second = makeFundingUtxo(context.fixture.receiveAddress, 2, 10_000);
        return {
          ...context.policy,
          expectedInputs: [
            ...context.policy.expectedInputs,
            {
              txid: second.txid,
              vout: second.vout,
              valueSats: second.valueSats,
              chain: second.chain,
              addressIndex: second.index,
            },
          ],
        };
      },
      'input_count_mismatch',
    ],
    [
      'foreign input',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          expectedInputs: [{
            ...context.policy.expectedInputs[0]!,
            txid: 'b'.repeat(64),
          }],
        };
      },
      'input_not_expected',
    ],
    [
      'wrong UTXO value',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          expectedInputs: [{
            ...context.policy.expectedInputs[0]!,
            valueSats: context.policy.expectedInputs[0]!.valueSats - 1,
          }],
        };
      },
      'input_value_mismatch',
    ],
    [
      'non-allowlisted recipient',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          recipientAllowlist: [context.fixture.changeAddress],
        };
      },
      'recipient_not_allowlisted',
    ],
    [
      'amount outside test interval',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          maxAmountSats: 4_999,
        };
      },
      'recipient_amount_out_of_range',
    ],
    [
      'unexpected change in a no-change policy',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          expectedChange: null,
        };
      },
      'change_output_count_mismatch',
    ],
    [
      'multiple change outputs',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          psbtBase64: addDuplicateChangeOutput(context.policy.psbtBase64),
        };
      },
      'change_output_count_mismatch',
    ],
    [
      'wrong change',
      () => {
        const context = policyFixture();
        const changeAddress = deriveWshSortedMultiAddress({
          requiredSignatures: context.policy.vault.requiredSignatures,
          network: 'mainnet',
          keys: context.policy.vault.keys,
          chain: 1,
          index: 1,
        });
        return {
          ...context.policy,
          expectedChange: {
            ...context.policy.expectedChange!,
            address: changeAddress,
            index: 1,
          },
        };
      },
      'change_output_mismatch',
    ],
    [
      'fee too high',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          maxFeeSats: 999,
        };
      },
      'fee_too_high',
    ],
    [
      'feerate too high',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          maxFeeRateSatsPerVByte: 4.99,
        };
      },
      'fee_rate_too_high',
    ],
    [
      'wrong network',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          vault: {
            ...context.policy.vault,
            network: 'testnet' as BitcoinNetwork,
          },
        };
      },
      'unsupported_network',
    ],
    [
      'bad derivation path',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          expectedInputs: [{
            ...context.policy.expectedInputs[0]!,
            addressIndex: 1,
          }],
        };
      },
      'input_script_mismatch',
    ],
    [
      'wrong signer partial sig',
      () => {
        const context = policyFixture();
        return {
          ...context.policy,
          psbtBase64: signPsbt(context.policy.psbtBase64, context.fixture, [1]),
          requiredSignedFingerprint: context.fixture.signers[0]!.descriptor.fingerprint,
        };
      },
      'required_signer_signature_missing',
    ],
    [
      'final raw tx output mismatch',
      () => {
        const context = policyFixture();
        const signed = signPsbt(context.policy.psbtBase64, context.fixture, [0, 1]);
        const final = finaliseAndExtractTransaction(signed);
        const tx = Transaction.fromHex(final.hex);
        tx.outs[0]!.value = BigInt(Number(tx.outs[0]!.value) - 1);
        return {
          ...context.policy,
          psbtBase64: signed,
          finalRawTxHex: tx.toHex(),
        };
      },
      'final_tx_output_mismatch',
    ],
  ] satisfies readonly [
    string,
    () => WshSortedMultiPsbtPolicyInput,
    WshSortedMultiPsbtPolicyViolationCode,
  ][])('rejects %s', (_, makePolicy, expectedCode) => {
    expectViolation(makePolicy(), expectedCode);
  });
});

function policyFixture(): {
  fixture: SyntheticBitcoinFixture;
  policy: WshSortedMultiPsbtPolicyInput;
} {
  const fixture = makeSyntheticBitcoinFixture();
  const psbtBase64 = buildWshSortedMultiPsbt({
    vault: {
      requiredSignatures: fixture.requiredSignatures,
      network: 'mainnet',
      keys: fixture.descriptors,
    },
    utxos: fixture.utxos,
    recipients: [{ address: fixture.recipientAddress, amountSats: 5_000 }],
    change: {
      address: fixture.changeAddress,
      chain: 1,
      index: 0,
      amountSats: 144_000,
    },
  }).psbtBase64;

  return {
    fixture,
    policy: {
      psbtBase64,
      vault: {
        requiredSignatures: fixture.requiredSignatures,
        network: 'mainnet',
        keys: fixture.descriptors,
      },
      expectedInputs: fixture.utxos.map((utxo) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        valueSats: utxo.valueSats,
        chain: utxo.chain,
        addressIndex: utxo.index,
      })),
      recipientAllowlist: [fixture.recipientAddress],
      expectedRecipient: {
        address: fixture.recipientAddress,
        amountSats: 5_000,
      },
      expectedChange: {
        address: fixture.changeAddress,
        amountSats: 144_000,
        chain: 1,
        index: 0,
      },
      expectedVbytes: POLICY_VBYTES,
      maxFeeSats: POLICY_MAX_FEE_SATS,
      maxFeeRateSatsPerVByte: POLICY_MAX_FEE_RATE,
      minAmountSats: POLICY_MIN_AMOUNT_SATS,
      maxAmountSats: POLICY_MAX_AMOUNT_SATS,
    },
  };
}

function expectViolation(
  policy: WshSortedMultiPsbtPolicyInput,
  expectedCode: WshSortedMultiPsbtPolicyViolationCode,
): void {
  const result = checkWshSortedMultiPsbtPolicy(policy);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.violations.map((violation) => violation.code)).toContain(expectedCode);
}

function makeFundingUtxo(address: string, seed: number, valueSats: number): Utxo {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, seed), 0);
  tx.addOutput(bitcoinAddress.toOutputScript(address, networks.bitcoin), BigInt(valueSats));
  return {
    txid: tx.getId(),
    vout: 0,
    valueSats,
    chain: 0,
    index: 0,
    previousTxHex: tx.toHex(),
  };
}

function addDuplicateChangeOutput(psbtBase64: string): string {
  const inspected = inspectPsbtV2(psbtBase64);
  const existingChange = inspected.outputs.find((output) => output.witnessScript !== null);
  if (!existingChange?.witnessScript) throw new Error('Fixture missing change output.');
  const psbt = new PsbtV2(psbtBase64);
  psbt.addOutput({
    amount: 1_000,
    script: Buffer.from(existingChange.scriptPubKey),
    witnessScript: Buffer.from(existingChange.witnessScript),
    bip32Derivation: existingChange.bip32Derivation.map((entry) => ({
      pubkey: Buffer.from(entry.pubkey),
      masterFingerprint: Buffer.from(entry.masterFingerprint),
      path: entry.path,
    })),
  });
  return psbt.serialize('base64');
}

function signPsbt(
  psbtBase64: string,
  fixture: SyntheticBitcoinFixture,
  signerIndexes: readonly number[],
): string {
  const inspected = inspectPsbtV2(psbtBase64);
  return addPartialSignaturesToPsbt(
    psbtBase64,
    inspected.inputs.flatMap((input, inputIndex) =>
      signerIndexes.map((signerIndex) => {
        const slot = slotFromPath(input.bip32Derivation[signerIndex]!.path);
        const child = fixture.signers[signerIndex]!.account.derive(slot.chain).derive(slot.index);
        if (!child.privateKey) throw new Error('Missing synthetic private key.');
        return {
          inputIndex,
          pubkey: Buffer.from(child.publicKey),
          signature: compactToDer(ecc.sign(computeBip143SighashAll(inspected, inputIndex), child.privateKey)),
        };
      }),
    ),
  );
}

function slotFromPath(path: string): { chain: 0 | 1; index: number } {
  const parts = path.split('/');
  const chain = Number(parts.at(-2));
  const index = Number(parts.at(-1));
  if ((chain !== 0 && chain !== 1) || !Number.isInteger(index) || index < 0) {
    throw new Error(`Unexpected synthetic fixture derivation path: ${path}`);
  }
  return { chain, index };
}

function compactToDer(compact: Uint8Array): Uint8Array {
  if (compact.length !== 64) throw new Error('Compact signature must be 64 bytes.');
  const r = derInteger(compact.slice(0, 32));
  const s = derInteger(compact.slice(32));
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

function derInteger(bytes: Uint8Array): Buffer {
  let body = Buffer.from(bytes);
  while (body.length > 1 && body[0] === 0) body = body.subarray(1);
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}
