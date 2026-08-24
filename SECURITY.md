# Security policy

## Supported versions

Security fixes are provided for the latest published DevProof release. Operators should also keep Browser Runtime on a release compatible with the protocol capabilities required by their deployment.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Use the repository's **Security → Report a vulnerability** form to submit a private GitHub Security Advisory. Include the affected version, configuration, reproduction steps, impact, and any suggested mitigation. Remove production secrets, cookies, personal data, and proprietary page content from the report.

Maintainers will acknowledge a complete report, validate it, coordinate remediation and disclosure, and credit the reporter unless anonymity is requested. If private vulnerability reporting is not enabled, contact the repository owner privately and ask for a secure reporting channel before sharing details.

## Scope

Reports are especially useful when they affect authentication or Team isolation, machine credentials, pairing and lease tokens, Runtime protocol fencing, SSRF controls, Browser Profile isolation, human-handoff authorization, evidence access, secret redaction, or object retention.

Automated scanning is welcome against your own deployment or a local development environment. Do not test against infrastructure you do not own or disrupt shared services.
