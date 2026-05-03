# Release Security Audit: Release Test Security Audit

Audit ID: `release-test-security-audit-2026-05-02`

Date: 2026-05-02

Target: `main`

Status: passed

## Public Summary

Asylia reviewed the current `release/test` promotion candidate against the
standard security audit prompt. The branch diff is documentation-only and changes
README logo references from absolute GitHub raw URLs to repository-relative
paths.

The wider review also covered wallet, Bitcoin package, Supabase, Edge Function,
CI, deployment, and public export boundaries. No critical issue or direct
private-key/seed exposure path was found. Follow-up hardening now centralises the
BIP-48 account-root guard, removes vendor wallet material from hardware-wallet
console logs, and records broadcast state through the server-validated
`btc-broadcast` path.

This report does not disclose secrets, private user data, descriptors, xpub sets,
PSBTs, UTXO data, raw transactions, or exploit instructions.

## Reviewed Scope

- Current `release/test` diff against `main`.
- Bitcoin descriptor, PSBT, hardware-wallet, and chain-data packages.
- Wallet auth, vault, proposal, signing, broadcast, logging, and telemetry
  boundaries.
- Supabase migrations, RLS policies, Edge Functions, CORS, and operational
  logging helpers.
- GitHub Actions, release audit tooling, production config verification, Vercel
  build paths, and public OSS export controls.

## Model Review

| Provider | Family | Model/version | Role | Status |
| --- | --- | --- | --- | --- |
| OpenAI | GPT | GPT-5.5 | Parent audit synthesis and local verification | Completed |
| Cursor | Composer | Composer, exact internal model/version not exposed | Bitcoin package review | Completed |
| Cursor | Composer | Composer, exact internal model/version not exposed | Wallet app review | Completed |
| Cursor | Composer | Composer, exact internal model/version not exposed | Supabase boundary review | Completed |
| Cursor | Composer | Composer, exact internal model/version not exposed | Release gate and deployment review | Completed |

## Findings Summary

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 2 |
| Medium | 8 |
| Low | 10 |
| Info | 9 |

The high-severity notes were hardening items around strict derivation path policy
enforcement and sensitive wallet-material logging. They are remediated in the
follow-up branch before promotion.

## Remaining Risk

Remote branch protection, deployed environment variables, and production log
retention still require operator verification outside local static checks. The
local code and schema findings tracked in this audit are no longer carried as
accepted residual risk.
