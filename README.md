# pi-claude-code-provider

A [Pi](https://pi.dev) package that creates a provider for Claude family models from an authenticated monthly subscriber Claude Code installation by launching Anthropic's installed `claude` executable in documented non-interactive print mode.  Pi remains fully in charge of the session: branching, compaction, and history behave like any other Pi provider, and every tool runs visibly in Pi — the Claude process can propose tool calls but never execute anything on its own. The goal is simple: the convenience of your Claude subscription in Pi, with the fewest possible surprises.

This package never imitates private OAuth traffic, does not use the Agents SDK, and does not modify Claude's internal session files. It never reads Claude credentials or uses an Anthropic API key.

This project was developed using frontier AI models under human guidance. Almost all of the docs and code were written by machines except for this introductory material. The project may be over-engineered in some respects; that's fine. If you enjoy this package, please star it on github.

## Requirements

- Node.js 22.19 or newer
- [Pi](https://pi.dev), verified with 0.82.0
- Claude Code, verified with 2.1.219
- Claude Code logged in to an eligible Pro, Max, Team, or Enterprise claude.ai subscription

WSL2 Ubuntu and native Windows x64 are verified. Apple Silicon macOS passes the [deterministic GitHub Actions matrix](.github/workflows/ci.yml) on Node.js 24.16.0; subscription-consuming live validation on macOS remains pending. Other platforms continue with a warning and runtime capability checks.

The provider rejects API-key authentication, alternate Anthropic base URLs, and Bedrock, Vertex, or Foundry routing. If `claude` is not on `PATH`, set `PI_CLAUDE_CODE_PROVIDER_PATH` to its executable path.

## Install

```bash
pi install npm:pi-claude-code-provider
```

To install a tag or commit from GitHub:

```bash
pi install git:github.com/chem/pi-claude-code-provider@REF
```

Add `-l` for a project-local installation. Pi loads project packages only after the project is trusted; use `pi config` to enable or disable the extension.

## Use

Open `/model` and choose one of these aliases: `default`, `sonnet`, `fable`, `opus`, or `haiku`. Pi displays them with the provider name, for example `sonnet [pi-claude-code-provider]`.

To select one directly:

```text
/model pi-claude-code-provider/sonnet
```

The same canonical reference works from the command line with `pi --model pi-claude-code-provider/sonnet`.

Pi thinking levels map to Claude's `low`, `medium`, `high`, `xhigh`, and `max` effort values. Unsupported levels are hidden. Opus uses a safe 200K context window on Pro and 1M on Max, Team, and Enterprise. Claude Code may report the 1M-capable Opus variant on Pro even when usage credits are disabled; the provider keeps Pi's configured limit at 200K because it cannot determine credit availability.

**A note about model self-identification:** Asking Claude “what model are you?” is not a reliable way to verify the served model. Pi's coding-tool prompt and schemas can cause Claude to confidently name an older Sonnet version even when Claude Code served Opus. That answer is generated text, not routing metadata; use the assistant message's `responseModel` field in Pi's JSON output when you need the concrete served model. Pi's status line shows the requested provider alias.

After installation or an upstream update, run:

```text
/pi-claude-code-provider-doctor
```

Run `/pi-claude-code-provider-doctor report` to write a bounded, content-free JSON diagnostic report in a private temporary directory. Inspect the report before sharing it.

The package also registers `pi_claude_code_provider_web_search`, a visible Pi tool that runs Claude with only WebSearch and WebFetch. It is skipped with a warning if another extension already owns that name. Truncated full results are removed at session shutdown.

## Subscription usage

Provider and web-search requests consume Claude subscription capacity. Optional usage credits may incur additional spend after plan limits. The package reports Claude's token counts when available and reports zero monetary cost because it cannot determine how a subscription request was billed.

Anthropic documents [`claude -p` / `--print`](https://code.claude.com/docs/en/cli-reference) as its non-interactive CLI interface, explains that [third-party usage draws from subscription limits](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), and documents [subscription authentication and usage credits](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan). This project uses that public interface without claiming Anthropic endorsement.

Rate-limit warnings and reset times appear as Pi notifications when Claude provides them.

## Compatibility limitation

Claude Code's public headless protocol does not accept arbitrary historical assistant and tool-result messages. The provider therefore sends Pi's complete current history as an append-stable semantic transcript on every request. Branching, compaction, reloads, and provider handoff remain Pi-authoritative, but the transport is not wire-equivalent to Anthropic's Messages API and consumes additional context. Claude controls prompt-cache keys and retention.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_CLAUDE_CODE_PROVIDER_PATH` | Override the `claude` executable path. |
| `PI_CLAUDE_CODE_PROVIDER_METRICS_LOG` | Append content-free request and search metrics as JSONL. |
| `PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS` | Override the five-minute protocol-idle timeout with positive milliseconds. |
| `PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS` | Override the 30-minute total timeout with positive milliseconds. |

Metrics exclude prompts, messages, queries, output, credentials, stderr, and temporary paths. On POSIX, the log is kept at mode 0600; Windows uses the selected location's ACL.

## Security and troubleshooting

Pi packages run with the user's permissions. Review the source before installation and treat model-visible context like any other Claude Code prompt. Main requests suppress Claude customizations and local tools, validate the initialized capability inventory, and remove private request state before reporting success. Abrupt host termination can still leave state behind. See [DESIGN.md](DESIGN.md) for the security model and [SECURITY.md](SECURITY.md) for vulnerability reporting.

- **Provider missing:** run the doctor, correct the reported problem, then run `/reload`.
- **Authentication rejected:** run `claude auth status` and log in with an eligible first-party subscription.
- **Compatibility warning:** compare the installed versions with [DEVELOPING.md](DEVELOPING.md#compatibility-baseline).
- **Search unavailable:** allow `pi_claude_code_provider_web_search` in Pi's tool filters and check for a name collision.
- **Stale Windows state after an abrupt exit:** stop the relevant Pi and Claude processes, locate Node's temporary directory with `node -p "require('node:os').tmpdir()"`, inspect package marker files, and remove only confirmed stale directories.

## Development and license

See [DEVELOPING.md](DEVELOPING.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [DESIGN.md](DESIGN.md). Licensed under MIT.
