# Changelog

## [Unreleased]

### Added

- Add `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` to override the five-second MCP tool-catalog readiness timeout.

### Changed

- Verify the existing `opus` alias resolves to Claude Opus 5, retain its safe 200K Pro context limit, and update the verified baseline to Pi 0.84.1 and Claude Code 2.1.226.
- Improve provider and web-search rate-limit notifications with whole-percent utilization, reset times, and overage status.
- Align with Pi's provider lifecycle: stream partial responses as `pending` and invoke and await `after_provider_response` observers before publishing content.

### Fixed

- Improve web-search cancellation and cleanup: do not launch Claude for a pre-cancelled request, and recover stale private output left by abrupt exits.
- Tolerate newer Claude Code result, stop-reason, and advisory rate-limit envelopes while preserving useful error diagnostics.

## [0.1.0] - 2026-07-19

Initial public release.
