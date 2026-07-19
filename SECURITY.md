# Security policy

## Supported versions

Security fixes are provided for the latest released version and the current `main` branch.

## Reporting a vulnerability

Do not open a public issue. Report suspected vulnerabilities to [sineverbisnon@gmail.com](mailto:sineverbisnon@gmail.com) or through GitHub private vulnerability reporting.

Include the affected version or commit, impact, minimal reproduction, platform and relevant Pi/Claude versions, and whether credentials, prompts, private files, or subscription usage may be exposed.

Do not send credentials, Claude session files, raw private prompts, or unrelated personal data. Use synthetic fixtures whenever possible.

Reports will be validated privately and disclosure coordinated after a fix is available. No fixed response-time or bounty commitment is offered.

## Scope

In scope are unintended credential or prompt disclosure, bypass of the Claude capability boundary, invisible tool execution, unsafe private-path exposure, incomplete process or private-state cleanup, and diagnostic leakage.

Expected Pi package privileges, ordinary prompt-injection risk, upstream Claude or Pi behavior without a package boundary violation, and denial of service from trusted local executables are generally out of scope. See [DESIGN.md](DESIGN.md#security-and-privacy) for the maintained security model.
