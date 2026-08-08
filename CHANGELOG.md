# Changelog

## [Unreleased]

- Recover stale private web-search output directories, which a nested temporary-directory prefix had excluded from the recovery pass.
- Allow `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` to override the five-second tool-catalog readiness timeout.
- Support Claude Opus 5 through Claude Code's `opus` alias while retaining the safe 200K Pro context limit.
- Report a validated Claude initialization to Pi's `after_provider_response` observers before publishing any content.
- Report streaming partial messages with Pi's `pending` stop reason instead of a premature `stop`.
- Document that `pi auth check` cannot see extension-registered providers.
- Verify against Pi 0.84.1 and Claude Code 2.1.226.
- Exclude Fable 5 from the paid validation gate because it is not served through subscription plans, and document that the `fable` alias is offered untested.

## [0.1.0] - 2026-07-19

Initial public release.
