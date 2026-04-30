import { Buffer } from 'buffer';
import * as ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory, type BIP32Interface } from 'bip32';
import bs58check from 'bs58check';
import { address as bitcoinAddress, networks, payments, Transaction } from 'bitcoinjs-lib';

import {
  addPartialSignaturesToPsbt,
  buildWshSortedMultiDescriptor,
  buildWshSortedMultiPsbt,
  computeBip143SighashAll,
  deriveWshSortedMultiAddress,
  finaliseAndExtractTransaction,
  inspectPsbtV2,
  type DescriptorKey,
  type Utxo,
} from '../index';

const bip32 = BIP32Factory(ecc);
const ACCOUNT_PATH = "m/48'/0'/0'/2'";
const DERIVATION_PATH = "48'/0'/0'/2'";
const ZPUB_VERSION = Uint8Array.from([0x02, 0xaa, 0x7e, 0xd3]);

export const SYNTHETIC_FIXTURE_NOTICE =
  'Synthetic deterministic test vector generated from repeated-byte seeds. Never use as wallet material.';

export type SyntheticSigner = {
  seedByte: number;
  root: BIP32Interface;
  account: BIP32Interface;
  descriptor: DescriptorKey;
  zpub: string;
}

export type SyntheticBitcoinFixture = {
  notice: typeof SYNTHETIC_FIXTURE_NOTICE;
  requiredSignatures: 2;
  signers: SyntheticSigner[];
  descriptors: DescriptorKey[];
  zpubs: string[];
  descriptor: string;
  receiveDescriptor: string;
  changeDescriptor: string;
  receiveAddress: string;
  changeAddress: string;
  recipientAddress: string;
  utxos: Utxo[];
  unsignedPsbtBase64: string;
  oneSignaturePsbtBase64: string;
  thresholdSignedPsbtBase64: string;
  finalRawTxHex: string;
  finalTxid: string;
}

export function makeSyntheticBitcoinFixture(): SyntheticBitcoinFixture {
  const signers = [11, 22, 33].map(makeSigner);
  const descriptors = signers.map((entry) => entry.descriptor);
  const descriptorSet = buildWshSortedMultiDescriptor({
    requiredSignatures: 2,
    network: 'mainnet',
    keys: descriptors,
  });
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
  const utxos = [makeFundingUtxo(receiveAddress)];
  const unsignedPsbtBase64 = buildWshSortedMultiPsbt({
    vault: {
      requiredSignatures: 2,
      network: 'mainnet',
      keys: descriptors,
    },
    utxos,
    recipients: [{ address: recipientAddress, amountSats: 50_000 }],
    change: {
      address: changeAddress,
      chain: 1,
      index: 0,
      amountSats: 90_000,
    },
  }).psbtBase64;
  const oneSignaturePsbtBase64 = signPsbt(unsignedPsbtBase64, signers, [0]);
  const thresholdSignedPsbtBase64 = signPsbt(unsignedPsbtBase64, signers, [0, 1]);
  const final = finaliseAndExtractTransaction(thresholdSignedPsbtBase64);

  return {
    notice: SYNTHETIC_FIXTURE_NOTICE,
    requiredSignatures: 2,
    signers,
    descriptors,
    zpubs: signers.map((entry) => entry.zpub),
    descriptor: descriptorSet.descriptor,
    receiveDescriptor: descriptorSet.receiveDescriptor,
    changeDescriptor: descriptorSet.changeDescriptor,
    receiveAddress,
    changeAddress,
    recipientAddress,
    utxos,
    unsignedPsbtBase64,
    oneSignaturePsbtBase64,
    thresholdSignedPsbtBase64,
    finalRawTxHex: final.hex,
    finalTxid: final.txid,
  };
}

function makeSigner(seedByte: number): SyntheticSigner {
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
    zpub: reencodeExtendedPubkey(descriptor.xpub, ZPUB_VERSION),
  };
}

function makeRecipientAddress(): string {
  const recipient = bip32
    .fromSeed(Buffer.alloc(32, 44), networks.bitcoin)
    .derivePath("m/84'/0'/0'/0/0");
  const payment = payments.p2wpkh({
    pubkey: Buffer.from(recipient.publicKey),
    network: networks.bitcoin,
  });
  if (!payment.address) throw new Error('Could not derive synthetic recipient address.');
  return payment.address;
}

function makeFundingUtxo(address: string): Utxo {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 1), 0);
  tx.addOutput(bitcoinAddress.toOutputScript(address, networks.bitcoin), 150_000n);
  return {
    txid: tx.getId(),
    vout: 0,
    valueSats: 150_000,
    chain: 0,
    index: 0,
    previousTxHex: tx.toHex(),
  };
}

function signPsbt(
  psbtBase64: string,
  signers: readonly SyntheticSigner[],
  signerIndexes: readonly number[],
): string {
  const inspected = inspectPsbtV2(psbtBase64);
  return addPartialSignaturesToPsbt(
    psbtBase64,
    inspected.inputs.flatMap((input, inputIndex) =>
      signerIndexes.map((signerIndex) => {
        const slot = slotFromPath(input.bip32Derivation[signerIndex]!.path);
        const child = signers[signerIndex]!.account.derive(slot.chain).derive(slot.index);
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
