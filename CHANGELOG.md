# Changelog

## [Unreleased]

### Fixed

- Launch the tool-proposal MCP bridge under the runtime hosting Pi instead of assuming `process.execPath` is Node. On Pi's standalone tar.gz build that path is a compiled Bun binary, which ignored the bridge argument and started its own entry point, so the bridge never became ready and no tool proposal ever reached Pi. The bridge is now launched with `BUN_BE_BUN=1` on that build, which needs no separate Node installation. This applies to every standalone target Pi publishes: macOS arm64/x64, Linux x64/arm64, and Windows x64/arm64.
- Pin the bridge to a neutral `bunfig.toml` under a standalone Pi. Pi compiles its binaries with `--no-compile-autoload-bunfig`, but that is a property of Pi's own entry point and does not survive `BUN_BE_BUN`, so a `bunfig.toml` in the bridge's working directory could otherwise preload code into it.

### Added

- `/pi-claude-code-provider-doctor` now completes a real `initialize` plus `tools/list` handshake against the bridge and reports the resolved runtime and launch command. Version and path checks alone pass on an install whose bridge can never start.
- Record the host runtime and bridge handshake result in the diagnostic report.
- Add `npm run test:paid:bridge` and `npm run test:paid:bridge-standalone`, one tool-bearing live turn per Pi distribution, both included in `test:paid:release`. `PI_CLAUDE_CODE_PROVIDER_PI_BIN` selects the Pi executable the live scripts launch.

### Changed

- Include the date in rate-limit reset times. A `seven_day` window can reset almost a week out, so reporting only a wall-clock time read as "today" and understated the wait by days.
- Name the resolved bridge command and carry Claude Code's stderr in the MCP readiness failures, which previously pointed only at `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` and so sent people to the wrong knob. In print mode Claude reports a failed MCP server only after the prompt is written, which this wait precedes, so its stderr is the sole first-hand evidence available at timeout.
- `npm run check` now reports by name when the `pi` on `PATH` is the compiled standalone build, which resolves no packages and cannot host development.

## [0.1.2] - 2026-08-09

### Fixed

- Report a rate limit only when one constrains the request. A rejected overage no longer overrides a healthy plan window, so a subscription with usage credits disabled at the account level no longer warns on every request, and the reported window name and utilization are preserved.
- Report each distinct rate-limit notice once per session rather than once per Claude process, which this transport starts for every tool round-trip.

## [0.1.1] - 2026-08-08

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
