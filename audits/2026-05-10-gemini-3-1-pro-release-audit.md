# Public Security Audit Report: release/test

**Date:** 2026-05-10
**Audit ID:** gemini-3-1-pro-release-audit-2026-05-10
**Model:** Gemini 3.1 Pro
**Status:** Passed

## Summary
This is a public-safe security audit record for the Asylia `release/test` branch. The audit reviewed changes related to wallet-centric access profiles, PSBT spending policy validation, Ledger hardware signer authentication, and proposal transaction state enforcement in Supabase.

No critical or high-severity security vulnerabilities were identified. The release is safe to proceed.

## Scope
The scope of this audit includes:
- Wallet-centric access profiles and billing
- PSBT spending policy validation helpers
- Ledger hardware signer authentication
- Proposal transaction state enforcement in Supabase

## Findings
- **Critical:** 0
- **High:** 0
- **Medium:** 0
- **Low:** 1 (Client-side platform fee derivations validated server-side)
- **Info:** 2 (Memory safety updates, Auth challenge signing feature)

There are no unresolved critical/high or blocking findings.

## Accepted Risk
- **Platform Fee Calculations:** Platform fee calculations are performed client-side and verified via PSBT policies. This is an accepted pattern provided the signing device and server-side RPCs validate the final PSBT constraints.

## Conclusion
The release candidate passes the security audit.
