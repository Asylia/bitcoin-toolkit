# @asylia/hw-trezor

**Status:** v0.1 — xpub export and `wsh(sortedmulti(...))` PSBT signing both shipping.

Asylia Trezor adapter. Wraps `@trezor/connect-web` behind an Asylia-shaped surface (`initTrezor`, `exportTrezorRoot`, `signWshSortedMultiPsbt`) so the wallet UI never imports the vendor SDK directly.

## Why a separate package

Hardware-wallet code is a hard security boundary:

- It speaks to a physical device the user trusts.
- It interprets PSBTs into device-side prompts the user signs.
- It owns the wire protocol with the vendor SDK.

Pulling it out of the wallet SPA makes the boundary easy to audit, upgradeable independently of the UI, and reusable by the planned Capacitor signer app.

## Public API

```ts
import {
  initTrezor,
  exportTrezorRoot,
  signWshSortedMultiPsbt,
  type ExportRootResult,
  type SignPsbtResult,
  type TrezorManifest,
  type TrezorScriptType,
} from '@asylia/hw-trezor'

// 1. Bootstrap (idempotent — safe to call from every screen).
await initTrezor({
  appName: 'Asylia Wallet',
  appUrl: 'https://wallet.asylia.io',
  email: 'support@asylia.io',
})

// 2. Prompt the device for the BIP-48 multisig root xpub.
const exportResult = await exportTrezorRoot({
  derivationPath: "m/48'/0'/0'/2'", // P2WSH multisig — wsh(sortedmulti(...))
  scriptType: 'p2wsh',
})

if (exportResult.ok) {
  const { xpub, masterFingerprint, device } = exportResult.data
  // Persist (xpub + masterFingerprint) in V1_SignKeys.
}

// 3. Sign a PSBT v2 produced by `@asylia/btc-core/buildWshSortedMultiPsbt`.
//    One device prompt covers every input the supplied cosigner can sign.
const signResult = await signWshSortedMultiPsbt({
  psbtBase64,                         // base64 PSBT v2
  vault: {
    requiredSignatures: 2,            // m in m-of-n
    keys: descriptorKeys,             // every cosigner's xpub + fingerprint + path
  },
  signerFingerprint: 'd34db33f',      // hint: cosigner the user picked in the UI
})

if (signResult.ok) {
  const {
    psbtBase64: updated,
    signedInputCount,
    requestedFingerprint,
    signedAsFingerprint,
    pivoted,
  } = signResult.data

  // Persist `updated` to the proposal store; `signedInputCount`
  // tells you how many inputs the device just attached signatures
  // to (typically equal to the number of vault inputs in the spend).
  //
  // When `pivoted === true`, the connected device represented a
  // *different* cosigner than the one the user picked (e.g. a
  // different passphrase wallet on the same physical Trezor).
  // The signature is attached to `signedAsFingerprint`'s slot, not
  // `requestedFingerprint`'s — surface that in the UI so the user
  // does not "re-sign with the right passphrase" and end up with
  // two attempts under one cosigner.
}
```

Both adapter functions return `{ ok, data | error }` — never throw — so callers can render inline error states without try/catch.

## Why xpub at `m/48'/coin'/account'/script_type'`

Asylia targets **native-SegWit BIP-48 multisig only** — `wsh(sortedmulti(...))` at `script_type = 2'`. From the xpub at this depth, the client can derive every receive and change address (`/0/i`, `/1/i`) without re-prompting the device, because `chain` and `index` are unhardened.

The nested-SegWit BIP-48 branch (`script_type = 1'`, `sh(wsh(...))`) is intentionally **NOT supported** by this adapter and not on the roadmap. The `TrezorScriptType` union exposes a single value (`'p2wsh'`) so adding the legacy variant is a typed compile-time decision, not an oversight.

## Master fingerprint

Trezor returns a BIP-380 descriptor of the form `[xfp/path]xpub#checksum`. The adapter parses the leading 8-character hex as the master fingerprint, which is the canonical key identity in BIP-380 and the value Asylia stores in `V1_SignKeys.fingerprint`.

The descriptor field is unavailable on Trezor Model One; the adapter returns a precise `descriptor_unavailable` error in that case so the UI can prompt the user to upgrade.

## Connection transports and prompts (web)

The adapter uses Trezor's default `coreMode: 'auto'` core resolution:

- If the local Trezor service is available (standalone Bridge or the
  service hosted by Trezor Suite) → `iframe` mode, with device events
  streaming into the SPA.
- Otherwise → `popup` mode, where the official Trezor Connect popup
  uses WebUSB inside the popup.

Browser-side permission, PIN, and passphrase prompts are owned by the
official Trezor Connect popup. Export approval remains on the physical
Trezor screen. The wallet UI should not tell the user that Trezor Suite
itself handles those prompts; Suite is only relevant as a local
transport provider or as a possible competing app holding the device.

**No Bluetooth.** `@trezor/connect-web` is USB-only in the browser, even for Trezor Safe 7 (which does have a hardware BLE radio). BLE will land with the future Capacitor signer app where the OS exposes proper BLE APIs.

## Errors

Vendor failures are normalised through `errors.ts` into a small, stable set:

| Code                       | Meaning                                                |
| -------------------------- | ------------------------------------------------------ |
| `init_failed`              | TrezorConnect.init failed (iframe blocked, etc.)        |
| `manifest_required`        | No manifest passed — configuration error.               |
| `cancelled`                | User dismissed the popup or rejected on the device.     |
| `device_disconnected`      | Cable unplugged mid-call.                               |
| `device_not_found`         | No device detected.                                     |
| `device_in_use`            | Trezor is busy with another window or call.             |
| `device_locked`            | Suite / another tab appears to hold the device session. |
| `device_timeout`           | Device did not answer before the wall-clock timeout.    |
| `firmware_too_old`         | Update needed in Trezor Suite first.                    |
| `descriptor_unavailable`   | Model One — can't return BIP-380 descriptor.            |
| `invalid_path`             | Path rejected by the device or pre-flight regex.        |
| `transport_unavailable`    | Bridge missing, WebUSB blocked.                         |
| `unknown`                  | Catch-all; the original cause is kept on `error.cause`. |

Every code maps to short, user-facing copy in `errors.ts`. The wallet renders that copy directly inside the `Alert` component on the Connect step.

## Why MIT

Same reasoning as `@asylia/btc-core`: this package is a security-critical surface and must be auditable. MIT matches the license model used by `@trezor/connect-web` and the rest of the Bitcoin tooling ecosystem.

## How signing works

Trezor Connect's `signTransaction` API does **not** consume PSBT payloads directly. It speaks Trezor's native protobuf shape: `TxInputType[]`, `TxOutputType[]`, with multisig metadata expressed as a `MultisigRedeemScriptType` (nodes + per-pubkey path, threshold, optional `pubkeys_order` flag).

The `signWshSortedMultiPsbt` function bridges the two formats:

1. Walks the PSBT v2 with the `inspectPsbtV2` helper from `@asylia/btc-core` to extract every input's outpoint, witness UTXO, witness script, bip32Derivation, and any partial sigs already attached.
2. Translates each input into a `SPENDWITNESS` Trezor input with a populated multisig block (`nodes` = cosigner xpubs at depth 4, shared `address_n: [chain, index]`, `pubkeys_order: LEXICOGRAPHIC` so the on-chain script reproduces `sortedmulti`).
3. Translates outputs into `PAYTOADDRESS` (external recipients, address recovered from the script via `addressFromScript`) or `PAYTOWITNESS` (change back to the vault, with the same multisig block + the signing cosigner's `address_n` so the device renders the output as "change returning to my wallet").
4. Calls `TrezorConnect.signTransaction` with **one** device prompt covering every signable input. The PSBT's `nVersion` and locktime are forwarded explicitly — Trezor's defaults (`version=1`, `locktime=0` for Bitcoin) would otherwise produce signatures over a different sighash than the one the wallet finalises and the network verifies.
5. **Post-flight verification.** The adapter recomputes the canonical BIP-143 sighash directly from the PSBT and ECDSA-verifies every fresh signature against the picked cosigner's pubkey. On a mismatch — the typical case when one Trezor hosts the whole `m`-of-`n` set behind separate passphrase wallets and the active passphrase is a *different* vault cosigner than the one the operator clicked — the adapter sweeps every cosigner pubkey on the input and re-attributes the signature to the slot it mathematically belongs to (`pivoted: true` on the result). When no cosigner matches at all the signature is refused, so a broken partial sig never reaches the proposal store.
6. Stitches the (possibly re-attributed) signatures back into the PSBT through `addPartialSignaturesToPsbt`, appending the SIGHASH_ALL byte (0x01) so the result round-trips through every standard finaliser.

The wallet then writes the updated PSBT back to `V1_VaultProposals` via `patchProposal`. Subsequent cosigners pick up where the previous one left off — the partial sigs already in the PSBT are echoed back into Trezor's `multisig.signatures` slot so the device refuses to produce a duplicate.

### Why no pre-flight identity check?

An earlier draft of this adapter called `getPublicKey({ showOnTrezor: false })` at the start of every signing session to fetch the connected device's master fingerprint and detect the cross-passphrase case before going anywhere near the device's signing prompt. It worked, but Trezor Suite still surfaces an "Export accounts" confirmation for that call (the device does not consider an xpub disclosure consentless), so the operator faced **two** on-device prompts per signature — first the xpub export, then the actual transaction confirmation.

The post-flight verification offers the same safety guarantee with **one** prompt:

- **Wrong device entirely.** Trezor itself refuses to sign a P2WSH multisig input with a key that is not in the supplied multisig pubkey set. The signing call errors out before producing a signature.
- **Wrong passphrase wallet but still a vault cosigner.** Trezor signs with the active passphrase's key (which IS in the multisig set, just a different cosigner than the operator clicked). The post-flight verifier moves the signature to the correct slot.
- **Wallet stale / desync future bug.** Whatever produced the signature, if it doesn't ECDSA-verify against any vault cosigner pubkey on this input, the adapter refuses it.

Trade-off accepted: in the "wrong device, no vault cosigner active" case the operator sits through Trezor's transaction-review screen before getting an error, instead of an early refusal. That is rare in practice and the UX win on the common path is worth it.

## Roadmap

- ✅ `init.ts` — Trezor Connect bootstrap (idempotent, lazy iframe load).
- ✅ `xpub.ts` — descriptor-shaped xpub export per derivation path with master fingerprint normalisation.
- ✅ `errors.ts` — Asylia-friendly normalised errors so the UI never sees raw Trezor codes.
- ✅ `sign.ts` — PSBT v2 → Trezor `signTransaction` translation for `wsh(sortedmulti(...))` spends, partial-sig merge back into the PSBT.

## Versioning + audit stance

See [`SECURITY.md`](./SECURITY.md). The package is `0.1.0-dev` until it ships its first audited stable API.

## License

MIT — see [`LICENSE`](./LICENSE).
