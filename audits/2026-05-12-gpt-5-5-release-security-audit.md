# Public Security Audit Report: release/test

**Date:** 2026-05-12
**Audit ID:** gpt-5-5-release-security-audit-2026-05-12
**Model:** GPT-5.5
**Status:** Passed with notes

## Summary
This is a public-safe security audit record for the Asylia `release/test` branch. The audit reviewed wallet-centric access sessions, hardware signer authentication, PSBT policy enforcement, atomic vault creation and signer attach RPCs, proposal transaction lifecycle hardening, Supabase RLS/RPC boundaries, release gates, and audit publication wiring.

No critical, high, or medium-severity security vulnerabilities were identified. The release is safe to proceed with notes.

## Scope
The scope of this audit includes:
- Wallet access sessions and signer authentication.
- PSBT spending policy validation and proposal lifecycle enforcement.
- Ledger and Trezor hardware signer authentication and signing adapters.
- Supabase RLS, service-role-only RPCs, and branch database security tests.
- CI/release gates, production configuration checks, and public audit publication artifacts.

## Findings
- **Critical:** 0
- **High:** 0
- **Medium:** 0
- **Low:** 1 (Expanded service-role Edge Function boundary, mitigated by authentication, session, challenge, vault-access, PSBT-policy, and RPC-grant checks)
- **Info:** 4 (Atomic vault RPCs, PSBT policy validation, auth-only signer onboarding, and release gate hardening)

There are no unresolved critical/high or blocking findings.

## Accepted Risk
- **Service-role Edge boundary:** Some wallet operations require service-role Edge Functions because browser clients must not directly perform signer session creation or proposal state writes. This is accepted because the reviewed implementation keeps those RPCs service-role-only and validates caller identity, auth session, challenge ownership, challenge expiry, signer proof, vault access, and PSBT policy before writing.

## Conclusion
The release candidate passes the security audit with notes.
