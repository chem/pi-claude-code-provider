# Design

This document owns the maintained architecture and security model. Code is authoritative for exact protocol shapes and limits.

## Invariants

1. Pi owns the system prompt, current branch, compaction, active tools, tool execution, model selection, and cancellation.
2. Except for organization-trusted Claude Code managed policy, Claude may propose Pi tools but may not execute file, shell, web, MCP, plugin, hook, browser, agent, or memory capabilities invisibly.
3. Provider failures are errors, never successful-looking assistant text.
4. Subscription use is not reported as API billing.
5. External interfaces are capability-checked and mismatches fail closed.
6. Private request state is removed before success is published.

## Request and transcript transport

`streamSimple(model, context, options)` receives Pi's prepared context and applies Pi's logical `before_provider_request` replacement when present. The provider does not parse session files or rebuild Pi state.

Validated initialization is the transport's response boundary: capabilities are known and no content has been published. The provider announces it to Pi's `after_provider_response` observers with a synthetic success status and no headers, because the headless protocol exposes no HTTP response. The observer completes before body events are mapped; a failing observer fails the request.

Each request serializes the effective system prompt, messages, and active tools into a versioned semantic transcript. Separate append-stable records preserve model-visible text, reasoning, tool calls, tool results, and images while omitting operational metadata, prior errors, usage fields, signatures, and UI-only details. Historical tool results pair by `toolCallId`.

Literal at signs are JSON Unicode-escaped because Claude expands `@path` syntax. Only provider-generated, validated images remain attachment references.

Resending the complete current context keeps branches, compaction, reloads, and provider handoff Pi-authoritative without a second session store. It also adds framing tokens, cannot replay thinking signatures, and is not wire-equivalent to the Messages API. Claude controls prompt-cache keys and retention.

## Tool proposal boundary

Active Pi schemas are sorted into an ephemeral MCP catalog. Safe names are preserved; other names receive deterministic request-local aliases. Removed historical tools receive non-callable labels.

The Claude child runs in `dontAsk` mode with local tools disabled. A proposal-only MCP server implements `initialize` and `tools/list`; any `tools/call` writes a violation marker and returns an error. The provider waits for catalog readiness, maps complete known proposals back to Pi, terminates Claude, verifies cleanup and violation state, removes private transport files, and only then publishes the Pi `toolUse` result.

Unknown tools, malformed arguments, execution attempts, private transport paths, unexpected exits, caller cancellation, and cleanup failures fail the request.

## Process and storage lifecycle

On POSIX, Claude runs as a detached process-group leader and cleanup targets the group. On Windows, Claude is a hidden, non-detached child and forced cleanup invokes `%SystemRoot%\System32\taskkill.exe /PID <owned-pid> /T /F`. The PID comes only from the retained request child; the provider never terminates by image name or process enumeration.

System prompts, transcript attachments, catalogs, and markers live in randomized temporary directories. POSIX uses mode 0700 directories and mode 0600 files. Windows relies on the per-user temporary root's ACL. Generated image names are content-addressed, bounded, and independent of user filenames.

Normal success, failure, timeout, and cancellation remove private request state. A bounded POSIX recovery pass removes only old, same-user, package-marked directories whose recorded processes are gone. Windows does not perform automatic stale recovery because Node provides no equivalent ownership check.

Host crashes and forceful termination can bypass cleanup. On Windows, `taskkill` cannot reconstruct descendants after their root exits, so normal Claude shutdown is trusted to close its children. Name-based termination is deliberately prohibited because it could kill unrelated sessions.

## Web search

`pi_claude_code_provider_web_search` is a visible Pi tool backed by a separate Claude process restricted to WebSearch and WebFetch. Initialization must confirm the exact tool inventory, `dontAsk`, no unexpected MCP server or customization, and subscription-backed authentication.

The query is supplied through a private generated file. Output is validated and bounded; truncated full output may be retained in a session-scoped private file that is removed at shutdown. The main provider never gains invisible web access.

## Security and privacy

The package trusts the installed Pi and Claude executables, Node, the operating system, and the user's account. It defends against malformed protocol records, unexpected capabilities, unsafe file references, tool-name confusion, private-path disclosure, child-process leaks, oversized data, and accidental diagnostic content leakage.

Claude children receive an allowlisted environment for authentication, locale, proxies, shell discovery, and temporary storage. API keys, alternate routing, hooks, plugins, and arbitrary parent variables are not forwarded. Explicit settings suppress unmanaged user and project Claude customizations, and initialization verifies the resulting inventory. Administrator-managed Claude Code settings, hooks, and MCP policy are an organization-trusted boundary: the package cannot suppress them or prevent their startup effects before validation.

Diagnostics and optional metrics contain bounded system, version, size, usage, and lifecycle facts. They exclude prompts, messages, tool arguments and results, queries, output, stderr, credentials, and temporary paths. Sanitized diagnostic paths outside home and temporary roots may remain, so reports must be inspected before sharing.

The package does not sandbox Pi, protect against a compromised local executable, make untrusted prompts safe, or prove undocumented server behavior is absent. Model-visible content is sent to Anthropic and inherits ordinary Claude Code confidentiality risks.

## Compatibility and performance

Machine-readable verified versions and model resolutions live in `src/compatibility.ts`; procedures live in [DEVELOPING.md](DEVELOPING.md). Version metadata is advisory, while protocol and capability mismatches fail at runtime.

Full transcript serialization is required by the stateless design. Stable record boundaries preserve cacheable prefixes, so performance changes must not rewrite unchanged history or weaken validation and cleanup ordering.
