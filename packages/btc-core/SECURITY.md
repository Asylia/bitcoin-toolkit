# Security policy — `@asylia/btc-core`

## Reporting a vulnerability

If you believe you have found a security vulnerability in this package,
**please do not open a public GitHub issue**. Instead, email
`security@asylia.io` with:

- a description of the issue and the affected version,
- a reproduction (proof-of-concept, failing test, or annotated transcript),
- the impact you believe the issue has on Asylia users.

We will acknowledge receipt within **3 business days** and aim to provide a
remediation plan within **14 days** for high-severity issues.

## Scope

This package handles:

- Bitcoin descriptor construction
- BIP32 derivation
- address generation for Asylia script policies
- PSBT construction, review, and finalisation

A vulnerability in any of the above is in scope. Issues in the wallet UI,
the marketing site, or the dev hub belong to those workspaces and are
**not** covered by this policy.

## Out of scope

- Issues caused by a malicious dependency we do not control (please report
  to that dependency's maintainers — we will pin/replace as needed).
- Theoretical attacks that require physical possession of the device or
  pre-compromise of the operating system.
- Features marked `experimental` in the source until they reach `stable`.

## Disclosure

Once a fix is shipped:

- the vulnerability is described in `CHANGELOG.md` with a CVE if assigned,
- the audited release is tagged in git,
- credit is offered to the reporter unless they request otherwise.
