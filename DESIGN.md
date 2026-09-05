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

Literal at signs are JSON Unicode-escaped because Claude expands `@path` syntax. Only provider-generated, validated images remain attachment references. Their dynamic reference list follows the append-stable transcript blocks so adding an image does not invalidate the reusable history prefix.

Resending the complete current context keeps branches, compaction, reloads, and provider handoff Pi-authoritative without a second session store. It also adds framing tokens, cannot replay thinking signatures, and is not wire-equivalent to the Messages API. Claude controls prompt-cache keys and retention.

## What Claude Code adds on its own

The provider controls what it sends; it does not control everything the model sees. Claude Code adds content of its own that no documented flag removes, and the isolation guarantees above should not be read as covering it. All of the following was observed against Claude Code 2.1.261 using this project's exact argument vector and environment.

In print mode the CLI prepends its own identity line, `You are a Claude agent, built on Anthropic's Claude Agent SDK.`, directly to the system prompt supplied through `--system-prompt-file`, with no separating newline. The branch is selected by non-interactivity rather than by the Agent SDK, so it applies on this project's documented path; `--append-system-prompt` only exchanges it for a different identity line. Nothing is appended after the supplied prompt.

The CLI also injects a `<system-reminder>` block into the first user message carrying the authenticated account's email address and the current date. Neither `--setting-sources ""`, the pinned settings object, nor `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` suppresses it. It is a privacy-relevant disclosure rather than a correctness problem, and it is noted again under Security and privacy.

Claude Code can further append turn nudges to user turns and tool results. Those are conditional, did not appear in the single-turn observation above, and should be treated as possible rather than certain.

## Tool proposal boundary

Active Pi schemas are sorted into an ephemeral MCP catalog. Safe names are preserved; other names receive deterministic request-local aliases. Removed historical tools receive non-callable labels.

The Claude child runs in `dontAsk` mode with local tools disabled. A proposal-only MCP server implements `initialize` and `tools/list`; any `tools/call` writes a violation marker and returns an error. The provider waits for catalog readiness, maps complete known proposals back to Pi, terminates Claude, verifies cleanup and violation state, removes private transport files, and only then publishes the Pi `toolUse` result.

Unknown tools, malformed arguments, execution attempts, private transport paths, unexpected exits, caller cancellation, and cleanup failures fail the request.

## Process and storage lifecycle

On POSIX, Claude runs as a detached process-group leader and cleanup targets the group. On Windows, Claude is a hidden, non-detached child and forced cleanup invokes `%SystemRoot%\System32\taskkill.exe /PID <owned-pid> /T /F`. The PID comes only from the retained request child; the provider never terminates by image name or process enumeration.

System prompts, transcript attachments, catalogs, and markers live in randomized temporary directories. POSIX uses mode 0700 directories and mode 0600 files. Windows relies on the per-user temporary root's ACL. Generated image names are content-addressed, bounded, and independent of user filenames.

Cancellation is checked before launch, so an already-cancelled provider or web-search request starts no Claude process; after launch, cancellation terminates the owned process. Normal success, failure, timeout, and cancellation remove private request state. If termination rejects before the child is known to have closed, supervision rejects promptly, quiesces the retained handle, and preserves the owned marker because process liveness is unknown; cleanup rejection after a known close does not require retention. A bounded POSIX recovery pass removes only old, same-user, package-marked directories whose recorded processes are gone. Windows does not perform automatic stale recovery because Node provides no equivalent ownership check.

Protocol outcomes are published through `ClaudeEventMapper`, whose failure and completion gates are idempotent; setup failures that occur before a mapper exists are published directly by the provider. The request finalizer deliberately does not publish a second terminal event: it owns abort-listener disposal, last-chance safe directory cleanup, and exactly-once metrics. This keeps protocol mapping separate from process and storage finalization while preserving the rule that success follows cleanup.

Host crashes and forceful termination can bypass cleanup. On Windows, `taskkill` cannot reconstruct descendants after their root exits, so normal Claude shutdown is trusted to close its children. Name-based termination is deliberately prohibited because it could kill unrelated sessions.

## Web search

`pi_claude_code_provider_web_search` is a visible Pi tool backed by a separate Claude process restricted to WebSearch and WebFetch. Initialization must confirm the exact tool inventory, `dontAsk`, no unexpected MCP server or customization, and subscription-backed authentication.

The outer Pi tool invocation is visible in Pi; Claude's inner WebSearch and WebFetch calls are intentionally restricted but are not individual Pi tool executions.

The query is supplied through a private generated file. Output is validated and bounded; truncated full output may be retained in a session-scoped private file that is removed at shutdown. The main provider never gains invisible web access.

## Security and privacy

The package trusts the installed Pi and Claude executables, Node, the operating system, and the user's account. It defends against malformed protocol records, unexpected capabilities, unsafe file references, tool-name confusion, private-path disclosure, child-process leaks, oversized data, and accidental diagnostic content leakage.

Claude children receive an allowlisted environment for authentication, locale, proxies, shell discovery, and temporary storage. API keys, alternate routing, hooks, plugins, and arbitrary parent variables are not forwarded. Explicit settings suppress unmanaged user and project Claude customizations, and initialization verifies the resulting inventory. Administrator-managed Claude Code settings, hooks, and MCP policy are an organization-trusted boundary: the package cannot suppress them or prevent their startup effects before validation.

Concretely, the provider passes `--setting-sources ""`, which drops the user, project and local setting sources, and supplies a fixed object through `--settings` in their place. A user who has configured Claude Code will reasonably expect otherwise, so the consequence is worth stating: their own model, effort and per-model settings have no effect on Pi requests. That is Invariant 1 in practice, not an oversight. The alias-resolution environment overrides are excluded from the allowlist for the same reason. Because both are true, alias resolution for this provider's child is fixed by Claude Code's own defaults, which is what makes the model versions the doctor reports accurate rather than a guess.

The injected account email and date described under *What Claude Code adds on its own* survive all of this. Model-visible content reaches Anthropic either way, so this widens no boundary, but it does mean the request carries account context the provider never supplied and cannot remove.

Diagnostics and optional metrics contain bounded system, version, size, usage, and lifecycle facts. They exclude prompts, messages, tool arguments and results, queries, output, request stderr, credentials, and temporary paths. A failed bridge handshake can include a bounded, path-sanitized startup diagnostic derived from bridge stderr. Sanitized paths outside home and temporary roots may remain, so reports must be inspected before sharing.

The package does not sandbox Pi, protect against a compromised local executable, make untrusted prompts safe, or prove undocumented server behavior is absent. Model-visible content is sent to Anthropic and inherits ordinary Claude Code confidentiality risks.

## Compatibility and performance

Machine-readable verified versions and model resolutions live in `src/compatibility.ts`; procedures live in [DEVELOPING.md](DEVELOPING.md). Version metadata is advisory, while protocol and capability mismatches fail at runtime.

Full transcript serialization is required by the stateless design. Stable record boundaries preserve cacheable prefixes, so performance changes must not rewrite unchanged history or weaken validation and cleanup ordering.

Append-stable serialization is necessary but not sufficient. From Claude Code 2.1.233 the CLI began appending terminal content of its own and moving the prompt-cache breakpoint onto it; because this provider starts a fresh print-mode process per request and replays the whole transcript, the next request inserts its new turn ahead of that appended content, so the previous request is no longer a prefix of the current one and reuse collapses entirely. The stateless replay design is what converts a Claude-side append into a total loss of caching. The provider therefore pins an undocumented settings key to suppress that content, on upstream maintainer guidance. Because the key is undocumented, the paid cache gate rather than the setting is the contract: see [DEVELOPING.md](DEVELOPING.md#validation) for the measurement procedure and the conditions for changing it.
