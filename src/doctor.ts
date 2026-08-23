import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeEnvironment } from "./auth.ts";
import { bridgeArgv, bridgeLaunch, formatBridgeArgv } from "./claude-args.ts";
import type { VersionStatus } from "./compatibility.ts";
import { NEUTRAL_BUN_CONFIG, hostRuntimeDescription, needsBunConfig } from "./host-runtime.ts";
import { superviseProcess } from "./process-utils.ts";
import type { RuntimeCleanupResult } from "./runtime-directories.ts";
import type { ClaudeInstallation, RequestMetrics } from "./types.ts";

export interface BridgeProbeResult {
  ok: boolean;
  argv: string[];
  detail: string;
}

/**
 * Complete a real initialize plus tools/list handshake against the proposal bridge.
 * Version and path checks cannot detect a bridge that the hosting runtime refuses
 * to execute, which is exactly how the compiled standalone Pi build fails.
 */
export async function probeBridge(timeoutMs = 10_000): Promise<BridgeProbeResult> {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-bridge-probe-"));
  try {
    const catalogPath = join(directory, "catalog.json");
    const readyPath = join(directory, "ready");
    let bunConfigPath: string | undefined;
    if (needsBunConfig()) {
      bunConfigPath = join(directory, "bunfig.toml");
      await writeFile(bunConfigPath, NEUTRAL_BUN_CONFIG, { mode: 0o600 });
    }
    const launch = bridgeLaunch(bunConfigPath);
    const argv = bridgeArgv(bunConfigPath);
    await writeFile(catalogPath, JSON.stringify([{ name: "probe", description: "doctor probe", inputSchema: { type: "object" } }]), { mode: 0o600 });
    const child = spawn(launch.command, launch.args, {
      cwd: directory,
      // Mirror what Claude Code actually hands the bridge: its own filtered
      // environment plus the server env from --mcp-config. A probe with a richer
      // environment than production could pass where a real request fails.
      env: buildClaudeEnvironment({
        ...launch.env,
        PI_CLAUDE_TOOL_CATALOG: catalogPath,
        PI_CLAUDE_TOOL_READY: readyPath,
      }),
      // Own a process group like every other spawn here: superviseProcess cleans
      // up with kill(-pid), which must never reach a group this child does not lead.
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(0, 64 * 1024);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 4 * 1024);
    });
    const supervisor = superviseProcess(child, {
      idleTimeoutMs: timeoutMs,
      totalTimeoutMs: timeoutMs,
      onFailure(error) {
        failure ??= error.message;
      },
    });
    try {
      child.stdin?.end(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
      );
      await supervisor.wait();
    } finally {
      supervisor.dispose();
      await supervisor.terminate().catch(() => undefined);
    }
    const listed = stdout.split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as { id?: unknown; result?: { tools?: unknown } };
      } catch {
        return undefined;
      }
    });
    const tools = listed.find((message) => message?.id === 2)?.result?.tools;
    const ready = await readFile(readyPath, "utf8").then(() => true, () => false);
    if (!Array.isArray(tools) || tools.length !== 1 || !ready) {
      const cause = failure ?? stderr.trim();
      return {
        ok: false,
        argv,
        detail: `handshake failed (${Array.isArray(tools) ? `${tools.length} tools` : "no tools/list result"}, ready marker ${ready ? "written" : "missing"})${cause ? `: ${cause.slice(0, 256)}` : ""}`,
      };
    }
    return { ok: true, argv, detail: "handshake completed: 1 tool listed, ready marker written" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface DoctorSummaryInput {
  platformStatus: VersionStatus;
  piStatus: VersionStatus;
  claudeStatus: VersionStatus;
  installation: ClaudeInstallation;
  modelIds: readonly string[];
  metrics?: RequestMetrics;
  metricsLogError?: string;
  runtimeCleanup: RuntimeCleanupResult;
  bridgeProbe?: BridgeProbeResult;
}

export function formatDoctorSummary(input: DoctorSummaryInput): string {
  const verification = [input.platformStatus, input.piStatus, input.claudeStatus]
    .map(
      (status) =>
        `${status.component} ${status.current} (${status.isVerified ? "verified" : `unverified; tested ${status.verified}`})`,
    )
    .join("; ");
  const metrics = input.metrics;
  const reportedPromptTokens = metrics ? metrics.inputTokens + metrics.cacheRead + metrics.cacheWrite : 0;
  const reportedUsage =
    metrics && reportedPromptTokens > 0
      ? `reported usage: ${metrics.inputTokens} input, ${metrics.cacheRead} cache read, ${metrics.cacheWrite} cache write${metrics.cacheHitPercent === undefined ? "" : `, ${metrics.cacheHitPercent}% cache hit`}`
      : "reported token usage unavailable";
  const requestSummary = metrics
    ? `; last request: ${metrics.requestedModel}/${metrics.effort}, ${metrics.messageCount} messages, ${metrics.estimatedInputTokens} estimated transport tokens, ${reportedUsage}, ${metrics.durationMs ?? 0}ms, ${metrics.stopReason ?? "unknown"}${metrics.errorCategory ? ` (${metrics.errorCategory})` : ""}${metrics.cleanupComplete ? "" : ", cleanup incomplete"}`
    : "; no request metrics recorded yet";
  const metricsLogSummary = input.metricsLogError ? `; metrics log error: ${input.metricsLogError}` : "";
  const cleanupSummary = input.runtimeCleanup.removed > 0 || input.runtimeCleanup.failures > 0
    ? `; stale runtime cleanup: ${input.runtimeCleanup.removed} removed, ${input.runtimeCleanup.failures} ${input.runtimeCleanup.failures === 1 ? "failure" : "failures"}`
    : "";
  const bridgeSummary = input.bridgeProbe
    ? `; bridge ${input.bridgeProbe.ok ? "ok" : "BROKEN"} via ${formatBridgeArgv(input.bridgeProbe.argv)} (${input.bridgeProbe.detail})`
    : "";
  return `${verification}; runtime ${hostRuntimeDescription()}; Claude at ${input.installation.executable}; ${input.installation.subscriptionType} subscription; models: ${input.modelIds.join(", ")}${bridgeSummary}${requestSummary}${metricsLogSummary}${cleanupSummary}`;
}
