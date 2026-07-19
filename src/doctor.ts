import type { VersionStatus } from "./compatibility.ts";
import type { RuntimeCleanupResult } from "./runtime-directories.ts";
import type { ClaudeInstallation, RequestMetrics } from "./types.ts";

export interface DoctorSummaryInput {
  platformStatus: VersionStatus;
  piStatus: VersionStatus;
  claudeStatus: VersionStatus;
  installation: ClaudeInstallation;
  modelIds: readonly string[];
  metrics?: RequestMetrics;
  metricsLogError?: string;
  runtimeCleanup: RuntimeCleanupResult;
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
    ? `; last request: ${metrics.requestedModel}/${metrics.effort}, ${metrics.messageCount} messages, ${metrics.estimatedInputTokens} estimated transport tokens, ${reportedUsage}, ${metrics.durationMs ?? 0}ms, ${metrics.stopReason ?? "unknown"}${metrics.errorCategory ? ` (${metrics.errorCategory})` : ""}`
    : "; no request metrics recorded yet";
  const metricsLogSummary = input.metricsLogError ? `; metrics log error: ${input.metricsLogError}` : "";
  const cleanupSummary = input.runtimeCleanup.removed > 0 || input.runtimeCleanup.failures > 0
    ? `; stale runtime cleanup: ${input.runtimeCleanup.removed} removed, ${input.runtimeCleanup.failures} ${input.runtimeCleanup.failures === 1 ? "failure" : "failures"}`
    : "";
  return `${verification}; Claude at ${input.installation.executable}; ${input.installation.subscriptionType} subscription; models: ${input.modelIds.join(", ")}${requestSummary}${metricsLogSummary}${cleanupSummary}`;
}
