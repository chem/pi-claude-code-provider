# pi-claude-code-provider

A [Pi](https://pi.dev) package that creates a provider for Claude family models from an authenticated monthly subscriber Claude Code installation by launching Anthropic's installed `claude` executable in documented non-interactive print mode.  Pi remains fully in charge of the session: branching, compaction, and history behave like any other Pi provider, and every tool runs visibly in Pi — the Claude process can propose tool calls but never execute anything on its own. The goal is simple: the convenience of your Claude subscription in Pi, with the fewest possible surprises.

This package never imitates private OAuth traffic, does not use the Agents SDK, and does not modify Claude's internal session files. It never reads Claude credentials or uses an Anthropic API key.

This project was developed using frontier AI models under human guidance. Almost all of the docs and code were written by machines except for this introductory material. The project may be over-engineered in some respects; that's fine. If you enjoy this package, please star it on github.

## Requirements

- Node.js 22.19 or newer
- [Pi](https://pi.dev), verified with 0.84.1
- Claude Code, verified with 2.1.226
- Claude Code logged in to an eligible Pro, Max, Team, or Enterprise claude.ai subscription

WSL2 Ubuntu and native Windows x64 are verified. Apple Silicon macOS passes the [deterministic GitHub Actions matrix](.github/workflows/ci.yml), while subscription-consuming live validation remains pending. See the [compatibility baseline](DEVELOPING.md#compatibility-baseline) for current versions and details. Other platforms continue with a warning and runtime capability checks.

The provider rejects API-key authentication, alternate Anthropic base URLs, and Bedrock, Vertex, or Foundry routing. If `claude` is not on `PATH`, set `PI_CLAUDE_CODE_PROVIDER_PATH` to its executable path.

## Install

```bash
pi install npm:pi-claude-code-provider
```

To install directly from GitHub's default branch:

```bash
pi install git:github.com/chem/pi-claude-code-provider
```

Add `-l` for a project-local installation. Pi loads project packages only after the project is trusted; use `pi config` to enable or disable the extension.

## Use

Open `/model` and choose one of these aliases: `default`, `sonnet`, `fable`, `opus`, or `haiku`. Pi displays them with the provider name, for example `sonnet [pi-claude-code-provider]`.

To select one directly:

```text
/model pi-claude-code-provider/sonnet
```

The same canonical reference works from the command line with `pi --model pi-claude-code-provider/sonnet`.

Pi maps its exposed thinking levels to Claude's `low`, `medium`, `high`, `xhigh`, and `max` effort values; unsupported levels are hidden. Opus uses a 200K context window on Pro and 1M on Max, Team, and Enterprise. The provider retains 200K on Pro even when Claude Code reports a 1M-capable variant, because it cannot determine credit availability.

The `fable` alias is offered and separately testable, but it is excluded from the paid release gate. Fable 5 availability, included allocation, and billing vary by subscription tier. It otherwise follows the standard alias path wherever the account allows it. See Anthropic's [Fable plan policy](https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan).

**Model identity:** self-identification is generated text, not routing metadata, and Pi's coding-tool prompt and schemas can make Claude name an older Sonnet even when Claude Code served Opus. Use the assistant message's `responseModel` field in Pi's JSON output for the served model; Pi's status line shows the requested alias.

After installation or an upstream update, run:

```text
/pi-claude-code-provider-doctor
```

Run `/pi-claude-code-provider-doctor report` to write a bounded, content-free JSON diagnostic report in a private temporary directory. Inspect the report before sharing it.

The package also registers `pi_claude_code_provider_web_search`, a visible Pi tool that runs Claude with only WebSearch and WebFetch. It is skipped with a warning if another extension already owns that name. Truncated full results are removed at session shutdown.

## Subscription usage

Provider and web-search requests consume Claude subscription capacity. Optional usage credits may incur additional spend after plan limits. The package reports Claude's token counts when available and reports zero monetary cost because it cannot determine how a subscription request was billed.

Anthropic documents [`claude -p` / `--print`](https://code.claude.com/docs/en/cli-reference) as its non-interactive CLI interface, explains that [third-party usage draws from subscription limits](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), and documents [subscription authentication and usage credits](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan). This project uses that public interface without claiming Anthropic endorsement.

Rate-limit warnings, overage status, and reset times appear as Pi notifications when Claude provides them, including for web-search requests. Utilization is displayed using Claude Code's whole-percent convention.

## Compatibility limitation

Claude Code's public headless protocol cannot accept arbitrary historical assistant and tool-result messages, so the provider sends Pi's complete current history as an append-stable semantic transcript on every request. Pi remains authoritative for branching, compaction, reloads, and provider handoff; the transport is not wire-equivalent to Anthropic's Messages API, consumes additional context, and leaves prompt-cache keys and retention to Claude.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_CLAUDE_CODE_PROVIDER_PATH` | Override the `claude` executable path. |
| `PI_CLAUDE_CODE_PROVIDER_METRICS_LOG` | Append content-free request and search metrics as JSONL. |
| `PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS` | Override the five-minute protocol-idle timeout with positive milliseconds. |
| `PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS` | Override the 30-minute total timeout with positive milliseconds. |
| `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` | Override the five-second tool-catalog readiness timeout with positive milliseconds. |

Metrics exclude prompts, messages, queries, output, credentials, stderr, and temporary paths. On POSIX, the log is kept at mode 0600; Windows uses the selected location's ACL.

## Security and troubleshooting

Pi packages run with the user's permissions; review the source before installation and treat model-visible context like any other Claude Code prompt. Main requests suppress unmanaged user and project customizations and local tools, validate capabilities, and remove private request state before success. Administrator-managed Claude Code settings, hooks, and MCP policy are organization-trusted and can take effect before validation; abrupt host termination can still leave state behind. See [DESIGN.md](DESIGN.md) for the security model and [SECURITY.md](SECURITY.md) for vulnerability reporting.

- **Provider missing:** run the doctor, correct the reported problem, then run `/reload`.
- **Authentication rejected:** run `claude auth status` and log in with an eligible first-party subscription.
- **Compatibility warning:** compare the installed versions with [DEVELOPING.md](DEVELOPING.md#compatibility-baseline).
- **Search unavailable:** allow `pi_claude_code_provider_web_search` in Pi's tool filters and check for a name collision.
- **`pi auth check` reports `provider_not_found`:** that command does not load extensions, so it cannot see any extension-registered provider. Use `/pi-claude-code-provider-doctor` to check readiness.
- **Stale Windows state after an abrupt exit:** stop the relevant Pi and Claude processes, locate Node's temporary directory with `node -p "require('node:os').tmpdir()"`, inspect package marker files, and remove only confirmed stale directories.

## Development and license

See [DEVELOPING.md](DEVELOPING.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [DESIGN.md](DESIGN.md). Licensed under MIT.
