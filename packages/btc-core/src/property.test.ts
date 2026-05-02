import { Buffer } from 'buffer';
import * as ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory, type BIP32Interface } from 'bip32';
import bs58check from 'bs58check';
import { address as bitcoinAddress, networks, payments } from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';

import {
  addPartialSignaturesToPsbt,
  buildWshSortedMultiDescriptor,
  buildWshSortedMultiPsbt,
  computeBip143SighashAll,
  DEFAULT_CHANGE_OUTPUT_VBYTES,
  DEFAULT_DUST_THRESHOLD_SATS,
  DEFAULT_FIXED_VBYTES,
  DEFAULT_PER_INPUT_VBYTES,
  deriveWshSortedMultiAddress,
  deriveWshSortedMultiAddressBatch,
  findSegwitV0SignatureOwner,
  inspectPsbtV2,
  parseBitcoinAddress,
  parseDescriptorImport,
  selectCoinsLargestFirst,
  selectCoinsLargestFirstFixedFee,
  verifySegwitV0SignatureAgainstPubkey,
  withChecksum,
  type DescriptorKey,
  type Utxo,
} from './index';

const bip32 = BIP32Factory(ecc);
const ACCOUNT_PATH = "m/48'/0'/0'/2'";
const DERIVATION_PATH = "48'/0'/0'/2'";
const ZPUB_VERSION = Uint8Array.from([0x02, 0xaa, 0x7e, 0xd3]);
const PROPERTY_CASES = 72;
const PROPERTY_TEST_TIMEOUT_MS = 120_000;
const PSBT_CASES = 24;

type SigningKey = {
  seedByte: number;
  root: BIP32Interface;
  account: BIP32Interface;
  descriptor: DescriptorKey;
  zpubDescriptor: DescriptorKey;
}

type Rng = {
  next(): number;
  int(min: number, max: number): number;
  bool(): boolean;
  pick<T>(values: readonly T[]): T;
  shuffle<T>(values: readonly T[]): T[];
}

describe('btc-core property/fuzz invariants', () => {
  it('round-trips generated descriptors through descriptor and Bitcoin Core import shapes', () => {
    const signers = makeSigningKeys();

    for (const rng of cases('descriptor-round-trip', PROPERTY_CASES)) {
      const totalKeys = rng.int(2, Math.min(5, signers.length));
      const requiredSignatures = rng.int(1, totalKeys);
      const selectedSigners = rng.shuffle(signers).slice(0, totalKeys);
      const keys = selectedSigners.map((signer) =>
        rng.bool() ? signer.descriptor : signer.zpubDescriptor,
      );
      const rendered = buildWshSortedMultiDescriptor({
        requiredSignatures,
        keys,
        network: 'mainnet',
      });

      const parsedMultipath = parseDescriptorImport(rendered.descriptor);
      expect(parsedMultipath.requiredSignatures).toBe(requiredSignatures);
      expect(parsedMultipath.totalKeys).toBe(totalKeys);
      expect(parsedMultipath.signers.map((signer) => signer.fingerprint)).toEqual(
        selectedSigners.map((signer) => signer.descriptor.fingerprint),
      );
      expect(parsedMultipath.signers.every((signer) => signer.xpub.startsWith('xpub')))
        .toBe(true);

      const coreJson = JSON.stringify([
        { desc: rendered.receiveDescriptor, internal: false, timestamp: 'now', active: true },
        { desc: rendered.changeDescriptor, internal: true, timestamp: 'now', active: true },
      ]);
      const parsedCore = parseDescriptorImport(coreJson);
      expect(parsedCore.requiredSignatures).toBe(requiredSignatures);
      expect(parsedCore.totalKeys).toBe(totalKeys);
      expect(parsedCore.signers).toEqual(parsedMultipath.signers);

      const hNotationBody = stripChecksum(rendered.descriptor).replaceAll("'", 'h');
      const parsedHNotation = parseDescriptorImport(withChecksum(hNotationBody));
      expect(parsedHNotation.signers.map((signer) => signer.derivationPath)).toEqual(
        selectedSigners.map(() => DERIVATION_PATH),
      );
    }
  });

  it('derives stable P2WSH addresses across key order, batch windows, and parser round-trips', () => {
    const signers = makeSigningKeys();

    for (const rng of cases('address-derivation', PROPERTY_CASES)) {
      const totalKeys = rng.int(2, Math.min(5, signers.length));
      const requiredSignatures = rng.int(1, totalKeys);
      const selected = rng.shuffle(signers).slice(0, totalKeys);
      const keys = selected.map((signer) => signer.descriptor);
      const shuffledKeys = rng.shuffle(keys);
      const chain = rng.pick([0, 1] as const);
      const startIndex = rng.int(0, 24);
      const count = rng.int(1, 6);

      const batch = deriveWshSortedMultiAddressBatch({
        requiredSignatures,
        keys,
        network: 'mainnet',
        chain,
        startIndex,
        count,
      });

      for (const entry of batch) {
        const single = deriveWshSortedMultiAddress({
          requiredSignatures,
          keys,
          network: 'mainnet',
          chain,
          index: entry.index,
        });
        const reordered = deriveWshSortedMultiAddress({
          requiredSignatures,
          keys: shuffledKeys,
          network: 'mainnet',
          chain,
          index: entry.index,
        });
        const parsed = parseBitcoinAddress(entry.address, 'mainnet');

        expect(entry.address).toBe(single);
        expect(reordered).toBe(entry.address);
        expect(parsed).toEqual({ ok: true, type: 'p2wsh', address: entry.address });
      }
    }
  }, PROPERTY_TEST_TIMEOUT_MS);

  it('keeps rate and fixed-fee coin selection accounting balanced for random UTXO sets', () => {
    for (const rng of cases('coin-selection', PROPERTY_CASES * 3)) {
      const utxos = randomUtxos(rng, rng.int(1, 10));
      const targetSats = rng.int(1, totalValue(utxos) + 20_000);
      const feeRateSatsPerVByte = rng.int(1, 25);
      const fixedVbytes = rng.int(50, 120);
      const perInputVbytes = rng.int(80, 170);
      const changeOutputVbytes = rng.int(20, 55);
      const dustThresholdSats = rng.int(1, 1_500);

      const rateResult = selectCoinsLargestFirst({
        utxos,
        targetSats,
        feeRateSatsPerVByte,
        fixedVbytes,
        perInputVbytes,
        changeOutputVbytes,
        dustThresholdSats,
      });

      if (rateResult.ok) {
        const selectedSum = totalValue(rateResult.selected);
        expect(selectedSum).toBe(targetSats + rateResult.feeSats + rateResult.changeSats);
        expect(rateResult.feeSats).toBeGreaterThanOrEqual(0);
        expect(rateResult.changeSats).toBeGreaterThanOrEqual(0);
        expect(rateResult.changeSats === 0 || rateResult.changeSats >= dustThresholdSats)
          .toBe(true);
        expect(rateResult.selected).toEqual(largestFirstPrefix(utxos, rateResult.selected.length));
        if (rateResult.changeSats > 0) {
          expect(rateResult.feeSats).toBe(
            Math.ceil(rateResult.vbytes * feeRateSatsPerVByte),
          );
        } else {
          const minimumNoChangeFee = Math.ceil(rateResult.vbytes * feeRateSatsPerVByte);
          expect(rateResult.feeSats).toBeGreaterThanOrEqual(minimumNoChangeFee);
        }
      } else {
        expect(rateResult.available).toBeGreaterThanOrEqual(0);
        expect(rateResult.required).toBeGreaterThanOrEqual(targetSats);
      }

      const fixedFeeSats = rng.int(1, 15_000);
      const fixedResult = selectCoinsLargestFirstFixedFee({
        utxos,
        targetSats,
        feeSats: fixedFeeSats,
        fixedVbytes,
        perInputVbytes,
        changeOutputVbytes,
        dustThresholdSats,
      });

      if (fixedResult.ok) {
        const selectedSum = totalValue(fixedResult.selected);
        expect(selectedSum).toBe(targetSats + fixedResult.feeSats + fixedResult.changeSats);
        expect(fixedResult.feeSats).toBe(fixedFeeSats);
        expect(fixedResult.changeSats === 0 || fixedResult.changeSats >= dustThresholdSats)
          .toBe(true);
        expect(fixedResult.selected).toEqual(largestFirstPrefix(utxos, fixedResult.selected.length));
      } else if (fixedResult.reason === 'DUST_CHANGE') {
        expect(fixedResult.available).toBeGreaterThanOrEqual(targetSats + fixedFeeSats);
        expect(fixedResult.required).toBe(targetSats + fixedFeeSats + dustThresholdSats);
      }
    }
  });

  it('builds inspectable and verifiable PSBTs from generated spend plans without negative fees', () => {
    const signers = makeSigningKeys();
    const recipientAddress = makeRecipientAddress(201);

    for (const rng of cases('psbt-build-verify', PSBT_CASES)) {
      const totalKeys = rng.int(2, 4);
      const requiredSignatures = rng.int(1, totalKeys);
      const vaultSigners = rng.shuffle(signers).slice(0, totalKeys);
      const keys = vaultSigners.map((signer) => signer.descriptor);
      const utxos = randomUtxos(rng, rng.int(1, 5), {
        minValueSats: 20_000,
        maxValueSats: 220_000,
        maxIndex: 12,
      });
      const spendableTarget = rng.int(
        DEFAULT_DUST_THRESHOLD_SATS,
        Math.max(DEFAULT_DUST_THRESHOLD_SATS, Math.floor(totalValue(utxos) * 0.72)),
      );
      const selection = selectCoinsLargestFirst({
        utxos,
        targetSats: spendableTarget,
        feeRateSatsPerVByte: rng.int(1, 12),
        fixedVbytes: DEFAULT_FIXED_VBYTES,
        perInputVbytes: DEFAULT_PER_INPUT_VBYTES,
        changeOutputVbytes: DEFAULT_CHANGE_OUTPUT_VBYTES,
        dustThresholdSats: DEFAULT_DUST_THRESHOLD_SATS,
      });
      if (!selection.ok) continue;

      const change = selection.changeSats > 0
        ? {
            address: deriveWshSortedMultiAddress({
              requiredSignatures,
              keys,
              network: 'mainnet',
              chain: 1,
              index: 50 + rng.int(0, 30),
            }),
            chain: 1 as const,
            index: 50 + rng.int(31, 60),
            amountSats: selection.changeSats,
          }
        : null;
      const normalisedChange = change
        ? {
            ...change,
            address: deriveWshSortedMultiAddress({
              requiredSignatures,
              keys,
              network: 'mainnet',
              chain: 1,
              index: change.index,
            }),
          }
        : null;

      const built = buildWshSortedMultiPsbt({
        vault: {
          requiredSignatures,
          keys,
          network: 'mainnet',
        },
        utxos: selection.selected,
        recipients: [{ address: recipientAddress, amountSats: spendableTarget }],
        change: normalisedChange,
      });
      const inspected = inspectPsbtV2(built.psbtBase64);
      const selectedSum = totalValue(selection.selected);

      expect(built.totalInputSats).toBe(selectedSum);
      expect(built.totalOutputSats).toBe(spendableTarget + selection.changeSats);
      expect(built.feeSats).toBe(selection.feeSats);
      expect(built.totalOutputSats).toBeLessThanOrEqual(built.totalInputSats);
      expect(built.inputCount).toBe(selection.selected.length);
      expect(built.outputCount).toBe(1 + (selection.changeSats > 0 ? 1 : 0));
      expect(inspected.inputs).toHaveLength(selection.selected.length);
      expect(inspected.outputs).toHaveLength(built.outputCount);

      const signer = vaultSigners[0]!;
      const signatures = inspected.inputs.map((input, inputIndex) => {
        const derivation = input.bip32Derivation[0]!;
        const slot = slotFromPath(derivation.path);
        const child = signer.account.derive(slot.chain).derive(slot.index);
        if (!child.privateKey) throw new Error('Generated signer is missing private key.');
        return {
          inputIndex,
          pubkey: Buffer.from(child.publicKey),
          signature: compactToDer(ecc.sign(computeBip143SighashAll(inspected, inputIndex), child.privateKey)),
        };
      });
      const signedPsbt = addPartialSignaturesToPsbt(built.psbtBase64, signatures);
      const signed = inspectPsbtV2(signedPsbt);

      for (let inputIndex = 0; inputIndex < signed.inputs.length; inputIndex += 1) {
        const input = signed.inputs[inputIndex]!;
        const partialSig = input.partialSigs[0]!;
        const candidatePubkeys = input.bip32Derivation.map((entry) => entry.pubkey);
        expect(verifySegwitV0SignatureAgainstPubkey(signed, inputIndex, partialSig.pubkey, partialSig.signature))
          .toBe(true);
        expect(
          bytesEqual(
            findSegwitV0SignatureOwner(signed, inputIndex, partialSig.signature, candidatePubkeys),
            partialSig.pubkey,
          ),
        ).toBe(true);
      }
    }
  });
});

function makeSigningKeys(): SigningKey[] {
  return [11, 22, 33, 44, 55, 66, 77, 88].map((seedByte) => {
    const root = bip32.fromSeed(Buffer.alloc(32, seedByte), networks.bitcoin);
    const account = root.derivePath(ACCOUNT_PATH);
    const descriptor: DescriptorKey = {
      fingerprint: fingerprintHex(root.fingerprint),
      derivationPath: DERIVATION_PATH,
      xpub: account.neutered().toBase58(),
    };
    return {
      seedByte,
      root,
      account,
      descriptor,
      zpubDescriptor: {
        ...descriptor,
        xpub: reencodeExtendedPubkey(descriptor.xpub, ZPUB_VERSION),
      },
    };
  });
}

function randomUtxos(
  rng: Rng,
  count: number,
  options: {
    minValueSats?: number;
    maxValueSats?: number;
    maxIndex?: number;
  } = {},
): Utxo[] {
  const minValueSats = options.minValueSats ?? 400;
  const maxValueSats = options.maxValueSats ?? 120_000;
  const maxIndex = options.maxIndex ?? 200;
  const usedOutpoints = new Set<string>();
  const out: Utxo[] = [];

  while (out.length < count) {
    const txid = randomTxid(rng);
    const vout = rng.int(0, 4);
    const key = `${txid}:${vout}`;
    if (usedOutpoints.has(key)) continue;
    usedOutpoints.add(key);
    out.push({
      txid,
      vout,
      valueSats: rng.int(minValueSats, maxValueSats),
      chain: rng.pick([0, 1] as const),
      index: rng.int(0, maxIndex),
    });
  }

  return out;
}

function largestFirstPrefix(utxos: readonly Utxo[], count: number): readonly Utxo[] {
  return utxos
    .slice()
    .sort((a, b) => {
      if (b.valueSats !== a.valueSats) return b.valueSats - a.valueSats;
      if (a.txid === b.txid) return a.vout - b.vout;
      return a.txid < b.txid ? -1 : 1;
    })
    .slice(0, count);
}

function totalValue(utxos: readonly Utxo[]): number {
  return utxos.reduce((sum, utxo) => sum + utxo.valueSats, 0);
}

function makeRecipientAddress(seedByte: number): string {
  const recipient = bip32
    .fromSeed(Buffer.alloc(32, seedByte), networks.bitcoin)
    .derivePath("m/84'/0'/0'/0/0");
  const payment = payments.p2wpkh({
    pubkey: Buffer.from(recipient.publicKey),
    network: networks.bitcoin,
  });
  if (!payment.address) throw new Error('Could not derive generated recipient address.');
  expect(bitcoinAddress.toOutputScript(payment.address, networks.bitcoin).length)
    .toBeGreaterThan(0);
  return payment.address;
}

function stripChecksum(descriptor: string): string {
  return descriptor.split('#')[0] ?? descriptor;
}

function slotFromPath(path: string): { chain: 0 | 1; index: number } {
  const parts = path.split('/');
  const chain = Number(parts.at(-2));
  const index = Number(parts.at(-1));
  if ((chain !== 0 && chain !== 1) || !Number.isInteger(index) || index < 0) {
    throw new Error(`Unexpected generated PSBT derivation path: ${path}`);
  }
  return { chain, index };
}

function reencodeExtendedPubkey(xpub: string, version: Uint8Array): string {
  const decoded = bs58check.decode(xpub);
  return bs58check.encode(Buffer.concat([Buffer.from(version), Buffer.from(decoded).subarray(4)]));
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
  return Buffer.concat([Buffer.from([0x30, r.length + s.length]), r, s]);
}

function derInteger(bytes: Uint8Array): Buffer {
  let body = Buffer.from(bytes);
  while (body.length > 1 && body[0] === 0) body = body.subarray(1);
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a === null) return false;
  return Buffer.from(a).equals(Buffer.from(b));
}

function cases(label: string, count: number): Rng[] {
  const base = hashLabel(label);
  return Array.from({ length: count }, (_, index) => createRng(base + index * 0x9e3779b9));
}

function createRng(seed: number): Rng {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };

  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`Invalid integer range: ${min}..${max}`);
    return Math.floor(next() * (max - min + 1)) + min;
  };

  const rng: Rng = {
    next,
    int,
    bool: () => int(0, 1) === 1,
    pick: <T>(values: readonly T[]): T => {
      if (values.length === 0) throw new Error('Cannot pick from an empty array.');
      return values[int(0, values.length - 1)]!;
    },
    shuffle: <T>(values: readonly T[]): T[] => {
      const copy = values.slice();
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        const current = copy[i]!;
        copy[i] = copy[j]!;
        copy[j] = current;
      }
      return copy;
    },
  };

  return rng;
}

function randomTxid(rng: Rng): string {
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += rng.int(0, 255).toString(16).padStart(2, '0');
  }
  return out;
}

function hashLabel(label: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
