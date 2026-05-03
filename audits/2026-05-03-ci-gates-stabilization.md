# Release Security Audit: CI Gates Stabilization

Audit ID: `ci-gates-stabilization-2026-05-03`

Date: 2026-05-03

Target: `main`

Status: passed with notes

## Public Summary

Asylia stabilized the wallet production CI gates after the release/test
promotion reached `main`.

This report covers release operations and CI controls only. It does not disclose
secrets, private user data, descriptors, xpub sets, PSBTs, UTXO data, or exploit
instructions.

## Reviewed Scope

- Wallet production GitHub Actions flow for push and pull-request events.
- Release-audit target detection for branch push events.
- Live authenticated OTP E2E scheduling so PRs and manual runs keep auth
  coverage without racing duplicate push runs.
- Static wallet production workflow guard coverage for the OTP push-skip
  invariant.

## Model Review

| Provider | Family | Model/version | Role | Status |
| --- | --- | --- | --- | --- |
| OpenAI | GPT | GPT-5.5 | CI hotfix and release-control review | Completed |

## Findings Summary

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Info | 1 |

The informational note is operational: authenticated OTP E2E remains mandatory
for PRs into `main` and available through manual runs, while push executions skip
the live mailbox path to avoid OTP throttling.

## Residual Risk

The authenticated browser flow still depends on external mailbox delivery and
Supabase OTP rate limits. The release path keeps that coverage in the PR gate and
manual workflow runs while avoiding push-run mailbox collisions.
