import { open } from "node:fs/promises";
import type { RequestMetrics, SearchMetrics } from "./types.ts";

let lastRequestMetrics: RequestMetrics | undefined;
let lastSearchMetrics: SearchMetrics | undefined;
let metricsLogError: string | undefined;
let metricsLogGeneration = 0;
let metricsWriteTail: Promise<void> = Promise.resolve();

export function getLastRequestMetrics(): RequestMetrics | undefined {
  return lastRequestMetrics ? { ...lastRequestMetrics } : undefined;
}

export function getLastSearchMetrics(): SearchMetrics | undefined {
  return lastSearchMetrics ? { ...lastSearchMetrics } : undefined;
}

export function getMetricsLogError(): string | undefined {
  return metricsLogError;
}

export function recordRequestMetrics(metrics: RequestMetrics): void {
  lastRequestMetrics = { ...metrics };
  const generation = ++metricsLogGeneration;
  const path = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG?.trim();
  if (!path) {
    metricsLogError = undefined;
    return;
  }
  queueMetricsWrite(generation, () => appendRequestMetrics(path, metrics));
}

export function recordSearchMetrics(metrics: SearchMetrics): void {
  lastSearchMetrics = { ...metrics };
  const generation = ++metricsLogGeneration;
  const path = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG?.trim();
  if (!path) {
    metricsLogError = undefined;
    return;
  }
  queueMetricsWrite(generation, () => appendSearchMetrics(path, metrics));
}

/** Wait for every metrics append queued before or during this flush to settle. */
export async function flushMetricsLog(): Promise<void> {
  let pending: Promise<void>;
  do {
    pending = metricsWriteTail;
    await pending;
  } while (pending !== metricsWriteTail);
}

function queueMetricsWrite(generation: number, append: () => Promise<void>): void {
  const write = metricsWriteTail.then(append);
  // Keep later appends ordered even when one write fails, and retain a
  // non-rejecting tail so shutdown can always finish after recording the error.
  metricsWriteTail = write.then(
    () => {
      if (generation === metricsLogGeneration) metricsLogError = undefined;
    },
    (error: unknown) => {
      if (generation === metricsLogGeneration) metricsLogError = errorCode(error);
    },
  );
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "write_failed";
}

export function serializeRequestMetrics(metrics: RequestMetrics): string {
  return `${JSON.stringify(metrics)}\n`;
}

export function serializeSearchMetrics(metrics: SearchMetrics): string {
  return `${JSON.stringify({ kind: "web_search", ...metrics })}\n`;
}

export async function appendRequestMetrics(path: string, metrics: RequestMetrics): Promise<void> {
  await appendMetricsLine(path, serializeRequestMetrics(metrics));
}

export async function appendSearchMetrics(path: string, metrics: SearchMetrics): Promise<void> {
  await appendMetricsLine(path, serializeSearchMetrics(metrics));
}

async function appendMetricsLine(path: string, line: string): Promise<void> {
  const file = await open(path, "a", 0o600);
  try {
    await file.chmod(0o600);
    await file.appendFile(line, { encoding: "utf8" });
  } finally {
    await file.close();
  }
}
