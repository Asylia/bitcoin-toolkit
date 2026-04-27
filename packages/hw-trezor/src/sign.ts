/**
 * Trezor signing for `wsh(sortedmulti(...))` Asylia vaults.
 *
 * Trezor Connect's `signTransaction` API does **not** consume PSBT
 * payloads directly. It speaks Trezor's native protobuf shape:
 * `TxInputType[]`, `TxOutputType[]`, with multisig metadata expressed
 * as a {@link MultisigRedeemScriptType} (nodes + per-pubkey path,
 * threshold, optional `pubkeys_order` flag). This module bridges the
 * two: it walks an Asylia-built PSBT v2 and translates each input /
 * output into the matching Trezor structure, drives the device, and
 * stitches the returned signatures back into the PSBT.
 *
 * What gets translated, per input:
 *
 *   - `prev_hash` / `prev_index` / `amount` come straight from the
 *     PSBT input's outpoint and witness UTXO.
 *   - `script_type` is hard-coded to `SPENDWITNESS` because Asylia is
 *     P2WSH multisig only — combined with a populated `multisig`
 *     block the device knows it is dealing with a `wsh(...)` spend.
 *   - `multisig.pubkeys[].node` carries each cosigner's xpub-level
 *     HD node (depth 4, e.g. `m/48'/0'/0'/2'`); the shared
 *     `address_n: [chain, index]` derives the leaves. Setting
 *     `pubkeys_order: LEXICOGRAPHIC` instructs the device to apply
 *     BIP-67 ordering — without it the resulting witness script
 *     would not match the on-chain output.
 *   - `address_n` at the input level is the full path from master to
 *     the signing cosigner's leaf; the device uses it to identify
 *     which key it should sign with.
 *   - `multisig.signatures` carries any partial signatures already
 *     attached to the PSBT, in the same cosigner order, so the device
 *     refuses to produce a duplicate from one cosigner.
 *
 * What gets translated, per output:
 *
 *   - External recipients map onto `PAYTOADDRESS` with the recipient
 *     bech32 address (recovered from `scriptPubKey`).
 *   - Change back to the vault uses `PAYTOWITNESS` with a populated
 *     `multisig` block and the signing cosigner's `address_n` so the
 *     device renders it as "change returning to my wallet" instead of
 *     as an unknown send.
 *
 * Coin defaults to mainnet (`btc`); testnet is reserved for a future
 * toggle.
 */
import {
  inspectPsbtV2,
  addPartialSignaturesToPsbt,
  addressFromScript,
  bip32PathToAddressN,
  findSegwitV0SignatureOwner,
  verifySegwitV0SignatureAgainstPubkey,
  PsbtInspectError,
  type DescriptorKey,
  type InspectedPsbtInput,
  type InspectedPsbtOutput,
  type PartialSignatureToAdd,
  type PsbtBip32Derivation,
} from '@asylia/btc-core';

import { asAdapterError, fromTrezorFailure, fromUnknown } from './errors';
import { log } from './log';
import {
  buildTrezorCosignerNodes,
  buildTrezorMultisigBlock,
  type TrezorCosignerNode,
  type TrezorMultisig,
} from './multisig';
import { TrezorConnect } from './sdk';
import type {
  AdapterResult,
  TrezorCoin,
  TrezorScriptType,
} from './types';

type TrezorTxInput = {
  prev_hash: string;
  prev_index: number;
  amount: number;
  sequence: number;
  script_type: 'SPENDWITNESS';
  multisig: TrezorMultisig;
  address_n: number[];
};

type TrezorTxOutput =
  | {
      address: string;
      amount: number;
      script_type: 'PAYTOADDRESS';
    }
  | {
      address_n: number[];
      amount: number;
      script_type: 'PAYTOWITNESS';
      multisig: TrezorMultisig;
    };

/** Wallet-side description of the vault the PSBT spends from. */
export type SignVault = {
  /** Threshold (`m` in `m-of-n`). */
  requiredSignatures: number;
  /** Cosigning keys in the same order the descriptor lists them. */
  keys: readonly DescriptorKey[];
  /** Defaults to `'btc'` (mainnet). */
  coin?: TrezorCoin;
};

/** Inputs accepted by {@link signWshSortedMultiPsbt}. */
export type SignPsbtInput = {
  /** Base64-encoded PSBT v2 to sign. */
  psbtBase64: string;
  /** Vault context — same keys + threshold the descriptor was built with. */
  vault: SignVault;
  /**
   * Master fingerprint (8 lowercase hex characters) of the cosigner
   * the user picked in the UI. Used to pick the input's `address_n`
   * for the Trezor request. If the connected device turns out to be
   * a *different* vault cosigner (typical when one Trezor hosts
   * several passphrase-protected wallets), the adapter still produces
   * a usable signature — Trezor signs with whatever vault key its
   * active passphrase derives, and the adapter's post-flight
   * verifier moves the signature to the correct PSBT slot. See
   * {@link SignPsbtResult.signedAsFingerprint} / `pivoted`.
   */
  signerFingerprint: string;
  /** Echo of the script type for forward-compatibility; only `'p2wsh'` today. */
  scriptType?: TrezorScriptType;
};

/** Output of {@link signWshSortedMultiPsbt}. */
export type SignPsbtResult = {
  /** Updated PSBT v2 base64 with the new partial signatures attached. */
  psbtBase64: string;
  /** Number of inputs the device actually signed. */
  signedInputCount: number;
  /**
   * Master fingerprint of the cosigner the caller asked the adapter
   * to sign as (echoed verbatim from {@link SignPsbtInput.signerFingerprint}).
   */
  requestedFingerprint: string;
  /**
   * Master fingerprint of the cosigner whose pubkey actually verified
   * the fresh signature returned by the device. Equal to
   * {@link requestedFingerprint} on a normal flow; differs when the
   * post-flight verifier re-attributed the signature to a different
   * (but still vault-resident) cosigner because the connected
   * passphrase wallet was not the one the operator clicked. The
   * wallet UI compares both fields to render a "signed as X instead
   * of Y" notice.
   */
  signedAsFingerprint: string;
  /**
   * `true` when the post-flight verifier moved the signature from
   * the requested cosigner's slot to a different (but still
   * vault-resident) one — typically the same physical Trezor
   * representing a different passphrase wallet than the operator
   * selected. The wallet UI keys an informational toast off this.
   */
  pivoted: boolean;
};

/**
 * Drive a Trezor through the full signing flow for a PSBT v2 produced
 * by `buildWshSortedMultiPsbt`. **Exactly one** device prompt — the
 * actual transaction confirmation — covers every input the calling
 * cosigner can sign.
 *
 * Returns the input PSBT with the new partial-sig keypairs attached,
 * ready to be persisted back to the vault store and combined with
 * other cosigners' signatures by a downstream finaliser.
 *
 * Cross-cosigner safety (single Trezor + multiple passphrases):
 * the adapter does NOT pre-fetch the device's master fingerprint
 * (which would force a second on-device confirmation in Trezor
 * Suite to consent to an xpub disclosure). Instead, after Trezor
 * returns, the adapter recomputes the canonical BIP-143 sighash
 * directly from the PSBT and ECDSA-verifies the fresh signature
 * against the picked cosigner's pubkey. On mismatch — the typical
 * case when the active passphrase wallet is a *different* vault
 * cosigner than the operator clicked on — the adapter sweeps every
 * cosigner pubkey in the input's bip32Derivation block and moves
 * the signature to the slot it mathematically belongs to. The
 * `pivoted` flag on the result lets the UI surface a clear notice.
 * When no cosigner pubkey matches at all the signature is refused
 * with a precise error, so a broken partial sig can never end up
 * in the proposal store.
 *
 * Trezor's own multisig validation is the upstream guarantee that
 * a totally unrelated passphrase wallet — one that is not even a
 * vault cosigner — never produces a signature in the first place:
 * the device refuses to sign a P2WSH multisig input with a key
 * that is not in the supplied multisig pubkey set.
 *
 * Note on the wire-format echo: the adapter passes the PSBT's tx
 * version (BIP-370 forces ≥ 2) and locktime through to Trezor
 * explicitly, otherwise Trezor's defaults (`version=1`, `locktime=0`
 * for Bitcoin) would silently produce signatures over a different
 * sighash than the one the wallet finalises and the network
 * verifies.
 */
export async function signWshSortedMultiPsbt(
  input: SignPsbtInput,
): Promise<AdapterResult<SignPsbtResult>> {
  const coin = input.vault.coin ?? 'btc';
  const scriptType = input.scriptType ?? 'p2wsh';
  log.info('signWshSortedMultiPsbt entry', {
    coin,
    scriptType,
    requestedFingerprint: input.signerFingerprint,
    vault: {
      requiredSignatures: input.vault.requiredSignatures,
      keyCount: input.vault.keys.length,
      cosigners: input.vault.keys.map((k, i) => ({
        index: i,
        fingerprint: k.fingerprint,
        derivationPath: k.derivationPath,
        xpubPreview: previewXpub(k.xpub),
      })),
    },
    psbtLengthChars: input.psbtBase64.length,
  });

  if (scriptType !== 'p2wsh') {
    log.error('unsupported script type', { scriptType });
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Unsupported script type for signing: ${scriptType}`,
      ),
    };
  }

  const fingerprint = input.signerFingerprint.trim().toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(fingerprint)) {
    log.error('signer fingerprint malformed', {
      raw: input.signerFingerprint,
      normalised: fingerprint,
    });
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Master fingerprint must be 8 lowercase hex characters (got "${input.signerFingerprint}").`,
      ),
    };
  }

  if (input.vault.keys.length === 0) {
    log.error('vault has no keys');
    return {
      ok: false,
      error: asAdapterError('invalid_path', 'At least one cosigning key is required.'),
    };
  }
  if (
    input.vault.requiredSignatures < 1 ||
    input.vault.requiredSignatures > input.vault.keys.length
  ) {
    log.error('required-signatures threshold out of range', {
      requiredSignatures: input.vault.requiredSignatures,
      keyCount: input.vault.keys.length,
    });
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Required signatures must be between 1 and ${input.vault.keys.length}.`,
      ),
    };
  }
  log.info('vault config validated', {
    threshold: `${input.vault.requiredSignatures}-of-${input.vault.keys.length}`,
  });

  let inspected;
  try {
    inspected = inspectPsbtV2(input.psbtBase64);
  } catch (cause) {
    log.error('PSBT inspection failed', { error: cause });
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        cause instanceof PsbtInspectError
          ? cause.message
          : `PSBT inspection failed: ${(cause as Error).message}`,
      ),
    };
  }
  log.info('PSBT inspected', {
    inputCount: inspected.inputs.length,
    outputCount: inspected.outputs.length,
    txVersion: inspected.txVersion,
    fallbackLocktime: inspected.fallbackLocktime,
    inputs: inspected.inputs.map((i, idx) => ({
      index: idx,
      txid: i.txid,
      vout: i.vout,
      valueSats: i.valueSats,
      bip32DerivationFingerprints: i.bip32Derivation.map((d) =>
        bytesToHex(d.masterFingerprint),
      ),
      partialSigCount: i.partialSigs.length,
      sequence: i.sequence,
    })),
    outputs: inspected.outputs.map((o, idx) => ({
      index: idx,
      amountSats: o.amountSats,
      hasWitnessScript: o.witnessScript !== null,
      bip32DerivationFingerprints: o.bip32Derivation.map((d) =>
        bytesToHex(d.masterFingerprint),
      ),
    })),
  });

  // Pre-parse every cosigner xpub into the Trezor `HDNodeType` shape.
  // Done once up front so per-input/per-output multisig blocks are a
  // cheap struct copy rather than a fresh base58check decode each time.
  let cosignerNodes: readonly TrezorCosignerNode[];
  try {
    cosignerNodes = buildTrezorCosignerNodes(input.vault.keys);
  } catch (cause) {
    log.error('cosigner xpub parsing failed', { error: cause });
    return {
      ok: false,
      error: asAdapterError('invalid_path', (cause as Error).message),
    };
  }
  log.info('cosigner xpubs parsed', {
    cosigners: cosignerNodes.map((c, i) => ({
      index: i,
      fingerprint: c.key.fingerprint,
      depth: c.node.depth,
      childNum: c.node.child_num,
    })),
  });

  const requestedCosignerIndex = cosignerNodes.findIndex(
    (cosigner) => cosigner.key.fingerprint.toLowerCase() === fingerprint,
  );
  if (requestedCosignerIndex === -1) {
    log.error('requested cosigner not in vault', {
      requestedFingerprint: fingerprint,
      vaultFingerprints: cosignerNodes.map((c) =>
        c.key.fingerprint.toLowerCase(),
      ),
    });
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        `Requested cosigner fingerprint ${fingerprint} is not part of this vault.`,
      ),
    };
  }
  log.info('requested cosigner located in vault', {
    requestedFingerprint: fingerprint,
    requestedCosignerIndex,
  });

  // Note on cross-passphrase signing
  // --------------------------------
  // We do NOT pre-fetch the device's master fingerprint here. Doing
  // so would force a second on-device confirmation in Trezor Suite
  // (the "Export accounts" prompt that confirms an xpub disclosure),
  // which is a worse UX for what is, on a fresh build, redundant
  // information.
  //
  // The device's own multisig validation + the post-flight
  // signature verification below cover the same safety properties:
  //
  //   - Trezor refuses to sign a `wsh(sortedmulti(...))` input with
  //     a key that is not in the supplied multisig.pubkeys set, so
  //     a device with a totally unrelated seed errors out before
  //     producing any signature.
  //   - When the active passphrase wallet *is* a vault cosigner —
  //     just not the one the operator picked in the UI — Trezor
  //     happily signs with that key. The fresh signature is then
  //     verified post-flight against the supposed cosigner's
  //     pubkey; on mismatch we sweep every cosigner pubkey in the
  //     input's bip32Derivation block and re-attribute to the
  //     matching one. The PSBT slot the signature lands in is
  //     therefore always the one that mathematically owns the
  //     signature, regardless of what the operator clicked.
  const signerKey = cosignerNodes[requestedCosignerIndex]!.key;
  const signerBaseAddressN = bip32PathToAddressN(
    ensureLeadingMaster(signerKey.derivationPath),
  );
  log.info('signer base address_n resolved', {
    requestedCosignerIndex,
    derivationPath: signerKey.derivationPath,
    addressN: signerBaseAddressN,
  });

  // ----- input translation -------------------------------------------------
  //
  // We translate using the *requested* cosigner's bip32Derivation
  // entry as the wallet-side intent. If the connected device turns
  // out to be a different (but still vault-resident) cosigner — the
  // common single-Trezor / multiple-passphrase case — Trezor still
  // signs successfully because the device's derived key is in the
  // multisig pubkey set, and the post-flight verifier below moves
  // the resulting signature to the correct PSBT slot.

  const txInputs: TrezorTxInput[] = [];
  const inputContext: { canSign: boolean; chain: 0 | 1; index: number; signerLeafPubkey: Uint8Array | null }[] = [];
  for (let i = 0; i < inspected.inputs.length; i += 1) {
    const psbtInput = inspected.inputs[i]!;
    const ourEntry = findEntryByFingerprint(
      psbtInput.bip32Derivation,
      fingerprint,
    );
    const slot = ourEntry
      ? parseChainIndexFromPath(ourEntry.path)
      : resolveSlotFromBip32Any(psbtInput.bip32Derivation);
    if (!slot) {
      log.error('input slot resolution failed', {
        inputIndex: i,
        bip32DerivationCount: psbtInput.bip32Derivation.length,
      });
      return {
        ok: false,
        error: asAdapterError(
          'invalid_path',
          `Input ${i}: PSBT_IN_BIP32_DERIVATION carries no parsable (chain, index) for any cosigner.`,
        ),
      };
    }
    txInputs.push(
      buildTrezorInput({
        psbtInput,
        chain: slot.chain,
        index: slot.index,
        requiredSignatures: input.vault.requiredSignatures,
        cosignerNodes,
        signerBaseAddressN: ourEntry ? signerBaseAddressN : null,
      }),
    );
    inputContext.push({
      canSign: ourEntry !== null,
      chain: slot.chain,
      index: slot.index,
      signerLeafPubkey: ourEntry ? ourEntry.pubkey : null,
    });
    log.info('input translated for Trezor', {
      inputIndex: i,
      txid: psbtInput.txid,
      vout: psbtInput.vout,
      valueSats: psbtInput.valueSats,
      chain: slot.chain,
      addrIndex: slot.index,
      canSign: ourEntry !== null,
      signerLeafPubkeyPreview: ourEntry ? bytesToHex(ourEntry.pubkey).slice(0, 16) + '…' : null,
      addressN: [...(signerBaseAddressN ?? []), slot.chain, slot.index],
    });
  }

  if (!inputContext.some((ctx) => ctx.canSign)) {
    log.error('no signable inputs for the connected device', {
      requestedFingerprint: fingerprint,
      inputCount: inputContext.length,
    });
    return {
      ok: false,
      error: asAdapterError(
        'invalid_path',
        'No PSBT input belongs to the connected device — nothing to sign.',
      ),
    };
  }

  // ----- output translation ------------------------------------------------

  let txOutputs: TrezorTxOutput[];
  try {
    txOutputs = inspected.outputs.map((output, i) =>
      buildTrezorOutput({
        output,
        requiredSignatures: input.vault.requiredSignatures,
        cosignerNodes,
        signerFingerprint: fingerprint,
        signerBaseAddressN,
        coin,
        indexLabel: i,
      }),
    );
  } catch (cause) {
    log.error('output translation failed', { error: cause });
    return {
      ok: false,
      error: asAdapterError('invalid_path', (cause as Error).message),
    };
  }
  log.info('outputs translated for Trezor', {
    outputs: txOutputs.map((o, i) => ({
      index: i,
      script_type: o.script_type,
      amount: o.amount,
      target:
        o.script_type === 'PAYTOADDRESS'
          ? o.address
          : `change → address_n ${JSON.stringify(o.address_n)}`,
    })),
  });

  // Mirror the PSBT's transaction version + locktime in the Trezor
  // request. CRITICAL: Trezor's `signTransaction` defaults to
  // `version=1` for Bitcoin if the caller does not pass an explicit
  // value (see `@trezor/connect/lib/api/bitcoin/signtx.js`). Asylia
  // builds PSBT v2 with `nVersion = 2` (BIP-370 requires version >=
  // 2), so without this echo Trezor would compute the BIP-143
  // sighash over `nVersion = 1` while the wallet finalises the tx
  // with `nVersion = 2`, the network re-derives the sighash with
  // `nVersion = 2`, and `CHECKMULTISIG` fails with NULLFAIL because
  // the signatures were made over a different sighash than what the
  // verifier expects. Echoing the locktime is the same idea — keep
  // the device and the wallet computing the same preimage.
  const txVersion = inspected.txVersion;
  const txLocktime = inspected.fallbackLocktime ?? 0;

  log.info('signTransaction request', {
    inputCount: txInputs.length,
    outputCount: txOutputs.length,
    coin,
    version: txVersion,
    locktime: txLocktime,
    requestedFingerprint: fingerprint,
    inputsCanSign: inputContext.filter((ctx) => ctx.canSign).length,
  });

  // ----- device call -------------------------------------------------------

  let response;
  const signStart = Date.now();
  try {
    response = await TrezorConnect.signTransaction({
      coin,
      version: txVersion,
      locktime: txLocktime,
      // Bridge our typed structs and the SDK's deeply-nested generated
      // types — the runtime shape is what the SDK validates, and we
      // mirror Trezor's protobuf schema 1:1 (verified above and by
      // Trezor's own JSON schema).
      inputs: txInputs as never,
      outputs: txOutputs as never,
    });
  } catch (cause) {
    log.error('signTransaction threw', {
      error: cause,
      elapsedMs: Date.now() - signStart,
    });
    return { ok: false, error: fromUnknown(cause) };
  }

  if (!response.success) {
    log.error('signTransaction failed', {
      response,
      elapsedMs: Date.now() - signStart,
    });
    return { ok: false, error: fromTrezorFailure(response) };
  }

  const rawSignatures = response.payload.signatures ?? [];
  log.info('signTransaction response', {
    elapsedMs: Date.now() - signStart,
    signatureCount: rawSignatures.length,
    signatureLengths: rawSignatures.map((s) => (typeof s === 'string' ? s.length : 0)),
    serializedTxLengthChars: response.payload.serializedTx?.length ?? 0,
  });

  if (rawSignatures.length !== txInputs.length) {
    log.error('signature count mismatch', {
      expected: txInputs.length,
      got: rawSignatures.length,
    });
    return {
      ok: false,
      error: asAdapterError(
        'unknown',
        `Trezor returned ${rawSignatures.length} signatures for ${txInputs.length} inputs.`,
      ),
    };
  }

  // ----- merge signatures back into the PSBT ------------------------------
  //
  // Post-flight verification. The single safety net for every
  // signature this adapter ever attaches to a PSBT:
  //
  //   - The "wrong cosigner picked but right vault device" case
  //     (one Trezor + several passphrase-protected wallets, the
  //     operator clicked one cosigner row but had a different
  //     passphrase active) — Trezor signs successfully because the
  //     active passphrase is also a vault cosigner, but the
  //     signature is mathematically owned by a *different* leaf
  //     pubkey than the one the operator clicked. The verifier
  //     detects the mismatch, sweeps every cosigner pubkey on that
  //     input, and re-attributes the signature to the slot it
  //     actually belongs to.
  //   - Any future / latent sighash desync (e.g. Trezor SDK flips
  //     a default we never thought to override) — caught here,
  //     refused with a precise error, so a broken partial sig
  //     never lands in the proposal store and we never produce a
  //     transaction the network would reject.
  //
  // The verifier recomputes the canonical BIP-143 sighash directly
  // from the PSBT (same algorithm the network uses) and runs a
  // standard ECDSA verify against each candidate pubkey. Cheap and
  // independent of the device.

  type AttributedSig = {
    inputIndex: number;
    sigHex: string;
    sigBytes: Uint8Array;
    expectedPubkey: Uint8Array;
    actualPubkey: Uint8Array;
    reattributed: boolean;
  };
  const attributed: AttributedSig[] = [];

  for (let i = 0; i < rawSignatures.length; i += 1) {
    const ctx = inputContext[i]!;
    if (!ctx.canSign || !ctx.signerLeafPubkey) {
      log.info('skipping non-signable input from Trezor response', {
        inputIndex: i,
        canSign: ctx.canSign,
        hasSignerLeafPubkey: ctx.signerLeafPubkey !== null,
      });
      continue;
    }
    const sigHex = rawSignatures[i];
    if (typeof sigHex !== 'string' || sigHex.length === 0) {
      log.error('empty signature for signable input', { inputIndex: i });
      return {
        ok: false,
        error: asAdapterError(
          'unknown',
          `Trezor produced no signature for input ${i}.`,
        ),
      };
    }
    const sigBytes = hexToBytes(sigHex);
    const expectedPubkey = ctx.signerLeafPubkey;

    // The PSBT bytes Trezor signed over and the bytes we will
    // verify against include the SIGHASH_ALL trailing byte. Build
    // the same `<DER>0x01` form the verifier expects so we don't
    // have to reach into its internals.
    const sigWithSighashByte = new Uint8Array(sigBytes.length + 1);
    sigWithSighashByte.set(sigBytes, 0);
    sigWithSighashByte[sigBytes.length] = 0x01;

    const verifies = verifySegwitV0SignatureAgainstPubkey(
      inspected,
      i,
      expectedPubkey,
      sigWithSighashByte,
    );
    let actualPubkey = expectedPubkey;
    let reattributed = false;

    if (!verifies) {
      const psbtInput = inspected.inputs[i]!;
      const candidates = psbtInput.bip32Derivation.map((d) => d.pubkey);
      const owner = findSegwitV0SignatureOwner(
        inspected,
        i,
        sigWithSighashByte,
        candidates,
      );
      if (owner) {
        actualPubkey = owner;
        reattributed = true;
        log.warn('post-flight: re-attributing signature to a different vault cosigner', {
          inputIndex: i,
          expectedPubkeyHex: bytesToHex(expectedPubkey),
          actualPubkeyHex: bytesToHex(owner),
        });
      } else {
        log.error('post-flight: signature does not verify against any vault cosigner — refusing it', {
          inputIndex: i,
          expectedPubkeyHex: bytesToHex(expectedPubkey),
          candidatePubkeyHexes: candidates.map((c) => bytesToHex(c)),
          sigHexPreview: sigHex.slice(0, 16) + '…',
        });
        return {
          ok: false,
          error: asAdapterError(
            'unknown',
            `The signature returned for input ${i} does not verify against any of this vault's cosigner pubkeys. ` +
              `This usually means the connected device produced the signature with a passphrase wallet that is not part of the vault, ` +
              `or that the device speaks a different transaction format than the wallet built. ` +
              `Disconnect, unlock the right passphrase wallet, and try again.`,
          ),
        };
      }
    }

    log.info('partial-sig verified — preparing keypair for PSBT merge', {
      inputIndex: i,
      pubkeyHex: bytesToHex(actualPubkey),
      reattributed,
      signatureHexPreview: sigHex.slice(0, 16) + '…',
      signatureBytes: sigHex.length / 2,
    });

    attributed.push({
      inputIndex: i,
      sigHex,
      sigBytes,
      expectedPubkey,
      actualPubkey,
      reattributed,
    });
  }

  const signedInputs: PartialSignatureToAdd[] = attributed.map((a) => ({
    inputIndex: a.inputIndex,
    pubkey: a.actualPubkey,
    signature: a.sigBytes,
  }));
  const postFlightReattributed = attributed.some((a) => a.reattributed);

  let merged: string;
  const mergeStart = Date.now();
  try {
    merged = addPartialSignaturesToPsbt(input.psbtBase64, signedInputs);
  } catch (cause) {
    log.error('PSBT signature merge failed', {
      error: cause,
      elapsedMs: Date.now() - mergeStart,
      attemptedSignatureCount: signedInputs.length,
    });
    return {
      ok: false,
      error: asAdapterError(
        'unknown',
        cause instanceof Error
          ? cause.message
          : 'Could not merge partial signatures into the PSBT.',
      ),
    };
  }
  log.info('PSBT partial sigs merged', {
    elapsedMs: Date.now() - mergeStart,
    mergedSignatureCount: signedInputs.length,
    psbtLengthChars: merged.length,
    psbtLengthDeltaChars: merged.length - input.psbtBase64.length,
  });

  // The *actual* signing identity is whatever the post-flight
  // verification proved by ECDSA-verifying the fresh signature
  // against the cosigner pubkey set. If the verifier fell back to a
  // re-attribution it is the matched cosigner; otherwise it is the
  // requested cosigner (verified to be the legitimate signer).
  const firstSigned = attributed[0];
  const fingerprintFromActualPubkey = firstSigned
    ? findFingerprintForPubkey(
        inspected.inputs[firstSigned.inputIndex]!.bip32Derivation,
        firstSigned.actualPubkey,
      )
    : null;
  const finalSignedAsFingerprint = fingerprintFromActualPubkey ?? fingerprint;

  log.info('signTransaction success', {
    signedInputCount: signedInputs.length,
    psbtLengthChars: merged.length,
    requestedFingerprint: fingerprint,
    signedAsFingerprint: finalSignedAsFingerprint,
    pivoted: postFlightReattributed,
  });

  return {
    ok: true,
    data: {
      psbtBase64: merged,
      signedInputCount: signedInputs.length,
      requestedFingerprint: fingerprint,
      signedAsFingerprint: finalSignedAsFingerprint,
      pivoted: postFlightReattributed,
    },
  };
}

// =============================================================================
// Internals
// =============================================================================

/**
 * Default nSequence used when the PSBT input has no explicit value.
 * 0xffffffff means "final" (no RBF, nLockTime ignored). The Asylia
 * builder does not set sequence explicitly, so this is what every
 * input on a freshly built proposal carries when broadcast.
 */
const SEQUENCE_FINAL = 0xffffffff;

function buildTrezorInput(params: {
  psbtInput: InspectedPsbtInput;
  chain: 0 | 1;
  index: number;
  requiredSignatures: number;
  cosignerNodes: readonly TrezorCosignerNode[];
  signerBaseAddressN: number[] | null;
}): TrezorTxInput {
  const { psbtInput, chain, index, signerBaseAddressN } = params;
  const sequence =
    psbtInput.sequence !== null ? psbtInput.sequence : SEQUENCE_FINAL;

  const multisig = buildTrezorMultisigBlock({
    cosignerNodes: params.cosignerNodes,
    requiredSignatures: params.requiredSignatures,
    chain,
    index,
    bip32Derivation: psbtInput.bip32Derivation,
    existingPartialSigs: psbtInput.partialSigs,
  });

  // For inputs we cannot sign we still need to declare a valid
  // `address_n`; Trezor uses it to skip the input rather than to
  // attempt to sign with the wrong key. Default to the standard
  // Asylia P2WSH multisig prefix so the structure stays well-formed.
  const baseAddressN =
    signerBaseAddressN ?? bip32PathToAddressN("m/48'/0'/0'/2'");

  return {
    prev_hash: psbtInput.txid,
    prev_index: psbtInput.vout,
    amount: psbtInput.valueSats,
    sequence,
    script_type: 'SPENDWITNESS',
    multisig,
    address_n: [...baseAddressN, chain, index],
  };
}

function buildTrezorOutput(params: {
  output: InspectedPsbtOutput;
  requiredSignatures: number;
  cosignerNodes: readonly TrezorCosignerNode[];
  signerFingerprint: string;
  signerBaseAddressN: number[];
  coin: TrezorCoin;
  indexLabel: number;
}): TrezorTxOutput {
  const { output, indexLabel } = params;

  // External output — recover the bech32 address from the script and
  // pass as a plain PAYTOADDRESS so Trezor renders it verbatim.
  if (output.bip32Derivation.length === 0 || !output.witnessScript) {
    const network = params.coin === 'btc' ? 'mainnet' : 'mainnet';
    const address = addressFromScript(output.scriptPubKey, network);
    if (!address) {
      throw new Error(
        `Output ${indexLabel}: cannot decode scriptPubKey to a Bitcoin address.`,
      );
    }
    return {
      address,
      amount: output.amountSats,
      script_type: 'PAYTOADDRESS',
    };
  }

  // Change output back to the vault. Use the signing cosigner's entry
  // in the bip32Derivation block so Trezor can confirm "this output
  // returns to me". A vault output without an entry for the signing
  // device would be an unverifiable destination, so we refuse it.
  const ourEntry = findEntryByFingerprint(
    output.bip32Derivation,
    params.signerFingerprint,
  );
  if (!ourEntry) {
    throw new Error(
      `Output ${indexLabel}: bip32Derivation does not include the signing device's fingerprint.`,
    );
  }
  const slot = parseChainIndexFromPath(ourEntry.path);
  if (!slot) {
    throw new Error(
      `Output ${indexLabel}: cannot derive (chain, index) from path ${ourEntry.path}.`,
    );
  }

  return {
    script_type: 'PAYTOWITNESS',
    amount: output.amountSats,
    address_n: [...params.signerBaseAddressN, slot.chain, slot.index],
    multisig: buildTrezorMultisigBlock({
      cosignerNodes: params.cosignerNodes,
      requiredSignatures: params.requiredSignatures,
      chain: slot.chain,
      index: slot.index,
      bip32Derivation: output.bip32Derivation,
      existingPartialSigs: [],
    }),
  };
}

function findEntryByFingerprint(
  entries: readonly PsbtBip32Derivation[],
  fingerprint: string,
): PsbtBip32Derivation | null {
  for (const entry of entries) {
    if (bytesToHex(entry.masterFingerprint) === fingerprint) return entry;
  }
  return null;
}

/**
 * Reverse lookup used by the post-flight: given a leaf pubkey we
 * just verified a fresh signature against, find the master
 * fingerprint of the cosigner that pubkey belongs to. Returns
 * `null` if the pubkey is not in the supplied `bip32Derivation`
 * block (which would be a logic error — the post-flight only ever
 * picks pubkeys from this same block).
 */
function findFingerprintForPubkey(
  entries: readonly PsbtBip32Derivation[],
  pubkey: Uint8Array,
): string | null {
  for (const entry of entries) {
    if (bytesEqual(entry.pubkey, pubkey)) {
      return bytesToHex(entry.masterFingerprint);
    }
  }
  return null;
}

/**
 * Same as `findEntryByFingerprint` but returns the first cosigner's
 * `(chain, index)` for the case where we have to translate an input
 * we cannot sign — the slot is the same for every cosigner.
 */
function resolveSlotFromBip32Any(
  entries: readonly PsbtBip32Derivation[],
): { chain: 0 | 1; index: number } | null {
  for (const entry of entries) {
    const slot = parseChainIndexFromPath(entry.path);
    if (slot) return slot;
  }
  return null;
}

function parseChainIndexFromPath(
  path: string,
): { chain: 0 | 1; index: number } | null {
  const numbers = bip32PathToAddressN(path);
  if (numbers.length < 2) return null;
  const indexComponent = numbers[numbers.length - 1]!;
  const chainComponent = numbers[numbers.length - 2]!;
  if ((indexComponent & 0x80000000) !== 0) return null;
  if ((chainComponent & 0x80000000) !== 0) return null;
  if (chainComponent !== 0 && chainComponent !== 1) return null;
  return { chain: chainComponent as 0 | 1, index: indexComponent };
}

function hexToBytes(hex: string): Uint8Array {
  const normalised = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalised.length % 2 !== 0) {
    throw new Error(`Hex string of odd length (${normalised.length}).`);
  }
  const out = new Uint8Array(normalised.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(normalised.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex byte at offset ${i * 2}.`);
    }
    out[i] = byte;
  }
  return out;
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

/**
 * Normalise a BIP-32 path string so it always carries a leading
 * `m/`. `DescriptorKey.derivationPath` is stored without the prefix
 * in some places (e.g. early test fixtures), but the Trezor SDK and
 * `bip32PathToAddressN` both expect the canonical form. Returning
 * `'m'` for an empty input keeps the helper usable when a caller
 * wants the master node itself.
 */
function ensureLeadingMaster(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === 'm' || trimmed === 'M') return 'm';
  if (trimmed.startsWith('m/') || trimmed.startsWith('M/')) return trimmed;
  return `m/${trimmed}`;
}

/**
 * Render an xpub into a 12-character preview suitable for log
 * output. Logs go to the operator's browser console — leaking the
 * full xpub there is harmless (it is a *public* key) but the noise
 * obscures more useful fields, so we surface only the discriminating
 * suffix-style preview.
 */
function previewXpub(xpub: string): string {
  if (typeof xpub !== 'string' || xpub.length === 0) return '(empty)';
  if (xpub.length <= 16) return xpub;
  return `${xpub.slice(0, 8)}…${xpub.slice(-8)}`;
}
