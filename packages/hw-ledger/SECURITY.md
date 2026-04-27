# Security policy — `@asylia/hw-ledger`

## Reporting a vulnerability

Email `security@asylia.io` with a description, reproduction, and impact
assessment. Please **do not open a public GitHub issue** for security
reports. Acknowledgement within 3 business days; remediation plan within
14 days for high-severity issues.

## Scope

- WebHID / WebUSB transport selection
- xpub export and fingerprint handling
- Wallet policy registration (Bitcoin app v2+)
- PSBT signing flow
- Error normalisation that surfaces in the wallet UI

## Out of scope

- Vulnerabilities in upstream LedgerHQ packages (`@ledgerhq/hw-app-btc`,
  `@ledgerhq/hw-transport-webhid`, etc.) — please report to those projects'
  maintainers; we will pin or patch as needed.
- Issues caused by tampered firmware on the device itself.
- The wallet UI rendering of signing prompts (covered by the wallet
  workspace's own review process).

## Disclosure

Once a fix is shipped, the issue is described in `CHANGELOG.md` with a CVE
if one is assigned, the audited release is tagged in git, and credit is
offered to the reporter unless they request otherwise.
