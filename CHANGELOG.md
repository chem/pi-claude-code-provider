# Changelog

## [Unreleased]

### Removed

- **Breaking.** Removed the `default` model alias. It sent no `--model` flag, so the served model was chosen by Claude Code account state that varies between accounts — observed as Sonnet on one and Opus on another — and never reflected the model selected in the user's own Claude Code settings, which this provider does not load. Pi reports an unknown model for a saved `pi --model pi-claude-code-provider/default` or profile entry.

### Added

- `/pi-claude-code-provider-doctor` and the diagnostic report name the model each alias resolves to, without consuming subscription quota. Values that cannot be read report `unavailable` and never affect model selection.
- Minimum supported Pi and Claude Code versions in `README.md`, reported by the doctor. They are advisory; an older installation still runs.
- `PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM` suppresses one named platform's startup advisory without changing its verification status ([#3](https://github.com/chem/pi-claude-code-provider/pull/3)).
- `npm run capture:claude-surface`, which captures `claude --help` verbatim for the capability tests.

### Changed

- Apple Silicon macOS is recognized as verified, with community-reported live coverage recorded in `DEVELOPING.md` ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)).
- The paid model matrix asserts model families instead of dated model ids, so upstream model refreshes no longer fail it. `test:paid:matrix` drops from 20 launches to 15 and `test:paid:release` from 57 to 52.
- `DESIGN.md` records what Claude Code adds to the model's view that this package cannot remove, the effect of dropping the user's Claude Code setting sources, and why the prompt-cache setting is pinned.

### Fixed

- Preflight no longer decides whether the provider can run by scraping `claude --help` for `--system-prompt-file`, which is documented but absent from the help screen. A minimum supported version covers it instead.
- npm Pi installations whose CLI lives in `dist/bundle/cli.js` resolve by locating the owning package rather than assuming its depth ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)).
- Paid validation is isolated from personal Pi settings, extensions, skills, and context files without moving user files ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)).

## [0.1.4] - 2026-08-23

### Fixed

- Restore prompt-cache reuse broken by Claude Code 2.1.233's undocumented, changing token reminder. The provider now applies the maintainer-recommended `totalTokensReminder: "off"` setting; the cache gate verifies reuse across fresh processes.
- Honor Pi's per-request output limit, including compact 2,048-token branch-summary requests, while clamping it to the model maximum and reserving the same amount in context checks.
- Fail clearly on sanitized MCP initialization errors, malformed provider-hook payloads, near-match CLI options, oversized in-flight bridge requests, and process-tree termination failures. Cleanup errors now preserve the original failure, settle promptly, and retain the owned marker when process liveness is unknown.

### Changed

- Simplify transport guidance and child configuration, report bridge launches as structured argument vectors, and share Claude protocol/runtime helpers across provider, search, diagnostics, and tests.
- Update the verified baseline to Pi 0.84.2 and Claude Code 2.1.241.

## [0.1.3] - 2026-08-20

### Fixed

- Launch the proposal bridge through Pi's actual host runtime. Standalone Pi builds now use their embedded Bun runtime with a neutral pinned `bunfig.toml`, fixing tool proposals and preventing working-directory preload configuration.

### Added

- Add a real bridge handshake to the doctor and diagnostic report.
- Add npm and standalone bridge live gates, selectable with `PI_CLAUDE_CODE_PROVIDER_PI_BIN`.

### Changed

- Include dates in rate-limit reset notices.
- Add resolved bridge and bounded stderr context to MCP startup failures.
- Diagnose standalone Pi as a supported runtime but unsupported development host.
- Verify Pi 0.84.2, Claude Code 2.1.237, and standalone Pi on Linux x64.

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
