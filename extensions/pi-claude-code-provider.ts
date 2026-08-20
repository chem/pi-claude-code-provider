import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, VERSION, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { inspectClaudeInstallation } from "../src/auth.ts";
import { providerModelsForSubscription } from "../src/catalog.ts";
import { bridgeCommand } from "../src/claude-args.ts";
import { VERIFIED_VERSIONS, platformStatus, versionStatus } from "../src/compatibility.ts";
import { writeDiagnosticReport } from "../src/diagnostics.ts";
import { errorText, normalizeClaudeOverflow } from "../src/errors.ts";
import { formatDoctorSummary, probeBridge } from "../src/doctor.ts";
import { flushMetricsLog, getLastRequestMetrics, getLastSearchMetrics, getMetricsLogError } from "../src/metrics.ts";
import { createClaudeStream } from "../src/provider.ts";
import { cleanupStaleRuntimeDirectories, createRuntimeDirectory } from "../src/runtime-directories.ts";
import { searchWithClaude } from "../src/web-search.ts";
import type { RateLimitNotice } from "../src/stream-events.ts";

const PROVIDER = "pi-claude-code-provider";
const SEARCH_TOOL = "pi_claude_code_provider_web_search";
const NOTICE_PREFIX = "[pi-claude-code-provider]";
const MAX_TRACKED_RATE_LIMIT_NOTICES = 64;

export default async function piClaudeCodeProvider(pi: ExtensionAPI): Promise<void> {
  const runtimeCleanup = await cleanupStaleRuntimeDirectories();
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
        // Prove the bridge actually runs. Everything else the doctor reports is
        // satisfied by an install whose proposal server can never start.
        const bridgeProbe = await probeBridge().catch((error: unknown) => ({
          ok: false,
          command: bridgeCommand(),
          detail: errorText(error),
        }));
        if (command === "report") {
          let current: Awaited<ReturnType<typeof inspectClaudeInstallation>> | undefined;
          let preflightError: unknown;
          try {
            current = await inspectClaudeInstallation();
          } catch (error) {
            preflightError = error;
          }
          const claudeStatus = current
            ? versionStatus("Claude Code", current.version, VERIFIED_VERSIONS.claudeCode)
            : undefined;
          const path = await writeDiagnosticReport({
            platformStatus: currentPlatform,
            piStatus,
            claudeStatus,
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
        ctx.ui.notify(
          formatDoctorSummary({
            platformStatus: currentPlatform,
            piStatus,
            claudeStatus,
            installation: current,
            modelIds: providerModelsForSubscription(current.subscriptionType).map((model) => model.id),
            metrics: getLastRequestMetrics(),
            metricsLogError: getMetricsLogError(),
            runtimeCleanup,
            bridgeProbe,
          }),
          bridgeProbe.ok && claudeStatus.isVerified && piStatus.isVerified && currentPlatform.isVerified ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });

  let installation: Awaited<ReturnType<typeof inspectClaudeInstallation>>;
  try {
    installation = await inspectClaudeInstallation();
  } catch (error) {
    registerUnavailableNotice(pi, errorText(error));
    return;
  }
  const providerModels = providerModelsForSubscription(installation.subscriptionType);
  const currentPlatform = platformStatus();
  let searchRegistered = false;
  let sessionClosing = true;
  let activeRateLimitNotify: ((notice: RateLimitNotice) => void) | undefined;
  // The provider spawns a Claude process per tool round-trip, so per-request
  // dedupe cannot suppress a notice Claude repeats across a single Pi turn.
  // Track emitted notices for the whole session instead; both the provider and
  // the web-search tool report through this one sink.
  const emittedRateLimitNotices = new Set<string>();
  const retainedSearchDirectories = new Set<string>();
  const pendingSearchRetentions = new Set<Promise<{ directory: string; path: string } | undefined>>();

  const retainSearchOutput = (result: string): Promise<{ directory: string; path: string } | undefined> => {
    if (sessionClosing) return Promise.resolve(undefined);
    // Register the promise synchronously so session shutdown can await a
    // directory whose asynchronous creation has started but not yet completed.
    const retention = (async () => {
      const directory = await createRuntimeDirectory("web_search_output");
      const path = join(directory, "result.md");
      try {
        await writeFile(path, result, { mode: 0o600, flag: "wx" });
        if (sessionClosing) {
          await rm(directory, { recursive: true, force: true });
          return undefined;
        }
        retainedSearchDirectories.add(directory);
        return { directory, path };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    })();
    pendingSearchRetentions.add(retention);
    void retention.then(
      () => pendingSearchRetentions.delete(retention),
      () => pendingSearchRetentions.delete(retention),
    );
    return retention;
  };

  pi.registerProvider(PROVIDER, {
    name: "Claude Code Subscription",
    baseUrl: "pi-claude-code-provider://local",
    apiKey: "pi-claude-code-provider-subscription",
    api: "pi-claude-code-provider-headless",
    models: providerModels,
    streamSimple: createClaudeStream(installation, undefined, (notice) => activeRateLimitNotify?.(notice)),
  });

  pi.on("session_start", (_event, ctx) => {
    sessionClosing = false;
    emittedRateLimitNotices.clear();
    activeRateLimitNotify = (notice) => {
      const key = JSON.stringify(notice);
      if (emittedRateLimitNotices.has(key)) return;
      // Utilization changes as a session progresses, so bound the retained keys
      // rather than letting one long session accumulate them without limit.
      if (emittedRateLimitNotices.size >= MAX_TRACKED_RATE_LIMIT_NOTICES) {
        const [oldest] = emittedRateLimitNotices;
        if (oldest !== undefined) emittedRateLimitNotices.delete(oldest);
      }
      emittedRateLimitNotices.add(key);
      ctx.ui.notify(formatRateLimitNotice(notice), "warning");
    };
    if (currentPlatform.warning) ctx.ui.notify(`${NOTICE_PREFIX} ${currentPlatform.warning}`, "warning");
    if (searchRegistered) return;
    if (pi.getAllTools().some((tool) => tool.name === SEARCH_TOOL)) {
      ctx.ui.notify(
        `${NOTICE_PREFIX} ${SEARCH_TOOL} was not registered because that tool name is already occupied`,
        "warning",
      );
      return;
    }
    pi.registerTool({
      name: SEARCH_TOOL,
      label: "Web Search",
      description:
        `Search the current web through Claude Code and return a concise synthesis with source URLs. Output is truncated to ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines.`,
      promptSnippet: "Search the current web and return sourced results",
      promptGuidelines: [`Use ${SEARCH_TOOL} when current external information or online sources are required.`],
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: "Search query" }),
        focus: Type.Optional(Type.String({ description: "Optional guidance about what to prioritize" })),
      }),
      async execute(_toolCallId, params, signal, onUpdate) {
        onUpdate?.({
          content: [{ type: "text", text: `Searching the web for: ${params.query}` }],
          details: { status: "searching" },
        });
        const result = await searchWithClaude(
          installation,
          params.query,
          params.focus,
          signal,
          undefined,
          undefined,
          undefined,
          (notice) => activeRateLimitNotify?.(notice),
        );
        const truncated = truncateHead(result, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
        let text = truncated.content;
        let fullOutputPath: string | undefined;
        if (truncated.truncated) {
          const retained = await retainSearchOutput(result);
          if (retained) {
            fullOutputPath = retained.path;
            text += `\n\n[Web-search output truncated to ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Full output: ${fullOutputPath}]`;
          }
        }
        return {
          content: [{ type: "text", text }],
          details: { truncated: truncated.truncated, fullOutputPath },
        };
      },
    });
    searchRegistered = true;
  });

  pi.on("session_shutdown", async () => {
    sessionClosing = true;
    activeRateLimitNotify = undefined;
    emittedRateLimitNotices.clear();
    try {
      await Promise.allSettled([...pendingSearchRetentions]);
      while (retainedSearchDirectories.size > 0) {
        const directories = [...retainedSearchDirectories];
        retainedSearchDirectories.clear();
        await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
      }
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
