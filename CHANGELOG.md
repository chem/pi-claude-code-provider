# Changelog

## [Unreleased]

### Fixed

- Tool and output-limit handoffs accept the provider's own POSIX termination signals after validation and cleanup, including SIGKILL escalation, instead of failing a completed response. Unexpected signal exits still fail.

## [0.4.0] - 2026-09-20

### Changed

- **Breaking.** Pi 0.86.1 is now the minimum supported version; upgrade Pi before this package. Older versions can still load, but are unsupported and flagged by the doctor. Pi 0.85.1 is no longer tested.
- Haiku no longer offers Pi effort levels or sends `--effort` to Claude Code. Claude Code may still use its default extended thinking even when Pi displays thinking as off.
- Claude Code 2.1.278 is now the validated baseline; the minimum supported version remains 2.1.270.
- Optional metrics log schema 5 counts image content blocks in `imageCount`, matching the 20-image limit rather than the number of stored files.

### Added

- `PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY=on` restores sole-session cwd borrowing for tool-bearing side requests without a recognized cwd. It is off by default because the borrowed directory may be wrong.
- The doctor now reports how the last request's directory was chosen, its prompt-cache reuse, and any mismatch between served and configured context windows.
- Maintainers can capture stream-recovery cases without quota using `npm run capture:claude-stream-recovery`; `test:paid:compat-npm` and `test:paid:compat-standalone` check both Pi distributions.

### Fixed

- Private runtime directory removal now retries brief filesystem conflicts before failing a completed request or leaving temporary state behind.
- Requests recover the current prompt and tools from Pi's transcript system messages, including later edits. Tool-call arguments follow Pi's JSON-compatible type.
- Parallel Pi sessions use their own working directories, image stores, and rate-limit notices. Ending one session no longer fails a request already running through another.
- Tool-bearing side requests without a registered session or recognized cwd now fail with `working_directory` instead of borrowing another session's directory. A tool-free request that gains tools in `before_provider_request` is also refused before launch.
- Image requests reject a temporary path containing a double quote before writing to the session image store; correcting the path lets the session continue.
- The doctor bridge probe reports an unsuccessful child exit and retains private state when process liveness is uncertain.
- Invalid timeout settings above Node's timer limit fail before launch instead of expiring almost immediately.
- Failed process-tree cleanup retains private state while a child may still be alive. Stale image recovery now makes progress even with more than 256 leftover stores.
- Quitting Pi during a turn no longer waits for Claude to finish. Its image directory remains available to the active request for deferred cleanup.
- New, resumed, forked, and cloned RPC sessions no longer report an extension error when Pi binds the session twice.
- Responses that reach the output limit keep their text and end with a `length` stop, including when Claude Code exits before the provider stops it.
- Other extensions can run their own agent loops or call `completeSimple` with this provider without exiting Pi; they use the same cwd routing rules.
- Thinking summaries are visible in Pi again. Set `PI_CLAUDE_CODE_PROVIDER_THINKING_DISPLAY=omitted` to hide the text.
- Compaction and other one-shot summaries no longer write a prompt-cache entry they cannot reuse.
- Mid-response interruptions, including drops inside streamed tool arguments, are reported as retryable failures under Pi's retry settings. API errors take precedence over unfinished-block errors.

## [0.3.0] - 2026-09-13

### Added

- `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off` turns off the provider's prompt-cache marker. It is an escape hatch in case a future Claude Code release rejects requests for carrying too many cache markers; that error names this setting.
- `CLAUDE_CONFIG_DIR` and `NODE_EXTRA_CA_CERTS` are passed to Claude when set, so a relocated Claude Code configuration and TLS-inspecting proxies work. Logins through `CLAUDE_CODE_OAUTH_TOKEN` remain unsupported.
- For development: `PI_CLAUDE_CODE_PROVIDER_DEV_PI` selects the npm-installed Pi that checks and tests use, `npm run capture:claude-breakpoints` inspects prompt-cache markers without using quota, and the paid release gate adds Haiku and image-cache stages.

### Changed

- Claude now starts in Pi's session working directory, the project Pi's tools work in, instead of a private temporary directory. Private request files stay separate, and `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` stops Claude Code's startup Git status collection, so a project's Git filters don't run. If that directory is deleted while Pi is running, requests fail with `working_directory`; restart Pi from an existing directory.
- Conversations with images now reuse Claude's prompt cache, because each image keeps the same private path for the whole Pi session. The 20-image and size limits are unchanged.
- The first request after upgrading builds a fresh prompt cache, because the transcript format is now `pi-claude-code-provider-context-v4`.
- The minimum supported Claude Code version is now 2.1.270. Older versions still run, and `/pi-claude-code-provider-doctor` flags them.
- `/pi-claude-code-provider-doctor` prints one fact per line.
- Pi's startup `[Extensions]` list shows `pi-claude-code-provider` instead of `pi-claude-code-provider:pi-claude-code-provider.ts`.
- The package summary on npm and pi.dev now reads: "The convenience of your Claude subscription in Pi, with the fewest possible surprises. Uses Claude Code's CLI under the hood."
- Web-search rate-limit errors include the overage-disabled reason, as provider requests already did.
- A Pi `modelOverrides` entry with a missing or non-positive `contextWindow` now fails with `context_window` instead of skipping the context check. The provider's own models are unaffected.
- Invalid request content, for example from another extension's payload hook, reports `content_shape`, `content_type`, or an image error category instead of `payload_invalid`.
- An image request fails with `image_path` if the temporary directory's path contains a double quote; point `TMPDIR` (or `TEMP` on Windows) at another directory.

### Fixed

- On Claude Code 2.1.268 and later, Claude no longer proposes tool calls into the provider's private directory, which made those calls fail.
- Prompt caching works again on Claude Code 2.1.268 and later: later turns reuse about 97–99% of the conversation instead of rewriting it.
- Large system prompts, for example from many skills or context files, are no longer refused by a fixed 120 KiB limit; only the model's context window applies ([#4](https://github.com/chem/pi-claude-code-provider/issues/4)).
- Pi tools whose names contain characters such as `.` no longer make every request fail with `isolation_tools`.
- Pi no longer stalls while a large tool call, such as a big `write`, streams in, and the call preview fills in as it arrives.
- A rate-limit warning that looks the same is shown once per session instead of on every tool round trip.
- Error messages include a short, path-redacted excerpt of Claude Code's error output instead of up to 64 KiB of it.
- Web search no longer counts discarded partial messages against its 2 MiB output limit.

## [0.2.0] - 2026-09-05

### Removed

- **Breaking.** Removed the `default` model alias. It sent no `--model` flag, so the served model was chosen by Claude Code account state that varies between accounts — observed as Sonnet on one and Opus on another — and never reflected the model selected in the user's own Claude Code settings, which this provider does not load. Pi reports an unknown model for a saved `pi --model pi-claude-code-provider/default` or profile entry.

### Added

- `/pi-claude-code-provider-doctor` and the diagnostic report name the model each alias resolves to, without consuming subscription quota. Values that cannot be read report `unavailable` and never affect model selection.
- Minimum supported Pi and Claude Code versions in `README.md`, reported by the doctor. They are advisory: an older installation is not blocked and may still run.
- `PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM` suppresses one named platform's startup advisory without changing its verification status ([#3](https://github.com/chem/pi-claude-code-provider/pull/3)).
- `npm run capture:claude-surface`, which captures `claude --help` verbatim for the capability tests.

### Changed

- The verified baseline advances to Pi 0.85.1 and Claude Code 2.1.261, and CI installs the Pi version the baseline names.
- macOS is recognized as verified on both architectures, with community-reported live coverage recorded in `DEVELOPING.md` ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)). It no longer raises a startup platform advisory.
- The paid model matrix asserts model families instead of dated model ids, so upstream model refreshes no longer fail it.
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
