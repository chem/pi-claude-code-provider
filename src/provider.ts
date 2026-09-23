import { existsSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { bridgeArgv, formatBridgeArgv, providerArgs, thinkingDisplay, transcriptBreakpointEnabled } from "./claude-args.ts";
import { claimClaudeLaunch, settleFailure, spawnClaudeProcess, type ClaudeProcess } from "./claude-process.ts";
import { prepareRequest } from "./context-serializer.ts";
import { appendCleanupFailure, ClaudeCodeError, errorCode, errorText } from "./errors.ts";
import { JsonlParser } from "./jsonl.ts";
import { recordRequestMetrics } from "./metrics.ts";
import { createOutput } from "./output.ts";
import { claimPaidTestLaunch } from "./paid-launch-budget.ts";
import { ProcessTerminationError, superviseProcess, type ProcessResult } from "./process-utils.ts";
import { removeRuntimeDirectory } from "./runtime-directories.ts";
import type { ImageStoreLease } from "./session-image-store.ts";
import type { ResolvedSession, SessionRequest } from "./session-registry.ts";
import { ClaudeEventMapper, type ClaudeTerminationCause } from "./stream-events.ts";
import type { ClaudeInstallation, LogicalProviderPayload, MutableOutput, RequestMetrics } from "./types.ts";

const DEFAULT_MCP_READY_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;
/** Internal dependency seam for deterministic cleanup-failure tests. */
type CleanupDirectory = (directory: string) => Promise<void>;

/** Internal dependency seam for deterministic abort-timing tests. */
type ClaimLaunch = () => Promise<void>;

/**
 * Recover Pi's logical request from the transcript it hands a provider. The
 * prompt and tool declarations live in system messages; `normalizeContext()`
 * folds the public `Context` shorthand into them before any provider is reached,
 * so those top-level fields never arrive here. Pi's own helpers replay sections
 * and tool deltas in order, and Claude Code gets the resulting prompt and active
 * catalog while ordinary message history stays in its existing format.
 *
 * An empty recovery collapses to `undefined` rather than `""` or `[]`: a
 * transcript draws no distinction between "declared nothing" and "declared
 * empty", and `undefined` is the shape a `before_provider_request` hook already
 * reads as absent.
 */
function recoverProviderContext(context: TranscriptContext): Context {
  const systemPrompt = piAi.getCurrentSystemPrompt(context.messages);
  const tools = piAi.getCurrentTools(context.messages);
  return {
    systemPrompt: systemPrompt === "" ? undefined : systemPrompt,
    tools: tools.length === 0 ? undefined : tools,
    messages: context.messages.filter((message) => (message as { role: string }).role !== "system"),
  };
}

export interface ClaudeStreamDependencies {
  cleanupDirectory?: CleanupDirectory;
  claimLaunch?: ClaimLaunch;
  supervise?: typeof superviseProcess;
  /**
   * Resolve the request's cwd and borrow private state from a live session.
   * Registered IDs and Pi's prompt declaration can identify the cwd. A sole
   * live session may be borrowed for tool-bearing requests only by explicit
   * compatibility opt-in; that does not establish the caller's actual cwd.
   */
  resolveSession?: (request: SessionRequest) => ResolvedSession | { error: string } | undefined;
}

export function createClaudeStream(
  installation: ClaudeInstallation,
  dependencies: ClaudeStreamDependencies = {},
) {
  const cleanupDirectory = dependencies.cleanupDirectory ?? removeRuntimeDirectory;
  const claimLaunch = dependencies.claimLaunch ?? claimPaidTestLaunch;
  const supervise = dependencies.supervise ?? superviseProcess;
  return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = piAi.createAssistantMessageEventStream();
    const requestContext = recoverProviderContext(context);
    // Resolved once, when Pi starts the request: a session starting or ending
    // during asynchronous preparation must not move this request to another
    // directory. The pre-hook prompt is used deliberately, because the session a
    // request belongs to is not a payload hook's to change.
    const session = dependencies.resolveSession?.({
      sessionId: options?.sessionId,
      systemPrompt: requestContext.systemPrompt,
      hasTools: (requestContext.tools?.length ?? 0) > 0,
    });
    const resolved = session && "error" in session ? undefined : session;
    const imageStore = resolved?.imageStore;
    const onRateLimitNotice = resolved?.onRateLimitNotice;
    // Leased with the session, not after preparation: a request that borrowed a
    // store from another live session would otherwise fail across the awaits in
    // between if that session shut down, even carrying no images at all. close()
    // waits on outstanding leases, so the directory survives for whoever holds
    // one. A request that goes on to fail briefly holds a lease it never used,
    // which is correct: the store must stay open for anything still able to
    // write to it. The failure is carried rather than thrown, because this
    // prologue must return a stream, not raise.
    let imageLease: ImageStoreLease | undefined;
    let leaseFailure: unknown;
    try {
      imageLease = imageStore?.acquire();
    } catch (error) {
      leaseFailure = error;
    }
    const output = createOutput(model);

    void (async () => {
      const startedAt = Date.now();
      const effort = model.id === "haiku" ? "default" : options?.reasoning ?? "medium";
      let prepared: Awaited<ReturnType<typeof prepareRequest>> | undefined;
      let claude: ClaudeProcess | undefined;
      let cwd: string | undefined;
      let toolUse = false;
      let lengthStop = false;
      let terminationCause: ClaudeTerminationCause = "none";
      let mapper: ClaudeEventMapper | undefined;
      let exitCode: number | null | undefined;
      let exitSignal: NodeJS.Signals | null | undefined;
      let errorCategory: string | undefined;
      let processLivenessUnknown = false;
      let finalized = false;
      const metrics: RequestMetrics = {
        schemaVersion: 5,
        timestamp: new Date(startedAt).toISOString(),
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        claudeVersion: installation.version,
        requestedModel: model.id,
        effort,
        messageCount: requestContext.messages.length,
        toolCount: requestContext.tools?.length ?? 0,
        sessionResolution: resolved?.resolution,
        imageCount: 0,
        transcriptBytes: 0,
        catalogBytes: 0,
        imageBytes: 0,
        estimatedInputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastPhase: "received",
        cleanupComplete: true,
        terminationExpected: false,
      };

      const cleanupPrepared = async (): Promise<void> => {
        if (!prepared || processLivenessUnknown) return;
        const current = prepared;
        await cleanupDirectory(current.directory);
        metrics.cleanupComplete = true;
        if (prepared === current) prepared = undefined;
      };

      const failureAfterCleanup = async (failure: string): Promise<string> => {
        try {
          await cleanupPrepared();
          return failure;
        } catch (cleanupError) {
          return appendCleanupFailure(failure, "private request", cleanupError);
        }
      };

      // Claude Code's headless protocol has no HTTP response to report, so a
      // validated initialization is announced with a synthetic success status
      // and no headers. Pi requires that an asynchronous observer finish
      // before its response body is mapped or published.
      const announceResponse = async (): Promise<void> => {
        const observe = options?.onResponse;
        if (!observe) return;
        const response: ProviderResponse = { status: 200, headers: {} };
        try {
          await observe(response, model);
        } catch (error) {
          errorCategory ??= "response_hook";
          throw new ClaudeCodeError("response_hook", `Pi after_provider_response handler failed: ${errorText(error)}`);
        }
      };

      const stopForToolUse = (): void => {
        if (toolUse || terminationCause === "caller_abort") return;
        toolUse = true;
        terminationCause = "tool_handoff";
        metrics.terminationExpected = true;
        claude?.terminateInBackground();
      };

      // A response that reached the output limit is complete as far as Pi is concerned.
      // Claude Code would answer it with a synthetic continuation turn and another
      // message, so stop it here and publish the length stop. The termination path, and
      // therefore the expected exit codes, are the tool handoff's.
      const stopForLength = (): void => {
        if (lengthStop || toolUse || terminationCause === "caller_abort") return;
        lengthStop = true;
        terminationCause = "tool_handoff";
        metrics.terminationExpected = true;
        claude?.terminateInBackground();
      };

      const finalizeLifecycle = async (): Promise<void> => {
        if (finalized) return;
        finalized = true;
        // Terminal stream publication belongs to the protocol boundary below;
        // this idempotent finalizer owns only request resources and metrics.
        claude?.dispose();
        try {
          await cleanupPrepared();
        } catch {
          errorCategory ??= "cleanup";
        }
        imageLease?.release(processLivenessUnknown);
        metrics.durationMs = Date.now() - startedAt;
        metrics.resolvedModel = output.responseModel;
        metrics.servedContextWindow = mapper?.contextWindow;
        metrics.servedMaxOutputTokens = mapper?.maxOutputTokens;
        metrics.cacheRead = output.usage.cacheRead;
        metrics.cacheWrite = output.usage.cacheWrite;
        metrics.inputTokens = output.usage.input;
        metrics.outputTokens = output.usage.output;
        // Cache-hit percentage is cache reads divided by Claude's complete
        // reported prompt usage, including new input and cache writes.
        const promptTokens = metrics.inputTokens + metrics.cacheRead + metrics.cacheWrite;
        metrics.cacheHitPercent = promptTokens > 0 ? Math.round((metrics.cacheRead * 10_000) / promptTokens) / 100 : undefined;
        metrics.stopReason = output.stopReason;
        metrics.errorCategory = errorCategory ?? (
          mapper?.cacheBreakpointLimit
            ? "cache_breakpoint_limit"
            : mapper?.rateLimitFailure
              ? "rate_limit"
              : output.stopReason === "error" ? "claude_error" : undefined
        );
        metrics.exitCode = exitCode;
        metrics.exitSignal = exitSignal;
        recordRequestMetrics(metrics);
      };

      try {
        // Phase 1 — prepare Pi's logical payload and private transport state.
        const effectiveContext = await applyPayloadHook(model, requestContext, options);
        metrics.lastPhase = "payload_applied";
        // A markerless tool-free request may borrow the newest live session for
        // a summary. The hook cannot turn that borrowed route into a tool-bearing
        // request, even if the process has only one registered session.
        if (resolved?.resolution === "oneshot" && (effectiveContext.tools?.length ?? 0) > 0) {
          throw new ClaudeCodeError(
            "working_directory",
            "Pi's tool-free request gained tools after before_provider_request; its working directory was only borrowed for a tool-free summary",
          );
        }
        cwd = await requireWorkingDirectory(session);
        if (leaseFailure) throw leaseFailure;
        metrics.messageCount = effectiveContext.messages.length;
        metrics.toolCount = effectiveContext.tools?.length ?? 0;
        const systemPromptBytes = Buffer.byteLength(effectiveContext.systemPrompt ?? "");
        const maxOutputTokens = effectiveMaxOutputTokens(model, options?.maxTokens);
        // Measured on the post-hook effective context and before preparation: a
        // system prompt no served model can hold is refused before any private
        // file exists, because nothing later in the request can make room for it.
        const systemPromptTokens = estimateTransportTokens(0, 0, systemPromptBytes, 0);
        metrics.estimatedInputTokens = systemPromptTokens;
        validateSystemPromptBudget(model, systemPromptTokens, maxOutputTokens);
        prepared = await prepareRequest(effectiveContext, imageLease);
        metrics.cleanupComplete = false;
        metrics.lastPhase = "prepared";
        const estimatedInputTokens = estimateTransportTokens(
          prepared.transcriptBytes,
          prepared.catalogBytes,
          systemPromptBytes,
          prepared.attachmentPaths.length,
        );
        metrics.imageCount = prepared.imageCount;
        metrics.transcriptBytes = prepared.transcriptBytes;
        metrics.catalogBytes = prepared.catalogBytes;
        metrics.imageBytes = prepared.imageBytes;
        metrics.estimatedInputTokens = estimatedInputTokens;
        validateContextBudget(model, estimatedInputTokens, maxOutputTokens);

        // Configuration must fail before a paid budget slot is claimed or a
        // Claude process is spawned.
        const configuredTotal = timeoutSetting("PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS", DEFAULT_TOTAL_TIMEOUT_MS);
        const requestedTotal = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : configuredTotal;
        const totalTimeoutMs = Math.min(requestedTotal, configuredTotal);
        const idleTimeoutMs = Math.min(
          timeoutSetting("PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS),
          totalTimeoutMs,
        );
        const readyTimeoutMs = Math.min(
          timeoutSetting("PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS", DEFAULT_MCP_READY_TIMEOUT_MS),
          totalTimeoutMs,
        );
        const { args, prompt } = providerArgs(prepared, model.id, effort, {
          // Pi asks for no cache write on its one-shot summaries, which are
          // unique per compaction, so the 1h entry this breakpoint writes would
          // never be read back and is charged at the doubled long-TTL rate.
          transcriptBreakpoint: transcriptBreakpointEnabled() && options?.cacheRetention !== "none",
          thinkingDisplay: thinkingDisplay(),
        });
        const expectedTools = new Set(prepared.toolNames.keys());
        mapper = new ClaudeEventMapper({
          stream,
          output,
          expectedTools,
          toolNames: prepared.toolNames,
          onToolUse: stopForToolUse,
          onLengthStop: stopForLength,
          onRateLimitNotice,
          onResponseAnnouncement: announceResponse,
          privatePaths: [prepared.directory, ...(prepared.imageStoreDirectory ? [prepared.imageStoreDirectory] : [])],
        });

        // Phase 2 — claim the launch, spawn Claude, and record exact ownership.
        // Pi can cancel before asynchronous preparation finishes. An aborted
        // request fails here without launching Claude or its MCP child, and the
        // catch path still removes the prepared private directory.
        await claimClaudeLaunch(options?.signal, claimLaunch);
        const running = spawnClaudeProcess({
          installation,
          args,
          env: {
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
            ...(prepared.catalogPath ? { PI_CLAUDE_TOOL_CATALOG: prepared.catalogPath } : {}),
          },
          directory: prepared.directory,
          privatePaths: prepared.imageStoreDirectory ? [prepared.imageStoreDirectory] : [],
          cwd,
          stdin: "pipe",
          idleTimeoutMs,
          totalTimeoutMs,
          signal: options?.signal,
          supervise,
          onFailure(error) {
            const vanished = vanishedWorkingDirectory(error, cwd);
            if (error instanceof ProcessTerminationError) errorCategory = "process_cleanup";
            else if (vanished) errorCategory = "working_directory";
            else errorCategory ??= "process";
            mapper?.fail((vanished ?? error).message, options?.signal?.aborted === true);
          },
          onAbort() {
            terminationCause = "caller_abort";
            errorCategory = "aborted";
            metrics.terminationExpected = true;
            mapper?.fail("Claude Code request was aborted", true);
          },
          onBackgroundTerminationFailure() {
            // The supervisor rejects wait() promptly on this same failure; the
            // catch path owns the complete, non-duplicated user message.
            errorCategory ??= "process_cleanup";
          },
        });
        claude = running;
        metrics.lastPhase = "spawned";
        await running.recordOwnership();

        // Phase 3 — consume and validate Claude's ordered JSONL protocol.
        const { child } = running;
        let recordProcessing = Promise.resolve();
        const failProtocol = (error: unknown): void => {
          if (mapper?.isTerminal) return;
          errorCategory ??= error instanceof ClaudeCodeError ? error.code : "protocol";
          mapper?.fail(errorText(error));
          running.terminateInBackground();
        };
        const parser = new JsonlParser((value) => {
          recordProcessing = recordProcessing
            .then(async () => {
              if (mapper?.isTerminal) return;
              running.supervisor.touch();
              mapper?.accept(value, terminationCause);
              await mapper?.settleResponseAnnouncement();
            })
            .catch((error: unknown) => failProtocol(error));
        });
        let resolveStdout: (() => void) | undefined;
        const stdoutDone = new Promise<void>((resolve) => {
          resolveStdout = resolve;
        });
        let stdoutFinished = false;
        const finishStdout = (): void => {
          if (stdoutFinished) return;
          stdoutFinished = true;
          try {
            parser.end();
          } catch (error) {
            failProtocol(error);
          }
          void recordProcessing.then(
            () => resolveStdout?.(),
            () => resolveStdout?.(),
          );
        };
        child.stdout?.on("data", (chunk: Buffer) => {
          try {
            parser.push(chunk);
          } catch (error) {
            failProtocol(error);
          }
        });
        child.stdout?.on("end", finishStdout);
        child.stdout?.once("close", finishStdout);
        if (!child.stdout) finishStdout();

        if (prepared.readyPath) {
          await waitForReadyOrExit(prepared.readyPath, readyTimeoutMs, options?.signal, running.supervisor.wait(), {
            bridgeArgv: bridgeArgv(prepared.bunConfigPath),
            stderr: () => running.stderrExcerpt(),
          });
          metrics.lastPhase = "mcp_ready";
        }
        if (child.exitCode === null && child.signalCode === null && !options?.signal?.aborted) {
          child.stdin?.end(
            `${JSON.stringify({
              type: "user",
              message: { role: "user", content: prompt },
            })}\n`,
          );
        }

        const result = await running.supervisor.wait();
        await stdoutDone;
        exitCode = result.code;
        exitSignal = result.signal;
        metrics.lastPhase = "process_exited";
        await running.terminate();

        // Phase 4 — validate the exit and private state before publishing success.
        const stderrDetail = (): string => {
          const excerpt = running.stderrExcerpt();
          return excerpt ? `: ${excerpt}` : "";
        };
        // Both handoffs settle identically: the provider terminated Claude on
        // purpose, so an already-terminal mapper only cleans up, an unaccepted exit
        // fails, and an accepted one publishes after cleanup. Only the accepted
        // exits, the completion call and the wording differ. Aliased because a
        // closure does not keep the narrowing this straight-line code has.
        const settling = mapper;
        const settleHandoff = async (label: string, exitAccepted: boolean, complete: () => boolean): Promise<void> => {
          if (settling.isTerminal) {
            await cleanupPrepared();
          } else if (!exitAccepted) {
            errorCategory = "process_exit";
            settling.fail(
              await failureAfterCleanup(
                `Claude Code ${label} exited unexpectedly (code ${String(result.code)}, signal ${String(result.signal)})`,
              ),
            );
          } else {
            await cleanupPrepared();
            if (complete()) metrics.lastPhase = "completed";
          }
        };
        if (toolUse) {
          // These two precede settlement and belong to the tool handoff alone:
          // an output limit proposes nothing that could have been executed or
          // aimed at private state.
          if (prepared.violationPath && (await pathExists(prepared.violationPath))) {
            errorCategory = "mcp_execution";
            mapper.fail(
              await failureAfterCleanup(
                "Security invariant violated: Claude Code attempted to execute a Pi proposal tool internally",
              ),
            );
          } else if (containsPrivateTransportToolArgument(output, [prepared.directory, ...(prepared.imageStoreDirectory ? [prepared.imageStoreDirectory] : [])])) {
            errorCategory = "private_transport";
            mapper.fail(
              await failureAfterCleanup("Claude Code proposed a Pi tool call against provider-private transport state"),
            );
          } else {
            await settleHandoff("tool handoff", isExpectedToolHandoffExit(result), () => settling.completeToolUse());
          }
        } else if (lengthStop) {
          // Claude Code can finish the continuation turn it starts after an output
          // limit and exit cleanly before the background termination lands. The
          // response Pi asked for is complete and already mapped by then, so
          // publish it rather than failing a turn that succeeded. completeLength()
          // still requires the max_tokens stop, so this widens nothing. In that
          // race the result record's usage covers the continuation turn too, which
          // is left as reported rather than corrected.
          const finishedBeforeTermination = mapper.hasSuccessfulResult && result.code === 0 && result.signal === null;
          await settleHandoff(
            "output limit handoff",
            isExpectedToolHandoffExit(result) || finishedBeforeTermination,
            () => settling.completeLength(),
          );
        } else if (mapper.hasSuccessfulResult) {
          if (result.code !== 0 || result.signal !== null) {
            errorCategory ??= "process_exit";
            mapper.fail(
              await failureAfterCleanup(
                `Claude Code exited after a successful result (code ${String(result.code)}, signal ${String(result.signal)})${stderrDetail()}`,
              ),
            );
          } else {
            await cleanupPrepared();
            if (mapper.completeResult()) metrics.lastPhase = "completed";
          }
        } else if (!mapper.isTerminal) {
          errorCategory ??= mapper.deferredFailure ? "tool_arguments" : mapper.rateLimitFailure ? "rate_limit" : "process_exit";
          mapper.fail(
            await failureAfterCleanup(
              mapper.deferredFailure ??
                mapper.rateLimitFailure ??
                `Claude Code exited before a terminal event (code ${String(result.code)}, signal ${String(result.signal)})${stderrDetail()}`,
            ),
          );
        }
      } catch (caught) {
        const error = vanishedWorkingDirectory(caught, cwd) ?? caught;
        if (error instanceof ProcessTerminationError) errorCategory = "process_cleanup";
        else errorCategory ??= error instanceof ClaudeCodeError
          ? error.code
          : options?.signal?.aborted
            ? "aborted"
            : claude?.isTerminationFailure(error)
              ? "process_cleanup"
              : "provider";
        const settled = await settleFailure(
          claude,
          error,
          errorText(error),
          "provider-private runtime state was retained because process death could not be established",
        );
        if (settled.livenessUnknown) processLivenessUnknown = true;
        let failure = settled.message;
        try {
          await cleanupPrepared();
        } catch (cleanupError) {
          errorCategory ??= "cleanup";
          failure = appendCleanupFailure(failure, "private request", cleanupError);
        }
        if (mapper) {
          if (mapper.isTerminal) {
            // A consumer may already have observed this terminal (notably on
            // abort), so the append is best-effort; finalized metrics are the
            // authoritative cleanup-status record.
            output.errorMessage = output.errorMessage ? `${output.errorMessage}; ${failure}` : failure;
          }
          else mapper.fail(failure, options?.signal?.aborted === true);
        }
        else {
          output.stopReason = options?.signal?.aborted ? "aborted" : "error";
          output.errorMessage = failure;
          stream.push({ type: "error", reason: output.stopReason, error: output });
          stream.end();
        }
      } finally {
        await finalizeLifecycle();
      }
    })();

    return stream;
  };
}

export function isExpectedToolHandoffExit(
  result: ProcessResult,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // POSIX cleanup can escalate to SIGKILL. Accept only signals the supervisor
  // successfully sent; an unsolicited signal must still fail the handoff.
  if (result.signal !== null) {
    return platform !== "win32" &&
      (result.signal === "SIGTERM" || result.signal === "SIGKILL") &&
      result.terminationSignals?.includes(result.signal) === true;
  }
  // Claude's POSIX handler exits 143; Windows taskkill /F exits 1. This check
  // runs only after the tool proposal and process cleanup have been validated.
  return platform === "win32" ? result.code === 1 : result.code === 143;
}

/**
 * Claude runs in Pi's session directory, not its private request directory.
 * Claude Code tells the model its process cwd is the primary working
 * directory; a private path there contradicts Pi's system prompt and
 * draws tool calls into provider state. An unusable directory therefore fails
 * before anything is prepared or launched, because substituting any other
 * directory would bring that contradiction back.
 */
async function requireWorkingDirectory(session: ResolvedSession | { error: string } | undefined): Promise<string> {
  if (session && "error" in session) throw new ClaudeCodeError("working_directory", session.error);
  const directory = session?.cwd;
  if (!directory) {
    throw new ClaudeCodeError(
      "working_directory",
      "Pi's session working directory is not available; the provider can only run inside a started Pi session",
    );
  }
  if (!isAbsolute(directory)) {
    throw new ClaudeCodeError("working_directory", `Pi's session working directory is not absolute: ${directory}`);
  }
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(directory)).isDirectory();
  } catch (error) {
    throw new ClaudeCodeError(
      "working_directory",
      `Pi's session working directory is unavailable: ${directory} (${errorCode(error) ?? errorText(error)}); restart Pi in an existing directory`,
    );
  }
  if (!isDirectory) {
    throw new ClaudeCodeError("working_directory", `Pi's session working directory is not a directory: ${directory}`);
  }
  return directory;
}

/**
 * A directory removed after validation makes spawn fail with ENOENT, which reads
 * as a missing Claude executable. Name the directory instead; never retry elsewhere.
 */
function vanishedWorkingDirectory(error: unknown, directory: string | undefined): ClaudeCodeError | undefined {
  if (!directory || errorCode(error) !== "ENOENT" || existsSync(directory)) return undefined;
  return new ClaudeCodeError(
    "working_directory",
    `Pi's session working directory disappeared before Claude Code could start: ${directory}; restart Pi in an existing directory`,
  );
}

function timeoutSetting(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new ClaudeCodeError("timeout_config", `${name} must be a positive integer number of milliseconds no greater than 2147483647`);
  }
  return value;
}

/**
 * Deliberately conservative pre-launch estimate: roughly 3 bytes per token
 * plus 10% margin and a flat per-image reserve. Overestimating rejects a
 * request early with `context_budget` instead of ever overrunning the served
 * window mid-stream. Metrics record this estimate beside Claude's reported
 * prompt counters (input + cacheRead + cacheWrite); calibrate against that
 * logged data across representative transcripts before changing the ratio.
 */
function estimateTransportTokens(transcriptBytes: number, catalogBytes: number, systemBytes: number, images: number): number {
  const textTokens = Math.ceil((transcriptBytes + catalogBytes + systemBytes) / 3);
  return Math.ceil(textTokens * 1.1) + images * 2_000;
}

function effectiveMaxOutputTokens(model: Model<Api>, requested: number | undefined): number {
  const value = Math.min(requested ?? model.maxTokens ?? 0, model.maxTokens ?? 0);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ClaudeCodeError("max_tokens", "Pi maxTokens must be a positive integer");
  }
  return value;
}

/**
 * A served context window is required rather than assumed. Skipping validation
 * when none is reported would leave the request with no bound at all, and
 * inventing a fallback ceiling would add a second unexplained limit that still
 * could not show the request fits a window nobody stated.
 *
 * Only positivity and finiteness are required, because the value is compared
 * and never propagated; a fractional override is harmless. Pi rejects a
 * non-positive `contextWindow` when a custom model is defined but not when one
 * overrides a registered model, so an override is the reachable cause here and
 * the message names it.
 */
function requireContextWindow(model: Model<Api>): number {
  const contextWindow = model.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new ClaudeCodeError(
      "context_window",
      `Pi model ${model.id} reports no usable context window (${String(contextWindow)}); ` +
        `a positive number is required. Check for a contextWindow override on this model in Pi's model configuration.`,
    );
  }
  return contextWindow;
}

/**
 * Reject a system prompt that cannot fit even alone. The wording deliberately
 * avoids `context_length_exceeded`: that phrase matches Pi's context-overflow
 * patterns, which would spend a summarization request compacting history that
 * can never make room for the system prompt.
 */
function validateSystemPromptBudget(model: Model<Api>, systemTokens: number, maxOutput: number): void {
  const contextWindow = requireContextWindow(model);
  if (systemTokens + maxOutput > contextWindow) {
    throw new ClaudeCodeError(
      "system_prompt_budget",
      `Pi system prompt alone needs about ${systemTokens} tokens; with the ${maxOutput}-token output reserve ` +
        `that exceeds the ${contextWindow}-token context of ${model.id}. Reduce loaded system instructions, ` +
        `project context, or skill descriptions, or select a larger-context model.`,
    );
  }
}

function validateContextBudget(model: Model<Api>, estimatedInputTokens: number, maxOutput: number): void {
  const contextWindow = requireContextWindow(model);
  if (estimatedInputTokens + maxOutput > contextWindow) {
    throw new ClaudeCodeError(
      "context_budget",
      `context_length_exceeded: estimated Claude Code transport input ${estimatedInputTokens} plus output reserve ${maxOutput} exceeds context ${contextWindow}`,
    );
  }
}

/** Evidence carried into a readiness failure, gathered only when one occurs. */
export interface ReadyDiagnostics {
  bridgeArgv?: readonly string[];
  /** A bounded, redacted excerpt of Claude Code's stderr so far, read lazily so a healthy request pays nothing. */
  stderr?: () => string;
}

/** Internal test seam for the MCP readiness race. */
export async function waitForReadyOrExit(
  path: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  processResult: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  diagnostics: ReadyDiagnostics = {},
): Promise<void> {
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let processError: unknown;
  void processResult.then(
    (result) => { exited = result; },
    (error) => { processError = error; },
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ClaudeCodeError("aborted", "Claude Code request was aborted");
    if (processError) throw processError;
    if (exited) {
      throw new ClaudeCodeError(
        "mcp_startup",
        `Claude Code exited before the Pi proposal MCP server became ready ` +
        `(code ${String(exited.code)}, signal ${String(exited.signal)})${readyDiagnosticSuffix(diagnostics)}`,
      );
    }
    if (await pathExists(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  // Name the resolved command: this timeout is far more often an unlaunchable
  // bridge than a slow one, and a bare duration sends people to the wrong knob.
  throw new ClaudeCodeError(
    "mcp_startup",
    `Pi proposal MCP server did not become ready within ${timeoutMs}ms${readyDiagnosticSuffix(diagnostics)}`,
  );
}

/**
 * Claude Code reports a failed MCP server in its initialization record, but in
 * print mode that record can arrive only after the prompt is written, which this
 * wait precedes. Its stderr is therefore the sole first-hand evidence available
 * at timeout, so carry it rather than leaving the duration to speak alone.
 */
function readyDiagnosticSuffix(diagnostics: ReadyDiagnostics): string {
  const command = diagnostics.bridgeArgv
    ? `; Claude Code was told to launch argv: ${formatBridgeArgv(diagnostics.bridgeArgv)}`
    : "";
  const captured = diagnostics.stderr?.().trim() ?? "";
  const stderr = captured ? `; Claude Code stderr: ${captured}` : "";
  return `${command}${stderr}; run /pi-claude-code-provider-doctor to complete the handshake directly`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function containsPrivateTransportToolArgument(output: MutableOutput, directories: readonly string[]): boolean {
  return output.content.some(
    (block) => block.type === "toolCall" && directories.some((directory) => containsPrivateTransportPath(block.arguments, directory)),
  );
}

function containsPrivateTransportPath(value: unknown, directory: string): boolean {
  if (typeof value === "string") return value.normalize("NFC").includes(directory.normalize("NFC"));
  if (Array.isArray(value)) return value.some((item) => containsPrivateTransportPath(item, directory));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsPrivateTransportPath(item, directory));
}

async function applyPayloadHook(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<Context> {
  const logical: LogicalProviderPayload = {
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: context.tools,
  };
  // Pi supplies this callback even when no extension handler replaces the
  // payload. Only the top-level shape is checked here, because the system-prompt
  // budget reads it before preparation; prepareRequest owns every per-message,
  // per-block, and per-tool rule.
  const replacement = await options?.onPayload?.(logical, model);
  return validateLogicalPayload(replacement === undefined ? logical : replacement);
}

function validateLogicalPayload(value: unknown): Context {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeCodeError("payload_invalid", "before_provider_request returned an invalid logical payload");
  }
  const payload = value as Partial<LogicalProviderPayload>;
  if (!Array.isArray(payload.messages)) {
    throw new ClaudeCodeError("payload_invalid", "Logical provider payload must contain a messages array");
  }
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) {
    throw new ClaudeCodeError("payload_invalid", "Logical provider payload tools must be an array");
  }
  if (payload.systemPrompt !== undefined && typeof payload.systemPrompt !== "string") {
    throw new ClaudeCodeError("payload_invalid", "Logical provider systemPrompt must be a string");
  }
  return { systemPrompt: payload.systemPrompt, messages: payload.messages, tools: payload.tools };
}
