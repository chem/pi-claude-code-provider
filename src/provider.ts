import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderResponse,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildClaudeEnvironment, claudeLaunch } from "./auth.ts";
import { bridgeArgv, formatBridgeArgv, providerArgs } from "./claude-args.ts";
import { MAX_SYSTEM_PROMPT_BYTES, prepareRequest } from "./context-serializer.ts";
import { appendCleanupFailure, ClaudeCodeError, errorText } from "./errors.ts";
import { JsonlParser } from "./jsonl.ts";
import { recordRequestMetrics } from "./metrics.ts";
import { createOutput } from "./output.ts";
import { claimPaidTestLaunch } from "./paid-launch-budget.ts";
import { ProcessTerminationError, superviseProcess, terminateProcessGroup, type ProcessSupervisor } from "./process-utils.ts";
import { recordRuntimeChild, removeRuntimeDirectory } from "./runtime-directories.ts";
import type { RateLimitNoticeSink } from "./claude-protocol.ts";
import { ClaudeEventMapper, type ClaudeTerminationCause } from "./stream-events.ts";
import type { ClaudeInstallation, LogicalProviderPayload, MutableOutput, RequestMetrics } from "./types.ts";

const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MCP_READY_TIMEOUT_MS = 5_000;
// Bound the stderr excerpt carried into a readiness failure; the full stream is
// already capped, and an error message is not a log.
const READY_STDERR_BYTES = 1_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;
/** Internal dependency seam for deterministic cleanup-failure tests. */
type CleanupDirectory = (directory: string) => Promise<void>;

/** Internal dependency seam for deterministic abort-timing tests. */
type ClaimLaunch = () => Promise<void>;

export interface ClaudeStreamDependencies {
  cleanupDirectory?: CleanupDirectory;
  onRateLimitNotice?: RateLimitNoticeSink;
  claimLaunch?: ClaimLaunch;
  supervise?: typeof superviseProcess;
}

export function createClaudeStream(
  installation: ClaudeInstallation,
  dependencies: ClaudeStreamDependencies = {},
) {
  const cleanupDirectory = dependencies.cleanupDirectory ?? removeRuntimeDirectory;
  const onRateLimitNotice = dependencies.onRateLimitNotice;
  const claimLaunch = dependencies.claimLaunch ?? claimPaidTestLaunch;
  const supervise = dependencies.supervise ?? superviseProcess;
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);

    void (async () => {
      const startedAt = Date.now();
      const effort = options?.reasoning ?? "medium";
      let prepared: Awaited<ReturnType<typeof prepareRequest>> | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      let supervisor: ProcessSupervisor | undefined;
      let abortHandler: (() => void) | undefined;
      let toolUse = false;
      let terminationCause: ClaudeTerminationCause = "none";
      let stderr = "";
      let mapper: ClaudeEventMapper | undefined;
      let exitCode: number | null | undefined;
      let exitSignal: NodeJS.Signals | null | undefined;
      let errorCategory: string | undefined;
      let terminationFailure: unknown;
      let processLivenessUnknown = false;
      let finalized = false;
      const metrics: RequestMetrics = {
        schemaVersion: 4,
        timestamp: new Date(startedAt).toISOString(),
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        claudeVersion: installation.version,
        requestedModel: model.id,
        effort,
        messageCount: context.messages.length,
        toolCount: context.tools?.length ?? 0,
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

      const terminateCurrent = async (): Promise<void> => {
        try {
          if (supervisor) await supervisor.terminate();
          else if (child) await terminateProcessGroup(child);
        } catch (error) {
          terminationFailure ??= error;
          throw error;
        }
      };

      const terminateInBackground = (): void => {
        void terminateCurrent().catch(() => {
          errorCategory ??= "process_cleanup";
          // The shared supervisor rejects wait() promptly on this same failure;
          // the main catch path owns the complete, non-duplicated user message.
        });
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
        terminateInBackground();
      };

      const finalizeLifecycle = async (): Promise<void> => {
        if (finalized) return;
        finalized = true;
        // Terminal stream publication belongs to the protocol boundary below;
        // this idempotent finalizer owns only request resources and metrics.
        if (abortHandler) options?.signal?.removeEventListener("abort", abortHandler);
        supervisor?.dispose();
        try {
          await cleanupPrepared();
        } catch {
          errorCategory ??= "cleanup";
        }
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
        metrics.errorCategory =
          errorCategory ?? (mapper?.rateLimitFailure ? "rate_limit" : output.stopReason === "error" ? "claude_error" : undefined);
        metrics.exitCode = exitCode;
        metrics.exitSignal = exitSignal;
        recordRequestMetrics(metrics);
      };

      try {
        // Phase 1 — prepare Pi's logical payload and private transport state.
        const effectiveContext = await applyPayloadHook(model, context, options);
        metrics.lastPhase = "payload_applied";
        metrics.messageCount = effectiveContext.messages.length;
        metrics.toolCount = effectiveContext.tools?.length ?? 0;
        const systemPromptBytes = Buffer.byteLength(effectiveContext.systemPrompt ?? "");
        if (systemPromptBytes > MAX_SYSTEM_PROMPT_BYTES) {
          throw new ClaudeCodeError(
            "system_prompt_size",
            `Pi system prompt is ${systemPromptBytes} bytes; the supported limit is ${MAX_SYSTEM_PROMPT_BYTES}`,
          );
        }
        prepared = await prepareRequest(effectiveContext);
        metrics.cleanupComplete = false;
        metrics.lastPhase = "prepared";
        const estimatedInputTokens = estimateTransportTokens(
          prepared.transcriptBytes,
          prepared.catalogBytes,
          systemPromptBytes,
          prepared.attachmentPaths.length,
        );
        metrics.imageCount = prepared.attachmentPaths.length;
        metrics.transcriptBytes = prepared.transcriptBytes;
        metrics.catalogBytes = prepared.catalogBytes;
        metrics.imageBytes = prepared.imageBytes;
        metrics.estimatedInputTokens = estimatedInputTokens;
        const maxOutputTokens = effectiveMaxOutputTokens(model, options?.maxTokens);
        validateContextBudget(model, estimatedInputTokens, maxOutputTokens);
        const { args, prompt } = providerArgs(prepared, model.id, effort);
        const expectedTools = new Set(prepared.toolNames.keys());
        mapper = new ClaudeEventMapper({
          stream,
          output,
          expectedTools,
          toolNames: prepared.toolNames,
          onToolUse: stopForToolUse,
          onRateLimitNotice,
          onResponseAnnouncement: announceResponse,
          privatePaths: [prepared.directory],
        });

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

        // Phase 2 — claim the launch, spawn Claude, and record exact ownership.
        // Pi can cancel before asynchronous request preparation finishes. Do
        // not briefly launch Claude or its MCP child for an already-dead turn;
        // the finally path still removes the prepared private directory.
        if (options?.signal?.aborted) {
          errorCategory = "aborted";
          mapper.fail("Claude Code request was aborted", true);
          return;
        }

        await claimLaunch();
        // The claim can suspend, and an abort while it was pending has no
        // listener yet; re-check so a dead turn never pays for a spawn.
        if (options?.signal?.aborted) {
          errorCategory = "aborted";
          mapper.fail("Claude Code request was aborted", true);
          return;
        }
        const launch = claudeLaunch(installation.executable, args);
        child = spawn(launch.command, launch.args, {
          cwd: prepared.directory,
          env: buildClaudeEnvironment({
            ...launch.env,
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
            ...(prepared.catalogPath ? { PI_CLAUDE_TOOL_CATALOG: prepared.catalogPath } : {}),
          }),
          detached: process.platform !== "win32",
          windowsHide: process.platform === "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        metrics.lastPhase = "spawned";
        supervisor = supervise(child, {
          idleTimeoutMs,
          totalTimeoutMs,
          onFailure(error) {
            if (error instanceof ProcessTerminationError) errorCategory = "process_cleanup";
            else errorCategory ??= "process";
            mapper?.fail(error.message, options?.signal?.aborted === true);
          },
        });

        // Register cancellation before any further await so no abort can land
        // between the spawn and its listener.
        abortHandler = (): void => {
          terminationCause = "caller_abort";
          errorCategory = "aborted";
          metrics.terminationExpected = true;
          mapper?.fail("Claude Code request was aborted", true);
          terminateInBackground();
        };
        options?.signal?.addEventListener("abort", abortHandler, { once: true });
        if (options?.signal?.aborted) abortHandler();

        await recordRuntimeChild(prepared.directory, child.pid ?? 0);

        // Phase 3 — consume and validate Claude's ordered JSONL protocol.
        let recordProcessing = Promise.resolve();
        const failProtocol = (error: unknown): void => {
          if (mapper?.isTerminal) return;
          errorCategory ??= error instanceof ClaudeCodeError ? error.code : "protocol";
          mapper?.fail(errorText(error));
          terminateInBackground();
        };
        const parser = new JsonlParser((value) => {
          recordProcessing = recordProcessing
            .then(async () => {
              if (mapper?.isTerminal) return;
              supervisor?.touch();
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
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
        });

        if (prepared.readyPath) {
          await waitForReadyOrExit(prepared.readyPath, readyTimeoutMs, options?.signal, supervisor.wait(), {
            bridgeArgv: bridgeArgv(prepared.bunConfigPath),
            stderr: () => stderr,
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

        const result = await supervisor.wait();
        await stdoutDone;
        await new Promise<void>((resolve) => setImmediate(resolve));
        exitCode = result.code;
        exitSignal = result.signal;
        metrics.lastPhase = "process_exited";
        await terminateCurrent();

        // Phase 4 — validate the exit and private state before publishing success.
        if (toolUse) {
          if (prepared.violationPath && (await pathExists(prepared.violationPath))) {
            errorCategory = "mcp_execution";
            mapper.fail(
              await failureAfterCleanup(
                "Security invariant violated: Claude Code attempted to execute a Pi proposal tool internally",
              ),
            );
          } else if (containsPrivateTransportToolArgument(output, prepared.directory)) {
            errorCategory = "private_transport";
            mapper.fail(
              await failureAfterCleanup("Claude Code proposed a Pi tool call against provider-private transport state"),
            );
          } else if (mapper.isTerminal) {
            await cleanupPrepared();
          } else if (!isExpectedToolHandoffExit(result)) {
            errorCategory = "process_exit";
            mapper.fail(
              await failureAfterCleanup(
                `Claude Code tool handoff exited unexpectedly (code ${String(result.code)}, signal ${String(result.signal)})`,
              ),
            );
          } else {
            await cleanupPrepared();
            if (mapper.completeToolUse()) metrics.lastPhase = "completed";
          }
        } else if (mapper.hasSuccessfulResult) {
          if (result.code !== 0 || result.signal !== null) {
            errorCategory ??= "process_exit";
            const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
            mapper.fail(
              await failureAfterCleanup(
                `Claude Code exited after a successful result (code ${String(result.code)}, signal ${String(result.signal)})${detail}`,
              ),
            );
          } else {
            await cleanupPrepared();
            if (mapper.completeResult()) metrics.lastPhase = "completed";
          }
        } else if (!mapper.isTerminal) {
          errorCategory ??= mapper.rateLimitFailure ? "rate_limit" : "process_exit";
          const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
          mapper.fail(
            await failureAfterCleanup(
              mapper.rateLimitFailure ??
                `Claude Code exited before a terminal event (code ${String(result.code)}, signal ${String(result.signal)})${detail}`,
            ),
          );
        }
      } catch (error) {
        if (error instanceof ProcessTerminationError) {
          processLivenessUnknown = true;
          errorCategory = "process_cleanup";
        } else errorCategory ??= error instanceof ClaudeCodeError
          ? error.code
          : options?.signal?.aborted
            ? "aborted"
            : error === terminationFailure
              ? "process_cleanup"
              : "provider";
        let failure = errorText(error);
        if (error instanceof ProcessTerminationError) {
          failure += "; provider-private runtime state was retained because process death could not be established";
        }
        if (!(error instanceof ProcessTerminationError)) {
          try {
            await terminateCurrent();
          } catch (terminationError) {
            if (terminationError instanceof ProcessTerminationError) processLivenessUnknown = true;
            if (terminationError !== error) {
              failure = appendCleanupFailure(failure, "Claude Code process tree", terminationError);
            }
          }
        }
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
  result: { code: number | null; signal: NodeJS.Signals | null },
  platform: NodeJS.Platform = process.platform,
): boolean {
  // A correlated provider-owned handoff closes as code 143 on POSIX. Windows
  // taskkill /F closes the owned Claude root as code 1. These codes are accepted
  // only from the tool-handoff path after cleanup and proposal validation.
  if (result.signal !== null) return false;
  return platform === "win32" ? result.code === 1 : result.code === 143;
}

function timeoutSetting(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ClaudeCodeError("timeout_config", `${name} must be a positive integer number of milliseconds`);
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

function validateContextBudget(model: Model<Api>, estimatedInputTokens: number, maxOutput: number): void {
  const contextWindow = model.contextWindow ?? 0;
  if (contextWindow > 0 && estimatedInputTokens + maxOutput > contextWindow) {
    throw new ClaudeCodeError(
      "context_budget",
      `context_length_exceeded: estimated Claude Code transport input ${estimatedInputTokens} plus output reserve ${maxOutput} exceeds context ${contextWindow}`,
    );
  }
}

/** Evidence carried into a readiness failure, gathered only when one occurs. */
export interface ReadyDiagnostics {
  bridgeArgv?: readonly string[];
  /** Claude Code's stderr so far, read lazily so a healthy request pays nothing. */
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
  const stderr = captured ? `; Claude Code stderr: ${captured.slice(-READY_STDERR_BYTES)}` : "";
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

function containsPrivateTransportToolArgument(output: MutableOutput, directory: string): boolean {
  return output.content.some(
    (block) => block.type === "toolCall" && containsPrivateTransportPath(block.arguments, directory),
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
  // payload. Validate the effective post-callback object here; serialization
  // remains a separate fail-closed defense for direct/internal callers.
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
  for (const message of payload.messages as unknown[]) validateLogicalMessage(message);
  for (const tool of (payload.tools ?? []) as unknown[]) validateLogicalTool(tool);
  return { systemPrompt: payload.systemPrompt, messages: payload.messages, tools: payload.tools };
}

function validateLogicalMessage(value: unknown): void {
  const message = logicalObject(value, "message");
  if (message.role === "user") {
    if (typeof message.content === "string") return;
    validateContent(message.content, new Set(["text", "image"]), "user");
    return;
  }
  if (message.role === "assistant") {
    validateContent(message.content, new Set(["text", "thinking", "toolCall"]), "assistant");
    return;
  }
  if (message.role === "toolResult") {
    nonemptyString(message.toolCallId, "tool-result ID");
    nonemptyString(message.toolName, "tool-result name");
    if (typeof message.isError !== "boolean") invalidPayload("Tool-result isError must be boolean");
    validateContent(message.content, new Set(["text", "image"]), "toolResult");
    return;
  }
  invalidPayload(`Unsupported logical message role: ${String(message.role)}`);
}

function validateContent(value: unknown, allowed: ReadonlySet<string>, role: string): void {
  if (!Array.isArray(value)) invalidPayload(`Logical ${role} content must be an array`);
  for (const valueBlock of value) {
    const block = logicalObject(valueBlock, `${role} content block`);
    if (typeof block.type !== "string" || !allowed.has(block.type)) {
      invalidPayload(`Unsupported logical ${role} content block: ${String(block.type)}`);
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") invalidPayload("Logical text content must contain text");
    } else if (block.type === "thinking") {
      if (typeof block.thinking !== "string") invalidPayload("Logical thinking content must contain thinking");
      if (block.redacted !== undefined && typeof block.redacted !== "boolean") invalidPayload("Logical thinking redacted must be boolean");
    } else if (block.type === "toolCall") {
      nonemptyString(block.id, "tool-call ID");
      nonemptyString(block.name, "tool-call name");
      serializableObject(block.arguments, "tool-call arguments");
    } else if (block.type === "image") {
      if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
        invalidPayload("Logical image content must contain string data and mimeType");
      }
    }
  }
}

function validateLogicalTool(value: unknown): void {
  const tool = logicalObject(value, "tool");
  nonemptyString(tool.name, "tool name");
  if (typeof tool.description !== "string") invalidPayload("Logical tool description must be a string");
  serializableObject(tool.parameters, "tool schema");
}

function logicalObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidPayload(`Logical ${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || !value.trim()) invalidPayload(`Logical ${label} must be a nonempty string`);
}

function serializableObject(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidPayload(`Logical ${label} must be an object`);
  try {
    if (typeof JSON.stringify(value) !== "string") invalidPayload(`Logical ${label} must be JSON-serializable`);
  } catch {
    invalidPayload(`Logical ${label} must be JSON-serializable`);
  }
}

function invalidPayload(message: string): never {
  throw new ClaudeCodeError("payload_invalid", message);
}
