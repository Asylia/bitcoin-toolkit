import { Buffer } from 'buffer';
import * as ecc from '@bitcoinerlab/secp256k1';
import { PsbtV2 } from '@caravan/psbt';
import { describe, expect, it } from 'vitest';

import {
  ASYLIA_SIGNER_PROOF_INDEX,
  addPartialSignaturesToPsbt,
  buildSignerProofPsbt,
  computeBip143SighashAll,
  inspectPsbtV2,
  reverseTxidHex,
  verifySignerProofPsbt,
} from './index';
import { makeSyntheticBitcoinFixture } from './__fixtures__/bitcoin';

describe('signer PSBT proof', () => {
  it('builds a challenge-bound proof PSBT and verifies the resulting partial signature', () => {
    const fixture = makeSyntheticBitcoinFixture();
    const signer = fixture.signers[0]!;
    const challengeMessage = 'Asylia signer login\nNonce: proof-test';
    const proof = buildSignerProofPsbt({
      challengeMessage,
      signer: {
        fingerprint: signer.descriptor.fingerprint,
        derivationRoot: signer.descriptor.derivationPath,
        xpub: signer.descriptor.xpub,
      },
    });

    const inspected = inspectPsbtV2(proof.psbtBase64);
    const derivation = inspected.inputs[0]!.bip32Derivation[0]!;
    expect(derivation.path).toBe(`m/${signer.descriptor.derivationPath}/0/${ASYLIA_SIGNER_PROOF_INDEX}`);

    const child = signer.account.derive(0).derive(ASYLIA_SIGNER_PROOF_INDEX);
    if (!child.privateKey) throw new Error('Synthetic signer is missing a private key.');
    const proofSignature = compactToDer(ecc.sign(computeBip143SighashAll(inspected, 0), child.privateKey));
    const signed = addPartialSignaturesToPsbt(proof.psbtBase64, [{
      inputIndex: 0,
      pubkey: Buffer.from(child.publicKey),
      signature: proofSignature,
    }]);

    expect(verifySignerProofPsbt({
      challengeMessage,
      signer: {
        fingerprint: signer.descriptor.fingerprint,
        derivationRoot: signer.descriptor.derivationPath,
        xpub: signer.descriptor.xpub,
      },
      proofPsbtBase64: signed,
    })).toBe(true);
    expect(verifySignerProofPsbt({
      challengeMessage: `${challengeMessage}\nchanged`,
      signer: {
        fingerprint: signer.descriptor.fingerprint,
        derivationRoot: signer.descriptor.derivationPath,
        xpub: signer.descriptor.xpub,
      },
      proofPsbtBase64: signed,
    })).toBe(false);
    expect(verifySignerProofPsbt({
      challengeMessage,
      signer: {
        fingerprint: signer.descriptor.fingerprint,
        derivationRoot: signer.descriptor.derivationPath,
        xpub: signer.descriptor.xpub,
      },
      proofPsbtBase64: proof.psbtBase64,
    })).toBe(false);

    const wrongSigner = fixture.signers[1]!;
    expect(verifySignerProofPsbt({
      challengeMessage,
      signer: {
        fingerprint: wrongSigner.descriptor.fingerprint,
        derivationRoot: wrongSigner.descriptor.derivationPath,
        xpub: wrongSigner.descriptor.xpub,
      },
      proofPsbtBase64: signed,
    })).toBe(false);

    const extraOutput = new PsbtV2();
    const proofInput = inspected.inputs[0]!;
    const proofOutput = inspected.outputs[0]!;
    extraOutput.PSBT_GLOBAL_TX_VERSION = inspected.txVersion;
    extraOutput.PSBT_GLOBAL_FALLBACK_LOCKTIME = inspected.fallbackLocktime ?? 0;
    extraOutput.addInput({
      previousTxId: reverseTxidHex(proofInput.txid),
      outputIndex: proofInput.vout,
      witnessUtxo: {
        amount: proofInput.valueSats,
        script: Buffer.from(proofInput.scriptPubKey),
      },
      witnessScript: Buffer.from(proofInput.witnessScript),
      bip32Derivation: proofInput.bip32Derivation.map((entry) => ({
        pubkey: Buffer.from(entry.pubkey),
        masterFingerprint: Buffer.from(entry.masterFingerprint),
        path: entry.path,
      })),
    });
    extraOutput.addOutput({
      amount: proofOutput.amountSats,
      script: Buffer.from(proofOutput.scriptPubKey),
    });
    extraOutput.addOutput({
      amount: 1,
      script: Buffer.from(proofOutput.scriptPubKey),
    });
    const signedWithExtraOutput = addPartialSignaturesToPsbt(extraOutput.serialize('base64'), [{
      inputIndex: 0,
      pubkey: Buffer.from(child.publicKey),
      signature: proofSignature,
    }]);
    expect(verifySignerProofPsbt({
      challengeMessage,
      signer: {
        fingerprint: signer.descriptor.fingerprint,
        derivationRoot: signer.descriptor.derivationPath,
        xpub: signer.descriptor.xpub,
      },
      proofPsbtBase64: signedWithExtraOutput,
    })).toBe(false);

    expect(verifySignerProofPsbt({
      challengeMessage,
      signer: {
        fingerprint: signer.descriptor.fingerprint,
        derivationRoot: "m/48'/1'/0'/2'",
        xpub: signer.descriptor.xpub,
      },
      proofPsbtBase64: signed,
    })).toBe(false);

    expect(verifySignerProofPsbt({
      challengeMessage,
      signer: {
        fingerprint: 'nothex',
        derivationRoot: signer.descriptor.derivationPath,
        xpub: signer.descriptor.xpub,
      },
      proofPsbtBase64: signed,
    })).toBe(false);

    expect(verifySignerProofPsbt({
      challengeMessage,
      signer: {
        fingerprint: signer.descriptor.fingerprint,
        derivationRoot: signer.descriptor.derivationPath,
        xpub: signer.descriptor.xpub,
      },
      proofPsbtBase64: tamperBase64(signed),
    })).toBe(false);
  });
});

function tamperBase64(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  return bytes.subarray(0, Math.max(1, bytes.length - 16)).toString('base64');
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
