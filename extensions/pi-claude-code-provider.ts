import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, VERSION, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { inspectClaudeInstallation } from "../src/auth.ts";
import { providerModelsForSubscription } from "../src/catalog.ts";
import { bridgeArgv } from "../src/claude-args.ts";
import { VERIFIED_VERSIONS, platformStatus, versionStatus } from "../src/compatibility.ts";
import { writeDiagnosticReport } from "../src/diagnostics.ts";
import { errorText, normalizeClaudeOverflow } from "../src/errors.ts";
import { formatDoctorSummary, probeBridge } from "../src/doctor.ts";
import { flushMetricsLog, getLastRequestMetrics, getLastSearchMetrics, getMetricsLogError } from "../src/metrics.ts";
import { createClaudeStream } from "../src/provider.ts";
import { cleanupStaleRuntimeDirectories, createRuntimeDirectory } from "../src/runtime-directories.ts";
import { searchWithClaude } from "../src/web-search.ts";
import type { RateLimitNotice } from "../src/claude-protocol.ts";
import type { RuntimeCleanupResult } from "../src/runtime-directories.ts";
import type { ClaudeInstallation } from "../src/types.ts";

const PROVIDER = "pi-claude-code-provider";
const SEARCH_TOOL = "pi_claude_code_provider_web_search";
const NOTICE_PREFIX = "[pi-claude-code-provider]";
const MAX_TRACKED_RATE_LIMIT_NOTICES = 64;

export default async function piClaudeCodeProvider(pi: ExtensionAPI): Promise<void> {
  const runtimeCleanup = await cleanupStaleRuntimeDirectories();
  registerDoctorCommand(pi, runtimeCleanup);

  let installation: ClaudeInstallation;
  try {
    installation = await inspectClaudeInstallation();
  } catch (error) {
    registerUnavailableNotice(pi, errorText(error));
    return;
  }
  const providerModels = providerModelsForSubscription(installation.subscriptionType);
  const currentPlatform = platformStatus();
  const searchOutputs = createSearchOutputOwner();
  let searchRegistrationAttempted = false;
  let activeRateLimitNotify: ((notice: RateLimitNotice) => void) | undefined;

  pi.registerProvider(PROVIDER, {
    name: "Claude Code Subscription",
    baseUrl: "pi-claude-code-provider://local",
    apiKey: "pi-claude-code-provider-subscription",
    api: "pi-claude-code-provider-headless",
    models: providerModels,
    streamSimple: createClaudeStream(installation, {
      onRateLimitNotice: (notice) => activeRateLimitNotify?.(notice),
    }),
  });

  pi.on("session_start", (_event, ctx) => {
    searchOutputs.open();
    activeRateLimitNotify = createRateLimitNotifier((message) => ctx.ui.notify(message, "warning"));
    if (currentPlatform.warning) ctx.ui.notify(`${NOTICE_PREFIX} ${currentPlatform.warning}`, "warning");
    if (searchRegistrationAttempted) return;
    searchRegistrationAttempted = true;
    registerWebSearchTool(
      pi,
      installation,
      searchOutputs.retain,
      (notice) => activeRateLimitNotify?.(notice),
      (message) => ctx.ui.notify(message, "warning"),
    );
  });

  pi.on("session_shutdown", async () => {
    activeRateLimitNotify = undefined;
    try {
      await searchOutputs.close();
    } finally {
      await flushMetricsLog();
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const assistant = message as AssistantMessage;
    if (assistant.provider !== PROVIDER && ctx.model?.provider !== PROVIDER) return;
    const errorMessage = assistant.errorMessage ?? "";
    const normalized = normalizeClaudeOverflow(errorMessage);
    if (normalized === errorMessage) return;
    return { message: { ...assistant, errorMessage: normalized } };
  });
}

function registerDoctorCommand(pi: ExtensionAPI, runtimeCleanup: RuntimeCleanupResult): void {
  pi.registerCommand("pi-claude-code-provider-doctor", {
    description: "Check Claude Code compatibility or write a diagnostic report",
    handler: async (args, ctx) => {
      try {
        const command = args.trim();
        if (command && command !== "report") {
          ctx.ui.notify("Usage: /pi-claude-code-provider-doctor [report]", "error");
          return;
        }
        const currentPlatform = platformStatus();
        const piStatus = versionStatus("Pi", VERSION, VERIFIED_VERSIONS.pi);
        const bridgeProbe = await probeBridge().catch((error: unknown) => ({
          ok: false,
          argv: bridgeArgv(),
          detail: errorText(error),
        }));
        if (command === "report") {
          let current: ClaudeInstallation | undefined;
          let preflightError: unknown;
          try { current = await inspectClaudeInstallation(); } catch (error) { preflightError = error; }
          const path = await writeDiagnosticReport({
            platformStatus: currentPlatform,
            piStatus,
            claudeStatus: current ? versionStatus("Claude Code", current.version, VERIFIED_VERSIONS.claudeCode) : undefined,
            installation: current,
            preflightError,
            metrics: getLastRequestMetrics(),
            searchMetrics: getLastSearchMetrics(),
            metricsLogError: getMetricsLogError(),
            runtimeCleanup,
            bridgeProbe,
          });
          ctx.ui.notify(
            `Claude Code diagnostic report written to ${path}${preflightError ? "; preflight failed, so installation details may be incomplete" : ""}`,
            preflightError ? "warning" : "info",
          );
          return;
        }
        const current = await inspectClaudeInstallation();
        const claudeStatus = versionStatus("Claude Code", current.version, VERIFIED_VERSIONS.claudeCode);
        ctx.ui.notify(formatDoctorSummary({
          platformStatus: currentPlatform,
          piStatus,
          claudeStatus,
          installation: current,
          modelIds: providerModelsForSubscription(current.subscriptionType).map((model) => model.id),
          metrics: getLastRequestMetrics(),
          metricsLogError: getMetricsLogError(),
          runtimeCleanup,
          bridgeProbe,
        }), bridgeProbe.ok && claudeStatus.isVerified && piStatus.isVerified && currentPlatform.isVerified ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });
}

function createRateLimitNotifier(notify: (message: string) => void): (notice: RateLimitNotice) => void {
  const emitted = new Set<string>();
  return (notice) => {
    const key = JSON.stringify(notice);
    if (emitted.has(key)) return;
    if (emitted.size >= MAX_TRACKED_RATE_LIMIT_NOTICES) {
      const [oldest] = emitted;
      if (oldest !== undefined) emitted.delete(oldest);
    }
    emitted.add(key);
    notify(formatRateLimitNotice(notice));
  };
}

function createSearchOutputOwner() {
  let closing = true;
  const retained = new Set<string>();
  const pending = new Set<Promise<{ directory: string; path: string } | undefined>>();
  const retain = (result: string): Promise<{ directory: string; path: string } | undefined> => {
    if (closing) return Promise.resolve(undefined);
    const retention = (async () => {
      const directory = await createRuntimeDirectory("web_search_output");
      const path = join(directory, "result.md");
      try {
        await writeFile(path, result, { mode: 0o600, flag: "wx" });
        if (closing) {
          await rm(directory, { recursive: true, force: true });
          return undefined;
        }
        retained.add(directory);
        return { directory, path };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    })();
    pending.add(retention);
    void retention.finally(() => pending.delete(retention)).catch(() => undefined);
    return retention;
  };
  return {
    open: () => { closing = false; },
    retain,
    async close(): Promise<void> {
      closing = true;
      await Promise.allSettled([...pending]);
      while (retained.size > 0) {
        const directories = [...retained];
        retained.clear();
        await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
      }
    },
  };
}

function registerWebSearchTool(
  pi: ExtensionAPI,
  installation: ClaudeInstallation,
  retainOutput: (result: string) => Promise<{ directory: string; path: string } | undefined>,
  onRateLimitNotice: (notice: RateLimitNotice) => void,
  notify: (message: string) => void,
): void {
  if (pi.getAllTools().some((tool) => tool.name === SEARCH_TOOL)) {
    notify(`${NOTICE_PREFIX} ${SEARCH_TOOL} was not registered because that tool name is already occupied`);
    return;
  }
  pi.registerTool({
    name: SEARCH_TOOL,
    label: "Web Search",
    description: `Search the current web through Claude Code and return a concise synthesis with source URLs. Output is truncated to ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines.`,
    promptSnippet: "Search the current web and return sourced results",
    promptGuidelines: [`Use ${SEARCH_TOOL} when current external information or online sources are required.`],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Search query" }),
      focus: Type.Optional(Type.String({ description: "Optional guidance about what to prioritize" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: `Searching the web for: ${params.query}` }], details: { status: "searching" } });
      const result = await searchWithClaude(
        installation,
        { query: params.query, focus: params.focus, signal },
        { onRateLimitNotice },
      );
      const truncated = truncateHead(result, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      let text = truncated.content;
      let fullOutputPath: string | undefined;
      if (truncated.truncated) {
        const output = await retainOutput(result);
        if (output) {
          fullOutputPath = output.path;
          text += `\n\n[Web-search output truncated to ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Full output: ${fullOutputPath}]`;
        }
      }
      return { content: [{ type: "text", text }], details: { truncated: truncated.truncated, fullOutputPath } };
    },
  });
}

/**
 * Claude reports an absolute reset instant, and windows run as long as seven
 * days, so a bare wall-clock time is ambiguous rather than merely terse.
 */
function formatResetInstant(resetsAt: number): string {
  return new Date(resetsAt).toLocaleString();
}

function formatRateLimitNotice(notice: RateLimitNotice): string {
  const reset = notice.resetsAt === undefined
    ? ""
    : `; resets at ${formatResetInstant(notice.resetsAt)}`;
  // An overage-typed notice reports the overage reset as its primary reset, so
  // the mapper never supplies a separate overage reset in that case.
  const overageReset = notice.overageResetsAt === undefined
    ? ""
    : `; overage resets at ${formatResetInstant(notice.overageResetsAt)}`;
  const overage = notice.overageStatus === undefined
    ? ""
    : `; overage ${notice.overageStatus}${notice.overageDisabledReason ? ` (${notice.overageDisabledReason})` : ""}`;
  const usingOverage = notice.isUsingOverage ? "; using overage" : "";
  if (notice.status === "rejected") {
    return `${NOTICE_PREFIX} Claude rate limited (${notice.rateLimitType})${reset}${overageReset}${overage}${usingOverage}`;
  }
  const usage = notice.utilization === undefined
    ? "usage is approaching the limit"
    : `${Math.floor(notice.utilization * 100)}% used`;
  // Match Claude Code's current whole-percent display while preserving the
  // fractional utilization in the protocol mapper for future consumers.
  return `${NOTICE_PREFIX} Claude rate limit warning: ${usage} (${notice.rateLimitType})${reset}${overageReset}${overage}${usingOverage}`;
}

function registerUnavailableNotice(pi: ExtensionAPI, reason: string): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      `${NOTICE_PREFIX} Claude Code provider is unavailable: ${reason}. Run /pi-claude-code-provider-doctor, then /reload after correcting the problem.`,
      "error",
    );
  });
}
