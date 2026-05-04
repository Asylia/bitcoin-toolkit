import { Buffer } from 'buffer';
import * as ecc from '@bitcoinerlab/secp256k1';
import { PsbtV2 } from '@caravan/psbt';
import { BIP32Factory, type BIP32Interface } from 'bip32';
import { address as bitcoinAddress, networks, payments, Transaction } from 'bitcoinjs-lib';
import { describe, expect, it, vi } from 'vitest';

import {
  addPartialSignaturesToPsbt,
  addressFromScript,
  buildWshSortedMultiPsbt,
  collectSignerFingerprints,
  computeBip143SighashAll,
  countPsbtSigners,
  deriveWshSortedMultiAddress,
  extractPsbtInputs,
  finaliseAndExtractTransaction,
  inspectPsbtV2,
  PsbtBuildError,
  PsbtFinaliseError,
  type DescriptorKey,
  type Utxo,
} from '../index';

const bip32 = BIP32Factory(ecc);
const ACCOUNT_PATH = "m/48'/0'/0'/2'";
const DERIVATION_PATH = "48'/0'/0'/2'";
const FUNDING_VALUE_SATS = 150_000;
const RECIPIENT_VALUE_SATS = 50_000;
const CHANGE_VALUE_SATS = 90_000;

type SigningKey = {
  root: BIP32Interface;
  account: BIP32Interface;
  descriptor: DescriptorKey;
}

type PsbtFixture = {
  keys: SigningKey[];
  descriptors: DescriptorKey[];
  recipientAddress: string;
  changeAddress: string;
  utxos: Utxo[];
  psbtBase64: string;
}

describe('buildWshSortedMultiPsbt', () => {
  it('builds an inspectable P2WSH sortedmulti PSBT with change metadata', () => {
    const fixture = buildFixture({ utxoCount: 1 });
    const inspected = inspectPsbtV2(fixture.psbtBase64);

    expect(inspected.inputs).toHaveLength(1);
    expect(inspected.outputs).toHaveLength(2);
    expect(inspected.inputs[0]?.txid).toBe(fixture.utxos[0]?.txid);
    expect(inspected.inputs[0]?.vout).toBe(0);
    expect(inspected.inputs[0]?.witnessScript.length).toBeGreaterThan(0);
    expect(inspected.inputs[0]?.bip32Derivation).toHaveLength(3);
    expect(inspected.outputs[1]?.witnessScript?.length).toBeGreaterThan(0);
    expect(inspected.outputs[1]?.bip32Derivation).toHaveLength(3);

    const built = buildWshSortedMultiPsbt({
      vault: {
        requiredSignatures: 2,
        network: 'mainnet',
        keys: fixture.descriptors,
      },
      utxos: fixture.utxos,
      recipients: [
        {
          address: fixture.recipientAddress,
          amountSats: RECIPIENT_VALUE_SATS,
        },
      ],
      change: {
        address: fixture.changeAddress,
        chain: 1,
        index: 0,
        amountSats: CHANGE_VALUE_SATS,
      },
    });

    expect(built.inputCount).toBe(1);
    expect(built.outputCount).toBe(2);
    expect(built.totalInputSats).toBe(FUNDING_VALUE_SATS);
    expect(built.totalOutputSats).toBe(RECIPIENT_VALUE_SATS + CHANGE_VALUE_SATS);
    expect(built.feeSats).toBe(10_000);
  });

  it('critical invariant: PSBT encodes the intended outpoint, outputs, change slot, and signer paths', () => {
    const fixture = buildFixture({ utxoCount: 1 });
    const inspected = inspectPsbtV2(fixture.psbtBase64);
    const input = inspected.inputs[0]!;
    const recipient = inspected.outputs[0]!;
    const change = inspected.outputs[1]!;

    expect(input.txid).toBe(fixture.utxos[0]?.txid);
    expect(input.vout).toBe(fixture.utxos[0]?.vout);
    expect(input.valueSats).toBe(FUNDING_VALUE_SATS);
    expect(addressFromScript(recipient.scriptPubKey, 'mainnet')).toBe(fixture.recipientAddress);
    expect(addressFromScript(change.scriptPubKey, 'mainnet')).toBe(fixture.changeAddress);
    expect(change.amountSats).toBe(CHANGE_VALUE_SATS);
    expect(input.bip32Derivation.map((entry) => entry.path)).toEqual(
      fixture.descriptors.map((key) => `m/${key.derivationPath}/0/0`),
    );
    expect(change.bip32Derivation.map((entry) => entry.path)).toEqual(
      fixture.descriptors.map((key) => `m/${key.derivationPath}/1/0`),
    );
    expect(input.bip32Derivation.map((entry) => Buffer.from(entry.masterFingerprint).toString('hex'))).toEqual(
      fixture.descriptors.map((key) => key.fingerprint),
    );
  });

  it('rejects malformed or unsafe PSBT build inputs', () => {
    const fixture = buildFixture({ utxoCount: 1 });
    const baseInput = {
      vault: {
        requiredSignatures: 2,
        network: 'mainnet' as const,
        keys: fixture.descriptors,
      },
      utxos: fixture.utxos,
      recipients: [
        {
          address: fixture.recipientAddress,
          amountSats: RECIPIENT_VALUE_SATS,
        },
      ],
      change: null,
    };

    expect(() =>
      buildWshSortedMultiPsbt({ ...baseInput, utxos: [] }),
    ).toThrow(PsbtBuildError);
    expect(() =>
      buildWshSortedMultiPsbt({
        ...baseInput,
        recipients: [{ address: fixture.recipientAddress, amountSats: 1 }],
      }),
    ).toThrow(PsbtBuildError);
    expect(() =>
      buildWshSortedMultiPsbt({
        ...baseInput,
        recipients: [{ address: 'not-a-bitcoin-address', amountSats: RECIPIENT_VALUE_SATS }],
      }),
    ).toThrow(PsbtBuildError);
    expect(() =>
      buildWshSortedMultiPsbt({
        ...baseInput,
        change: {
          address: fixture.recipientAddress,
          chain: 1,
          index: 0,
          amountSats: CHANGE_VALUE_SATS,
        },
      }),
    ).toThrow(PsbtBuildError);
    expect(() =>
      buildWshSortedMultiPsbt({
        ...baseInput,
        utxos: [
          {
            ...fixture.utxos[0]!,
            txid: '00'.repeat(32),
          },
        ],
      }),
    ).toThrow(PsbtBuildError);
  });
});

describe('extractPsbtInputs', () => {
  it('rejects malformed PSBT input outpoints instead of silently dropping them', () => {
    const fixture = buildFixture({ utxoCount: 1 });
    const validInternalTxid = '00'.repeat(32);
    let txidReads = 0;
    let voutReads = 0;

    const txidSpy = vi
      .spyOn(PsbtV2.prototype, 'PSBT_IN_PREVIOUS_TXID', 'get')
      .mockImplementation(() => {
        txidReads += 1;
        return txidReads === 1
          ? [validInternalTxid]
          : [validInternalTxid, undefined as unknown as string];
      });
    const voutSpy = vi
      .spyOn(PsbtV2.prototype, 'PSBT_IN_OUTPUT_INDEX', 'get')
      .mockImplementation(() => {
        voutReads += 1;
        return voutReads === 1 ? [0] : [0, 1];
      });

    try {
      let thrown: unknown;
      try {
        extractPsbtInputs(fixture.psbtBase64);
      } catch (cause) {
        thrown = cause;
      }
      expect(thrown).toBeInstanceOf(PsbtBuildError);
      expect((thrown as Error).message).toBe('Input 1: PSBT outpoint is malformed.');
    } finally {
      txidSpy.mockRestore();
      voutSpy.mockRestore();
    }
  });
});

describe('PSBT signer counting and finalisation', () => {
  it('counts unique signer fingerprints from partial signatures', () => {
    const fixture = buildFixture({ utxoCount: 2 });
    expect(countPsbtSigners(fixture.psbtBase64)).toBe(0);
    expect(collectSignerFingerprints(fixture.psbtBase64).size).toBe(0);
    expect(countPsbtSigners('not-base64')).toBe(0);

    const oneSigned = signFixture(fixture, [0]);
    expect(countPsbtSigners(oneSigned)).toBe(1);
    expect([...collectSignerFingerprints(oneSigned)]).toEqual([
      fixture.keys[0]!.descriptor.fingerprint,
    ]);

    const twoSigned = signFixture(fixture, [0, 1]);
    expect(countPsbtSigners(twoSigned)).toBe(2);
    expect([...collectSignerFingerprints(twoSigned)].sort()).toEqual(
      [
        fixture.keys[0]!.descriptor.fingerprint,
        fixture.keys[1]!.descriptor.fingerprint,
      ].sort(),
    );
  });

  it('finalises a threshold-signed PSBT into a deterministic transaction', () => {
    const fixture = buildFixture({ utxoCount: 1 });

    expect(() => finaliseAndExtractTransaction(fixture.psbtBase64)).toThrow(
      PsbtFinaliseError,
    );

    const signed = signFixture(fixture, [0, 1]);
    const extracted = finaliseAndExtractTransaction(signed);
    const tx = Transaction.fromHex(extracted.hex);
    const spentTxid = Buffer.from(tx.ins[0]!.hash).reverse().toString('hex');

    expect(extracted.txid).toBe(tx.getId());
    expect(extracted.vbytes).toBe(tx.virtualSize());
    expect(spentTxid).toBe(fixture.utxos[0]?.txid);
    expect(tx.ins[0]?.index).toBe(0);
    expect(Number(tx.outs[0]?.value)).toBe(RECIPIENT_VALUE_SATS);
    expect(Number(tx.outs[1]?.value)).toBe(CHANGE_VALUE_SATS);
  });
});

function buildFixture(options: { utxoCount: number }): PsbtFixture {
  const keys = makeSigningKeys();
  const descriptors = keys.map((entry) => entry.descriptor);
  const receiveAddress = deriveWshSortedMultiAddress({
    requiredSignatures: 2,
    keys: descriptors,
    network: 'mainnet',
    chain: 0,
    index: 0,
  });
  const changeAddress = deriveWshSortedMultiAddress({
    requiredSignatures: 2,
    keys: descriptors,
    network: 'mainnet',
    chain: 1,
    index: 0,
  });
  const recipientAddress = makeRecipientAddress();
  const utxos = Array.from({ length: options.utxoCount }, (_, index) =>
    makeFundingUtxo(receiveAddress, 0, index),
  );
  const psbtBase64 = buildWshSortedMultiPsbt({
    vault: {
      requiredSignatures: 2,
      network: 'mainnet',
      keys: descriptors,
    },
    utxos,
    recipients: [
      {
        address: recipientAddress,
        amountSats: RECIPIENT_VALUE_SATS,
      },
    ],
    change: {
      address: changeAddress,
      chain: 1,
      index: 0,
      amountSats: (FUNDING_VALUE_SATS * options.utxoCount) - RECIPIENT_VALUE_SATS - 10_000,
    },
  }).psbtBase64;

  return {
    keys,
    descriptors,
    recipientAddress,
    changeAddress,
    utxos,
    psbtBase64,
  };
}

function makeSigningKeys(): SigningKey[] {
  return [11, 22, 33].map((byte) => {
    const root = bip32.fromSeed(Buffer.alloc(32, byte), networks.bitcoin);
    const account = root.derivePath(ACCOUNT_PATH);
    const descriptor: DescriptorKey = {
      fingerprint: fingerprintHex(root.fingerprint),
      derivationPath: DERIVATION_PATH,
      xpub: account.neutered().toBase58(),
    };
    return { root, account, descriptor };
  });
}

function makeRecipientAddress(): string {
  const recipient = bip32
    .fromSeed(Buffer.alloc(32, 44), networks.bitcoin)
    .derivePath("m/84'/0'/0'/0/0");
  const payment = payments.p2wpkh({
    pubkey: Buffer.from(recipient.publicKey),
    network: networks.bitcoin,
  });
  if (!payment.address) throw new Error('Could not derive test recipient address.');
  return payment.address;
}

function makeFundingUtxo(address: string, index: number, seedByte: number): Utxo {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, seedByte + 1), 0);
  tx.addOutput(
    bitcoinAddress.toOutputScript(address, networks.bitcoin),
    BigInt(FUNDING_VALUE_SATS),
  );
  return {
    txid: tx.getId(),
    vout: 0,
    valueSats: FUNDING_VALUE_SATS,
    chain: 0,
    index,
    previousTxHex: tx.toHex(),
  };
}

function signFixture(fixture: PsbtFixture, signerIndexes: readonly number[]): string {
  const inspected = inspectPsbtV2(fixture.psbtBase64);
  return addPartialSignaturesToPsbt(
    fixture.psbtBase64,
    inspected.inputs.flatMap((input, inputIndex) =>
      signerIndexes.map((signerIndex) => {
        const slot = slotFromPath(input.bip32Derivation[signerIndex]!.path);
        const child = fixture.keys[signerIndex]!.account
          .derive(slot.chain)
          .derive(slot.index);
        if (!child.privateKey) throw new Error('Missing test private key.');
        const sighash = computeBip143SighashAll(inspected, inputIndex);
        const compact = ecc.sign(sighash, child.privateKey);
        return {
          inputIndex,
          pubkey: Buffer.from(child.publicKey),
          signature: compactToDer(compact),
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
    throw new Error(`Unexpected PSBT derivation path in test fixture: ${path}`);
  }
  return { chain, index };
}

function fingerprintHex(value: Uint8Array | number): string {
  if (typeof value === 'number') {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    return buffer.toString('hex');
  }
  return Buffer.from(value).toString('hex');
}

function compactToDer(compact: Uint8Array): Uint8Array {
  if (compact.length !== 64) throw new Error('Compact signature must be 64 bytes.');
  const r = derInteger(compact.slice(0, 32));
  const s = derInteger(compact.slice(32));
  return Buffer.concat([
    Buffer.from([0x30, r.length + s.length]),
    r,
    s,
  ]);
}

function derInteger(bytes: Uint8Array): Buffer {
  let body = Buffer.from(bytes);
  while (body.length > 1 && body[0] === 0) body = body.subarray(1);
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}
