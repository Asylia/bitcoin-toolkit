# Independent Second-Model Audit: Wallet Spend, Proposal, And Hardware-Wallet Hardening

Audit ID: `claude-opus-4-7-security-audit-2026-05-04`

Date: 2026-05-04

Target: `main`

Source branch: `release/test`

Commit range: `main...release/test`

Status: passed with notes

## Summary

This audit is an independent second-model security review of the same
`release/test` candidate that the Gemini 3.1 Pro audit covered earlier the
same day (`security-audit-2026-05-04`). It is intentionally redundant with
that pass: a release candidate that hardens the wallet spend pipeline,
proposal lifecycle, hardware-wallet logging, Edge Function auth comparison,
CSP, and coin-selection fee math is exactly the kind of change set where
multi-model concurrence is worth recording.

Claude Opus 4.7 re-read the security-relevant diff (`git diff
main...release/test`) end to end with focus on:

- the new `create_vault_spend_proposal` /
  `set_vault_proposal_psbt` / `mark_vault_proposal_broadcasted`
  `SECURITY DEFINER` RPC trio and the matching
  `v1_vault_proposals_enforce_insert_path` and
  `v1_vault_proposals_enforce_lifecycle` triggers,
- the `proposal-psbt` Edge Function content validator (input multiset
  match against `V1_VaultProposalInputs` locks, output multiset match
  against the stored recipient + change + platform-fee summary, fee
  recompute, BIP-32-derivation-anchored signature counting, end-to-end
  finalisation when threshold is met),
- the `btc-broadcast` Edge Function stored-PSBT binding (re-finalises
  `psbt_base64`, requires the supplied `rawTxHex` and `expectedTxid` to
  match byte-for-byte, validates `alreadyBroadcastedBy.txid` against the
  same canonical txid, rate-limits server-side broadcasts via
  `consume_btc_broadcast_quota`, marks broadcast only through the
  service-role RPC),
- the shared-secret comparison helpers (`requireBearerSecret`,
  `requireBearerOrHeaderSecret`) on the constant-time path,
- the wallet CSP on `apps/wallet/public/_headers` and
  `deploy/vercel/wallet.json` (the broad `https://*.asylia.io`
  `connect-src` source is removed; `_headers` and `wallet.json` are kept
  in sync by the `verify:production-config` gate),
- the `@asylia/hw-trezor` adapter (safe-key allowlist redaction in
  `log.ts`, build-flag-gated `unsafeDiagnostic` path with a `tsup` build
  that hard-disables the flag in production-like builds, ECDSA
  post-flight signature verification with a sweep-and-pivot fallback and
  hard refusal when no cosigner pubkey verifies),
- coin-selection vbyte parameters in `@asylia/btc-core` and the wallet
  `spendPlanner` (`DEFAULT_FIXED_VBYTES = 85`, `DEFAULT_PER_INPUT_VBYTES
  = 110`, `DEFAULT_CHANGE_OUTPUT_VBYTES = 43`, all paths round fees up
  via `Math.ceil`),
- IPv6 session IP masking on `apps/wallet/src/services/sessions.ts`
  (compressed `::` addresses keep at most two leading segments),
- the post-deploy synthetic smoke workflow
  (`.github/workflows/post-deploy-smoke.yml`,
  `apps/wallet/e2e/post-deploy-smoke.spec.ts`,
  `apps/wallet/playwright.post-deploy.config.ts`),
- the wallet production-gates workflow guard and `verify-release-audit`
  enforcement of the model-slug-in-filename convention.

The conclusion concurs with the parent audit: zero critical, high,
medium, or low findings, two info-level notes, no release blocker. This
report adds one further informational observation about the row-level
update policy on `V1_VaultProposals` that does not affect funds safety
but is worth recording for future migrations.

This release does not change BIP-48 derivation roots, the descriptor
format (`wsh(sortedmulti(...))`), the BIP-67 ordering rules, the network
constant (`mainnet` only), or the threat model around seed phrases,
hardware-wallet secrets, service-role keys, or private operational
tokens.

## Release Target And Commit Range

- Target branch: `main`
- Source branch: `release/test`
- Commit range: `main...release/test`
- Notable commits reviewed (same set as the parent audit):
  - `180f2fca9` `fix(supabase): harden proposal validation and insert controls`
  - `09f7f0acc` `fix(hw-trezor): keep signing diagnostics redacted by default`
  - `8e948360f` `fix(btc-core): align P2WSH fee estimates with wallet spends`
  - `62d057806` `fix(wallet): harden session IP masking`
  - `f55e4b57e` `chore(deploy): tighten wallet CSP on Vercel`
  - `06e176fbb` `test(logger): add tests to ensure sensitive fingerprint values are redacted`
  - `73668b7e0` `test(supabase): cover edge function handlers`
  - `6f21c193b` `ci(wallet): add post-deploy smoke workflow`
  - `40b3b31b6` `ci(wallet): require UI coverage in production gates`
  - `5d50c4b5b` `docs(audit): add security audit report for May 4, 2026 by Gemini 3.1 Pro`

## Scope

- Supabase migrations:
  - `20260429202000_wallet_spend_locks.sql`
  - `20260430130000_vault_proposals_scope_hardening.sql`
  - `20260502195000_btc_broadcast_stored_psbt_binding.sql`
  - `20260502201000_proposal_broadcast_rpc_cache_and_trigger.sql`
  - `20260503083000_server_validated_proposal_psbt_updates.sql`
  - `20260503174813_restrict_direct_vault_proposal_inserts.sql`
- Supabase Edge Functions: `proposal-psbt`, `btc-broadcast`,
  `csp-report`, `ops-health`, `ops-monitoring-synthetic`,
  `btc-network-fees`, `btc-fiat-rates`, `btc-chain-fallback`,
  `_shared/auth.ts`.
- Wallet SPA:
  - `apps/wallet/src/services/sessions.ts`
  - `apps/wallet/src/services/proposals.ts`
  - `apps/wallet/src/services/spendPlanner.ts`
  - `apps/wallet/src/services/logger.ts`
- Bitcoin core:
  - `packages/btc-core/src/psbt/build.ts`
  - `packages/btc-core/src/psbt/coin-select.ts`
- Hardware-wallet adapter:
  - `packages/hw-trezor/src/log.ts`
  - `packages/hw-trezor/src/sign.ts`
  - `packages/hw-trezor/src/init.ts`
  - `packages/hw-trezor/tsup.config.ts` and `src/build-flags.d.ts`
- Deploy / CSP:
  - `apps/wallet/public/_headers`
  - `deploy/vercel/wallet.json`
- CI / release controls:
  - `.github/workflows/post-deploy-smoke.yml`
  - `.github/workflows/wallet-production-gates.yml`
  - `apps/wallet/e2e/post-deploy-smoke.spec.ts`
  - `apps/wallet/playwright.post-deploy.config.ts`
  - `tools/verify-supabase-security.mjs`
  - `tools/verify-production-config.mjs`
  - `tools/verify-release-audit.mjs`

## Threat Model

The audit considered the same attacker classes as the parent audit:

- direct PostgREST writes that forge proposal rows, lifecycle status, or
  broadcast metadata,
- a malicious or compromised SPA submitting a PSBT whose
  inputs/outputs/fee do not match the stored proposal summary or the
  active input locks,
- a SPA-supplied `alreadyBroadcastedBy` report that lies about the
  network txid in order to bind the wrong txid to a real proposal,
- timing side channels on shared-secret bearer auth (`OPS_HEALTH_TOKEN`
  and the public ops-monitoring header),
- hardware-wallet device interaction leaking xpubs, fingerprints,
  descriptors, or full PSBTs to the browser console or operational logs,
- a Trezor signing path that produces a partial signature that does not
  verify against any cosigner pubkey on the input,
- coin-selection fee math that underestimates the on-chain footprint and
  produces a transaction below the network minimum relay fee,
- session listing leaking full IP addresses to the SPA UI,
- CSP weakening that allows arbitrary `*.asylia.io` first-party connect
  targets,
- broken release-audit gating that allows an unreviewed change to reach
  `main`.

## Model Review

| Provider | Family | Model/version | Role | Status |
| --- | --- | --- | --- | --- |
| Anthropic | Claude | Claude Opus 4.7 (claude-opus-4-7) | Independent second-model security audit (code review, RLS review, CSP review, Edge Function review, hardware-wallet adapter review, fee/coin-selection review, CI/release controls review) | Completed |
| Google | Gemini | Gemini 3.1 Pro (google-geminy-3-1-pro) | Primary security-first release audit (recorded separately as `security-audit-2026-05-04`) | Referenced |

Claude Opus 4.7 ran:

- a manual diff read of the full `git diff main...release/test`
  (105 files, ~7 500 insertions, ~500 deletions),
- direct execution of the static gates `verify:supabase-security`,
  `verify:production-config`, `verify:wallet-production-gates`, and
  `verify:release-audit`,
- inspection of the Supabase migration semantics, with attention to the
  ordering of the `v1_vault_proposals_enforce_lifecycle` trigger across
  `20260502201000_proposal_broadcast_rpc_cache_and_trigger.sql` and
  `20260503083000_server_validated_proposal_psbt_updates.sql` (the later
  migration replaces the function with a strict superset of the
  previously enforced rules; no lifecycle invariant is dropped),
- inspection of the transaction-local config flag pattern
  (`asylia.allow_vault_proposal_insert`,
  `asylia.allow_proposal_psbt_update`,
  `asylia.allow_proposal_ready_update`,
  `asylia.allow_broadcast_proposal_update`) — every flag is set with
  `set_config(..., true)` and the trigger reads with
  `current_setting(name, true)` (`missing_ok = true`).

## Findings

| Severity | Count | Notes |
| --- | ---: | --- |
| Critical | 0 | No funds-moving, key-handling, RLS, descriptor, PSBT-builder, or transaction-broadcast invariant is weakened by this change set. |
| High | 0 | No production secret, RLS boundary, or hardware-wallet trust path is exposed; service-role privilege remains scoped to narrow `SECURITY DEFINER` functions. |
| Medium | 0 | No mandatory production gate is removed; new lifecycle and content-binding checks add belt-and-braces over RLS. |
| Low | 0 | Coin-selection vbyte parameters now match Asylia's native-SegWit P2WSH multisig footprint; fee estimates round upward rather than underpaying network minimum. |
| Info | 3 | See below. |

### Info-1: Service-role broadcast and PSBT-update RPCs rely on transaction-local config flags (concurs with parent audit)

- **Affected surface:** `mark_vault_proposal_broadcasted(...)`,
  `set_vault_proposal_psbt(...)`, `create_vault_spend_proposal(...)`.
- **Observation:** the `v1_vault_proposals_enforce_lifecycle` and
  `v1_vault_proposals_enforce_insert_path` triggers honour
  `current_setting('asylia.allow_*_update', true)` flags set with
  `set_config(..., true)` (transaction-local). The `is_local = true`
  third argument keeps the bypass scoped to the active transaction, so a
  leaked flag cannot persist across sessions or pollute connection-pooled
  clients. The bypass remains a service-role-only path; the
  `verify-supabase-security` gate enforces the
  `revoke ... from public, anon, authenticated; grant execute ... to
  service_role` pattern on every `SECURITY DEFINER` function added after
  the baseline timestamp.
- **Impact:** None on its own. Recorded so future migrations that add
  another lifecycle-altering RPC keep the same `is_local = true`
  discipline.
- **Remediation:** No action required.

### Info-2: Wallet logger covers the dominant sensitive surfaces but is not exhaustive (concurs with parent audit)

- **Affected surface:** `apps/wallet/src/services/logger.ts`.
- **Observation:** the redaction key pattern covers
  `psbt|xpub|zpub|ypub|descriptor|previousTxHex|rawTxHex|policyHmac|witnessScript|scriptPubKey|privateKey|seed|mnemonic`,
  the address/fingerprint/utxo families are shortened, and
  `Uint8Array`, `ArrayBuffer`, and unknown shapes are reduced to
  redaction placeholders. Adjacent identifiers like `redeemScript`,
  `derivationPath`, `nodeXpub`, or `signature` are not in the explicit
  pattern. In practice, the active call sites either route those values
  through one of the listed keys (PSBT/xpub/witnessScript) or through
  the `hw-trezor` adapter's stricter `summariseSensitiveObject` path.
- **Impact:** None observed.
- **Remediation:** consider extending `SENSITIVE_KEY_PATTERN` in the
  wallet logger to additionally cover `redeemScript`, `derivationPath`,
  `signature`, and `nodeXpub` for defence-in-depth. Opportunistic
  improvement, not a release blocker.

### Info-3: `V1_VaultProposals` UPDATE policy is row-scoped, not column-scoped

- **Affected surface:**
  `supabase/migrations/20260419140000_vault_proposals.sql` policy
  `v1_vault_proposals_update_own`.
- **Observation:** the existing UPDATE policy on `V1_VaultProposals`
  scopes by `user_id = auth.uid()` and the corresponding `V1_Vaults`
  ownership check, but it is not column-restricted. An authenticated
  user could therefore write a syntactically valid hex string into
  `broadcasted_tx_id` and a timestamp into `broadcasted_at` on their own
  not-yet-broadcasted row without invoking the canonical broadcast
  path. Attempting to actually transition `status` to `broadcasted`
  still fails because the lifecycle trigger requires the
  `asylia.allow_broadcast_proposal_update` flag, which is only set
  inside the service-role-only `mark_vault_proposal_broadcasted(...)`
  function. The trigger also re-validates txid format and timestamp
  presence on the broadcasted-status transition itself, and the
  service-role RPC always re-writes both fields with its own validated
  parameters under `lower(p_txid)`. The `v1_vault_proposals_enforce_lifecycle`
  trigger additionally freezes both fields once `status = 'broadcasted'`.
- **Impact:** None on funds safety. A user could only stamp cosmetic
  values on their own draft/awaiting/ready row; the row remains
  pre-broadcast, the SPA's broadcast UI does not key off these fields
  before the lifecycle trigger has approved the transition, and any
  later legitimate broadcast overwrites them through the service-role
  RPC.
- **Remediation:** future hardening could either (a) add a column-level
  `revoke update (broadcasted_tx_id, broadcasted_at) ... from
  authenticated; grant update (broadcasted_tx_id, broadcasted_at) ...
  to service_role` pair, or (b) extend
  `v1_vault_proposals_enforce_lifecycle` to require that
  `broadcasted_tx_id` and `broadcasted_at` only change when status is
  transitioning to `'broadcasted'` (i.e. forbid setting them on
  draft/awaiting/ready rows). Either option is a hygiene improvement;
  not a release blocker.

## Fixes And Accepted Risk

The fixes recorded in `security-audit-2026-05-04` are confirmed by this
second-model pass:

- Direct browser inserts on `V1_VaultProposals` are revoked; creation
  runs exclusively through `create_vault_spend_proposal()` with atomic
  active input locks and parent-vault ownership re-check.
- Browser clients can no longer set `psbt_base64`, `ready_to_broadcast`,
  or `broadcasted` directly. The `proposal-psbt` Edge Function re-parses
  every PSBT, matches inputs against `V1_VaultProposalInputs` locks,
  validates the output multiset (recipient + change + platform fee),
  recomputes the fee, and derives whether the vault threshold is met
  before calling the service-role `set_vault_proposal_psbt(...)` RPC.
  Threshold-met PSBTs additionally finalise end-to-end in the Edge
  layer to confirm the partial signature set is internally consistent.
- The `btc-broadcast` Edge Function:
  - validates that `expectedTxid` is canonical hex and matches
    `Transaction.fromHex(rawTxHex).getId()`,
  - re-finalises the stored `psbt_base64` and requires the produced hex
    and txid to match the supplied payload byte-for-byte,
  - validates and matches an `alreadyBroadcastedBy.txid` claim against
    the same canonical txid before any DB write,
  - rate-limits server-side broadcasts via
    `consume_btc_broadcast_quota`,
  - records broadcast metadata only through the service-role
    `mark_vault_proposal_broadcasted(...)` RPC, which re-checks vault
    ownership, txid format, and lifecycle status independently of the
    Edge layer.
- Hardware-wallet logging:
  - sensitive object fields (manifest, response, payload, raw, txid,
    address, descriptor, xpub*, policy, hmac, etc.) are reduced to a
    `{ redacted: true }` summary that exposes only stable enum-like
    fields (`code`, `phase`, `status`, `transportType`,
    `transportVersion`, `type`, `success`),
  - numbers, booleans, and bigints are kept only for an explicit
    safe-context key allowlist (`pathComponentCount`, `inputIndex`,
    `outputIndex`, `psbtLengthChars`, etc.),
  - the per-cosigner detail block (fingerprints, derivation paths, xpub
    previews) is moved behind `log.unsafeDiagnostic(...)` which is gated
    by the `__ASYLIA_HW_TREZOR_UNSAFE_DIAGNOSTICS__` build flag. The
    `tsup.config.ts` build sets this flag to `false` when
    `NODE_ENV === 'production'` or `VERCEL_ENV === 'production'`, so
    production bundles compile the diagnostic out entirely.
- The Trezor signing post-flight verifier remains in place: every fresh
  signature is ECDSA-verified against the requested cosigner's pubkey,
  with a full sweep of the input's BIP-32 derivation block on mismatch
  and a hard refusal when no cosigner pubkey verifies the signature.
- `requireBearerSecret` and `requireBearerOrHeaderSecret` compare auth
  values with a constant-time byte loop instead of `===`. The loop
  iterates over `expectedBytes.length`, folds the length difference
  into the running `difference` accumulator, and uses `?? 0` for any
  trailing positions in `actual`, so the elapsed time is bounded by the
  configured secret length and does not leak the supplied input length.
- The wallet CSP `connect-src` no longer includes the broad
  `https://*.asylia.io` source. The remaining list is enumerated
  providers (Supabase, mempool.space, blockstream, mempool.emzy.de,
  mempool.bisq.services, mempool.bitcoin-21.org, blockchain.info,
  BlockCypher, Coinbase, CoinGecko, Kraken, Better Stack, Trezor
  Connect, local Trezor Bridge ports). The `script-src` remains
  `'self'` only — no `'unsafe-inline'`, no `'unsafe-eval'`.
- The `_headers` file used by the wallet build is kept in sync with
  `deploy/vercel/wallet.json`; the `verify:production-config` gate
  fails the build if the two diverge, and the post-deploy smoke spec
  re-verifies them against the deployed origin.
- Coin-selection defaults are corrected from a P2WPKH-shaped 64/31
  vbyte pair to the actual P2WSH-multisig 85/43 footprint, and
  `SEND_FIXED_VBYTES` in the spend planner is aligned to 85. The
  dust-fold and no-change fallback branches both round fees upward via
  `Math.ceil`, so the fee figure presented to the operator is always at
  or above the network minimum the resulting transaction will require.
- `extractPsbtInputs` in `@asylia/btc-core` now throws on a malformed
  outpoint instead of silently skipping, so a corrupt PSBT cannot reach
  later layers with implicit input drops.
- `proposal-psbt` and `btc-broadcast` reject requests with
  `Content-Length > 2_000_000` before parsing the body, and
  `csp-report` keeps its `64_000` byte cap and
  `MAX_REPORTS_PER_REQUEST = 10` policy.
- The post-deploy synthetic smoke workflow runs against staging on
  every deployment and against production after `release/test`
  promotes; it asserts HTTP 200, the full set of expected security
  headers, the CSP directive shape, the status API JSON contract (no
  `service_role`, no PEM private keys, no Bearer tokens, no
  `postgres://` URLs), and ops-health authentication.

## Residual Risk

- Hardware-wallet handling outside Asylia's adapter (Trezor Suite,
  Trezor Connect popup, the Trezor Bridge processes on `127.0.0.1`) is
  not under Asylia's control. The CSP and Permissions-Policy retain
  only the necessary Trezor origins and the
  `usb=(self "https://connect.trezor.io")` allowance.
- The `set_vault_proposal_psbt` and `mark_vault_proposal_broadcasted`
  RPCs bypass the lifecycle and PSBT-immutability triggers when called
  by `service_role`. This is by design and is the intended trust
  boundary; a service-role key compromise remains catastrophic
  regardless of these RPCs and is mitigated by the broader Supabase
  secret-handling posture rather than in this audit's scope.
- The `V1_VaultProposals` UPDATE policy is row-scoped rather than
  column-scoped (Info-3 above). No funds-safety impact today; a future
  migration could tighten this to a column-restricted grant for extra
  defence-in-depth.
- Public chain-data providers can rate-limit in correlated ways. The
  `btc-broadcast` paid Blockstream fallback is gated by
  `consume_btc_broadcast_quota`, but availability of any one provider
  is not guaranteed; the wallet UI surfaces upstream errors and offers
  retry.

## Public Publication Notes

This report is public-safe. It contains release-control, RLS, Edge
Function, CSP, hardware-wallet adapter, and coin-selection details
only. It does not disclose secrets, private user data, descriptors from
real users, xpub sets, PSBT base64 from real users, UTXO arrays, OTP
mailbox credentials, the paid Blockstream client credentials, or the
operational ops-health bearer token.
