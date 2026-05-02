# Release Security Audit: Release Checks And Vercel Build Hotfix

Audit ID: `release-checks-vercel-hotfix-2026-05-02`

Date: 2026-05-02

Target: `main`

Status: passed with notes

## Public Summary

Asylia stabilized the production release checks and Vercel deployment path after
the release flow reached `main`.

This report covers release operations and deployment controls only. It does not
disclose secrets, private user data, descriptors, xpub sets, PSBTs, UTXO data, or
exploit instructions.

## Reviewed Scope

- Public `Asylia/bitcoin-toolkit` sync token permissions and workflow
  preservation.
- Wallet production gate handling for live authenticated browser flows.
- Vercel workspace dependency build ordering for wallet and design-system apps.
- Local helper scripts used only during Vercel build orchestration.

## Model Review

| Provider | Family | Model/version | Role | Status |
| --- | --- | --- | --- | --- |
| OpenAI | GPT | GPT-5.5 | Hotfix security and release-control review | Completed |

## Findings Summary

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Info | 1 |

The informational note is operational: live authenticated E2E remains valuable
but depends on external OTP/email delivery, so it is now opt-in outside manual
runs. Public repo workflows are preserved and managed directly in the public
repo so the sync App keeps a narrower permission set.

## Residual Risk

Authenticated browser flows should be run manually or by enabling the repository
variable when auth delivery itself is under review.
