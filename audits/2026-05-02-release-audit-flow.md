# Release Security Audit: Release, Deploy, And Audit Flow

Audit ID: `release-audit-flow-2026-05-02`

Date: 2026-05-02

Target: `main`

Status: passed with notes

## Public Summary

Asylia introduced a production release flow that requires green CI and a
public-safe release security audit record before code reaches `main`.

This report covers release process controls only. It does not disclose secrets,
private user data, descriptors, xpub sets, PSBTs, UTXO data, or exploit
instructions.

## Reviewed Scope

- GitHub Actions production gates.
- `release/test` branch mapping.
- Release audit manifest schema.
- Marketing security audit publication path.
- Public `Asylia/bitcoin-toolkit` audit export path.

## Model Review

| Provider | Family | Model/version | Role | Status |
| --- | --- | --- | --- | --- |
| OpenAI | GPT | GPT-5.5 | Implementation and process review | Completed |

## Findings Summary

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Info | 1 |

The informational note is operational: remote GitHub branch protection and
Vercel project settings must be verified after the branch is pushed because
those controls live outside repository files.

## Residual Risk

Local Git hooks are advisory and can be bypassed. The hard production control is
GitHub branch protection plus required CI checks.
