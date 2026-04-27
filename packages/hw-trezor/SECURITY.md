# Security policy — `@asylia/hw-trezor`

## Reporting a vulnerability

Email `security@asylia.io` with a description, reproduction, and impact
assessment. Please **do not open a public GitHub issue** for security
reports. Acknowledgement within 3 business days; remediation plan within
14 days for high-severity issues.

## Scope

- Trezor Connect bootstrap and teardown
- xpub export and fingerprint handling
- PSBT signing flow (PSBT-in → PSBT-out mapping, device prompt fidelity)
- Error normalisation that surfaces in the wallet UI

## Out of scope

- Vulnerabilities in the upstream `@trezor/connect-web` SDK — please report
  to that project's maintainers; we will pin or patch as needed.
- Issues caused by a tampered firmware on the device itself.
- The wallet UI rendering of signing prompts (covered by the wallet
  workspace's own review process).

## Disclosure

Once a fix is shipped, the issue is described in `CHANGELOG.md` with a CVE
if one is assigned, the audited release is tagged in git, and credit is
offered to the reporter unless they request otherwise.
