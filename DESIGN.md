# Design

This document owns the maintained architecture and security model. Code is authoritative for exact protocol shapes and limits.

## Invariants

1. Pi owns the system prompt, current branch, compaction, active tools, tool execution, model selection, and cancellation.
2. Except for organization-trusted Claude Code managed policy, the main provider's Claude process may propose Pi tools but may not execute file, shell, web, MCP, plugin, hook, browser, agent, or memory capabilities invisibly. The separately invoked visible Pi web-search tool is the narrowly scoped exception described below.
3. Provider failures are errors, never successful-looking assistant text.
4. Subscription use is not reported as API billing.
5. External interfaces are capability-checked and mismatches fail closed.
6. Private request state is removed before success is published.

## Request and transcript transport

`streamSimple(model, context, options)` receives Pi's prepared context and applies Pi's logical `before_provider_request` replacement when present. The provider does not parse session files or rebuild Pi state.

Validated initialization is the transport's response boundary: capabilities are known and no content has been published. The provider announces it to Pi's `after_provider_response` observers with a synthetic success status and no headers, because the headless protocol exposes no HTTP response. The observer completes before body events are mapped; a failing observer fails the request.

Each request serializes the effective system prompt, messages, and active tools into a versioned semantic transcript. Separate append-stable records preserve model-visible text, reasoning, tool calls, tool results, and images while omitting operational metadata, provider error messages, usage fields, signatures, and UI-only details. Tool-result `isError` state is preserved so historical failures remain meaningful. Historical tool results pair by `toolCallId`.

Two budget checks bound a request against the served model's context window, which the model must report. A system prompt that cannot fit even alone is refused before any private state is created, because nothing later in the request can make room for it; that failure is deliberately not worded as a context overflow, since compacting history cannot shrink a system prompt. The complete estimate over transcript, catalog, images, and system prompt is checked once preparation completes, and is deliberately conservative.

Literal at signs are JSON Unicode-escaped because Claude expands `@path` syntax. Only provider-generated, validated images remain attachment references. They are quoted absolute paths: Claude runs in Pi's session directory, where a relative reference would resolve against the project, and the quotes keep a temporary root containing spaces in one reference. Claude Code's quoted form cannot contain a double quote, so an image request from a temporary directory whose path has one fails with `image_path`. Their reference list follows the append-stable transcript blocks. Each Pi session stores image bytes under private, content-addressed paths that stay identical across its requests; a later request reattaches every image still in its effective context, including images Claude has already answered. Claude Code narrates image reads ahead of the transcript, so stable paths are required for cache reuse. A newly added image can still change that prefix. Images remain subject to the existing 20-image count and aggregate byte limits on every request. This conservative count aligns with [Anthropic's documented limit of 20 images per claude.ai message](https://platform.claude.com/docs/en/build-with-claude/vision); it is not a verified Claude Code print-mode limit.

Resending the complete current context keeps branches, compaction, reloads, and provider handoff Pi-authoritative without a second session store. It also adds framing tokens, cannot replay thinking signatures, and is not wire-equivalent to the Messages API. Claude controls prompt-cache keys; the transport chooses only the placement and one-hour TTL of its single history breakpoint, described under compatibility below.

## What Claude Code adds on its own

The provider controls what it sends; it does not control everything the model sees. Claude Code adds content of its own that no documented flag removes, and the isolation guarantees above should not be read as covering it. It describes Claude Code at the verified baseline, run with this project's exact argument vector and environment, and `npm run capture:claude-breakpoints` rechecks the request-shape claims whenever that baseline moves.

The CLI prepends a billing header block, carrying its own exact version, ahead of everything else in the system array, where it is never marked for caching. Upgrading Claude Code therefore invalidates every cached prefix, which is expected but worth knowing before reading a cold start as a regression.

In print mode the CLI also prepends its own identity line, `You are a Claude agent, built on Anthropic's Claude Agent SDK.`, directly to the system prompt supplied through `--system-prompt-file`, with no separating newline. The branch is selected by non-interactivity rather than by the Agent SDK, so it applies on this project's documented path; `--append-system-prompt` only exchanges it for a different identity line. Nothing is appended after the supplied prompt.

The CLI also injects a block of its own environment context. It states Claude's process working directory as the model's primary working directory and says whether that directory is a git repository. Neither `--setting-sources ""`, the pinned settings object, nor `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` suppresses it. `--bare` does, but it never reads a subscription login. A request therefore carries context the provider never supplied and cannot remove.

Where the block lands depends on the model family, and can move between releases. The Claude 5 aliases receive it as a trailing `role: "system"` message after the transcript, the last thing the model reads, while Haiku 4.5 receives it at the head of the first user message. That difference decides whether prompt caching works, as the compatibility section below explains.

The model treats the block as fact, which is why Claude runs in Pi's session directory (see process lifecycle below). The block then agrees with the working directory Pi's system prompt states, and it stays identical across requests. Run anywhere else, such as the private request directory, the model proposes Pi tool calls into that directory and can describe a git project as not being a repository.

Starting in the project has effects of its own, which the provider bounds:

- **Startup Git collection.** Claude Code collects git status, recent log and user name at startup for its default system prompt, which `--system-prompt-file` replaces. That status, run in a repository with a configured clean filter, executes the filter. The provider sets `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`, which stops the collection without changing what reaches the model, and `npm run capture:claude-breakpoints` fails if a release runs the filter again.
- **What still runs.** With that setting, Claude Code still runs read-only `git ls-files` and `git remote` probes and an `rg --files` count of the project, and reads the project's `.claude/settings*.json`. None of the project's customizations, hooks or MCP servers take effect, and nothing is written to the project.
- **Cost.** The file count runs on every launch, so very large repositories add measurable latency to each tool round trip.

These are observed behaviors, not guarantees; a Claude Code release can change them.

Claude Code can further append turn nudges to user turns and tool results. Those are conditional and should be treated as possible rather than certain.

## Tool proposal boundary

Active Pi schemas are sorted into an ephemeral MCP catalog. Names of at most 48 characters made only of the characters Claude Code keeps unchanged in an MCP tool name (letters, digits, `_`, and `-`) are preserved; other names receive deterministic request-local aliases. Removed historical tools receive non-callable labels.

The Claude child runs in `dontAsk` mode with local tools disabled. A proposal-only MCP server implements `initialize` and `tools/list`; any `tools/call` writes a violation marker and returns an error. The provider waits for catalog readiness, maps complete known proposals back to Pi, terminates Claude, verifies cleanup and violation state, removes private transport files, and only then publishes the Pi `toolUse` result.

Unknown tools, malformed arguments, execution attempts, private transport paths, unexpected exits, caller cancellation, and cleanup failures fail the request.

## Process and storage lifecycle

On POSIX, Claude runs as a detached process-group leader and cleanup targets the group. On Windows, Claude is a hidden, non-detached child and forced cleanup invokes `%SystemRoot%\System32\taskkill.exe /PID <owned-pid> /T /F`. The PID comes only from the retained request child; the provider never terminates by image name or process enumeration.

System prompts, transcripts, catalogs, and markers live in randomized per-request temporary directories. Images live in a separate private directory for the Pi session so their paths stay stable. The image directory is removed after active requests finish at session shutdown; if child-process liveness is unknown it is retained for safety and stale-directory recovery handles it later. POSIX uses mode 0700 directories and mode 0600 files. Windows relies on the per-user temporary root's ACL. Generated image names are content-addressed, bounded, and independent of user filenames.

**Claude's own working directory is Pi's session directory.** The extension reads it from the session's context at `session_start`, not from Pi's process directory, which a resumed or imported session can differ from.

**Validation before any launch.** Each request reads that directory once and validates it before any private state exists. A request fails with `working_directory` without launching when no Pi session has started, the path is not absolute, it cannot be read (for example because it no longer exists), or it is not a directory. A directory that disappears between validation and spawn fails the same way.

**No fallback.** The provider never substitutes another directory, because any other would contradict Pi's again.

**Private-directory exceptions.** Only web search and the doctor's bridge probe still run in private directories; neither has Pi tools to misdirect.

Cancellation is checked before launch, so an already-cancelled provider or web-search request starts no Claude process; after launch, cancellation terminates the owned process. Normal success, failure, timeout, and cancellation remove private request state. If termination rejects before the child is known to have closed, supervision rejects promptly, quiesces the retained handle, and preserves the owned marker because process liveness is unknown; cleanup rejection after a known close does not require retention. A bounded POSIX recovery pass removes only old, same-user, package-marked directories whose recorded processes are gone. Windows does not perform automatic stale recovery because Node provides no equivalent ownership check. Provider requests and web search launch Claude through one shared lifecycle in `src/claude-process.ts`, so this ordering is implemented once.

Protocol outcomes are published through `ClaudeEventMapper`, whose failure and completion gates are idempotent; setup failures that occur before a mapper exists are published directly by the provider. Claude Code can emit a `system`/`api_retry` record and restart the stream; the mapper discards the abandoned attempt so a later `message_start` is not treated as a duplicate, and partial text from the failed attempt cannot merge into the surviving one. The request finalizer deliberately does not publish a second terminal event: it owns abort-listener disposal, last-chance safe directory cleanup, and exactly-once metrics. This keeps protocol mapping separate from process and storage finalization while preserving the rule that success follows cleanup.

Host crashes and forceful termination can bypass cleanup. On Windows, `taskkill` cannot reconstruct descendants after their root exits, so normal Claude shutdown is trusted to close its children. Name-based termination is deliberately prohibited because it could kill unrelated sessions.

## Web search

`pi_claude_code_provider_web_search` is a visible Pi tool backed by a separate Claude process restricted to WebSearch and WebFetch. Initialization must confirm the exact tool inventory, `dontAsk`, no unexpected MCP server or customization, and subscription-backed authentication.

The outer Pi tool invocation is visible in Pi; Claude's inner WebSearch and WebFetch calls are intentionally restricted but are not individual Pi tool executions.

The query is supplied through a private generated file. Output is validated and bounded; truncated full output may be retained in a session-scoped private file that is removed at shutdown. The main provider never gains invisible web access.

## Security and privacy

The package trusts the installed Pi and Claude executables, Node, the operating system, and the user's account. It defends against malformed protocol records, unexpected capabilities, unsafe file references, tool-name confusion, private-path disclosure, child-process leaks, oversized data, and accidental diagnostic content leakage.

Claude children receive an allowlisted environment for authentication (including a relocated `CLAUDE_CONFIG_DIR`), locale, proxies and a proxy's `NODE_EXTRA_CA_CERTS` bundle, shell discovery, and temporary storage. Pinned variables disable automatic memory, nonessential traffic, and Claude Code's startup Git status collection. API keys, `CLAUDE_CODE_OAUTH_TOKEN`, alternate routing, hooks, plugins, and arbitrary parent variables are not forwarded. Explicit settings suppress unmanaged user and project Claude customizations, and initialization verifies the resulting inventory. Administrator-managed Claude Code settings, hooks, and MCP policy are an organization-trusted boundary: the package cannot suppress them or prevent their startup effects before validation.

Concretely, the provider passes `--setting-sources ""`, which drops the user, project and local setting sources, and supplies a fixed object through `--settings` in their place. A user who has configured Claude Code will reasonably expect otherwise, so the consequence is worth stating: their own model, effort and per-model settings have no effect on Pi requests. That is Invariant 1 in practice, not an oversight. The alias-resolution environment overrides are excluded from the allowlist for the same reason. Because both are true, alias resolution for this provider's child is fixed by Claude Code's own defaults, which is what makes the model versions the doctor reports accurate rather than a guess.

Diagnostics and optional metrics contain bounded system, version, size, usage, and lifecycle facts. They exclude prompts, messages, tool arguments and results, queries, output, request stderr, credentials, and temporary paths. A failed bridge handshake can include a bounded, path-sanitized startup diagnostic derived from bridge stderr. Request error messages can likewise carry a bounded tail of Claude Code's stderr with the private request directory replaced; for web search that message reaches the model as a tool result. Sanitized paths outside home and temporary roots may remain, so reports must be inspected before sharing.

Model-proposed file and shell operations execute only through Pi. That is narrower than saying Claude has no local effects: the startup operations described under "What Claude Code adds on its own" run before any proposal, and administrator policy or a later CLI release could add others. The package does not sandbox Pi, protect against a compromised local executable, make untrusted prompts safe, or prove undocumented server behavior is absent. Model-visible content is sent to Anthropic and inherits ordinary Claude Code confidentiality risks.

## Compatibility and performance

Machine-readable verified versions and the model family each alias must serve live in `src/compatibility.ts`; procedures live in [DEVELOPING.md](DEVELOPING.md). Version metadata is advisory, while protocol and capability mismatches fail at runtime.

Full transcript serialization is required by the stateless design. Stable record boundaries preserve cacheable prefixes, so performance changes must not rewrite unchanged history or weaken validation and cleanup ordering.

Append-stable serialization is necessary but not sufficient. By default the CLI appends a changing token reminder of its own after the transcript; because this provider starts a fresh print-mode process per request and replays the whole transcript, the next request inserts its new turn ahead of that appended content, so the previous request is no longer a prefix of the current one and reuse collapses entirely. The stateless replay design is what converts a Claude-side append into a total loss of caching. The provider therefore pins an undocumented settings key to suppress that content, on upstream maintainer guidance. Because the key is undocumented, the paid cache gate rather than the setting is the contract: see [DEVELOPING.md](DEVELOPING.md#prompt-caching) for the measurement procedure and the conditions for changing it.

The CLI also places its final `cache_control` marker on the content it appends rather than on the transcript, leaving the replayed history with no cacheable entry of its own, and no setting changes that. The transport therefore sets that breakpoint itself, on the last history block and ahead of the generated attachment references. The breakpoint uses a one-hour TTL because the API requires breakpoints in longest-TTL-first order and Claude Code's own markers after it are one-hour; that doubles the cache-write rate over the five-minute default, a cost accepted because the ordering leaves no choice. It is also the last of the four breakpoints the API allows on every Claude 5 alias, so a Claude Code release that adds one of its own would fail every request. `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off` drops it at the cost of prompt caching, and the provider recognizes the API's limit rejection and names that setting. Haiku 4.5 receives the same environment content ahead of the transcript rather than after it, so it caches only while that content is identical across requests. Pi's session working directory and the image paths are stable; request-private files remain in their own exclusively created directories. Account-specific per-session content or changed attachment narration can still disturb that prefix, so `npm run test:paid:cache-haiku` and the Sonnet and Haiku image-cache stages gate reuse separately.

A request can append only about twenty records beyond the history the previous request cached. Each breakpoint looks back about twenty block positions for a prior entry. The API collapses runs of consecutive `tool_use` or `tool_result` blocks to one position, but that exemption does not apply here, because the transcript gives every Pi message, each tool result included, its own plain text block. Past the ceiling the loss of reuse is total and silent. Pi makes a new request after every tool round trip, so the records appended between requests are usually one assistant message plus one per parallel tool result, and only a step with about nineteen or more parallel tool calls reaches the ceiling. An intermediate breakpoint would exceed the four-breakpoint budget. Sending each run of consecutive tool results as one block would lift the ceiling, but that serialization change would need the paid cache gate.
