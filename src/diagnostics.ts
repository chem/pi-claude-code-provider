import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, release, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { VersionStatus } from "./compatibility.ts";
import { ClaudeCodeError } from "./errors.ts";
import type { RuntimeCleanupResult } from "./runtime-directories.ts";
import type { ClaudeInstallation, RequestMetrics, SearchMetrics } from "./types.ts";

const execFileAsync = promisify(execFile);
const MAX_REPORT_BYTES = 64 * 1024;

export interface DiagnosticReportInput {
  platformStatus: VersionStatus;
  piStatus: VersionStatus;
  claudeStatus?: VersionStatus;
  installation?: ClaudeInstallation;
  preflightError?: unknown;
  metrics?: RequestMetrics;
  searchMetrics?: SearchMetrics;
  metricsLogError?: string;
  runtimeCleanup: RuntimeCleanupResult;
}

/** Write a bounded, content-free report to a new private temp directory. */
export async function writeDiagnosticReport(input: DiagnosticReportInput): Promise<string> {
  const lexicalTempRoot = tmpdir();
  const physicalTempRoot = await realpath(lexicalTempRoot).catch(() => lexicalTempRoot);
  const [macosVersion, bashVersion, zshVersion, argMax] = await Promise.all([
    process.platform === "darwin" ? probe("/usr/bin/sw_vers", ["-productVersion"]) : undefined,
    probe("/bin/bash", ["--version"]),
    probe("/bin/zsh", ["--version"]),
    probe("/usr/bin/getconf", ["ARG_MAX"]),
  ]);
  const report = {
    schema: "pi-claude-code-provider-diagnostics-v1",
    generatedAt: new Date().toISOString(),
    system: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      kernelRelease: release(),
      macosVersion,
      shell: sanitize(process.env.SHELL?.trim() || undefined, lexicalTempRoot, physicalTempRoot),
      bashVersion,
      zshVersion,
      argMax,
      tempRootIsAlias: lexicalTempRoot !== physicalTempRoot,
    },
    compatibility: {
      platform: input.platformStatus,
      pi: input.piStatus,
      claudeCode: input.claudeStatus,
    },
    overrides: {
      claudeExecutable: Boolean(process.env.PI_CLAUDE_CODE_PROVIDER_PATH?.trim()),
      metricsLog: Boolean(process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG?.trim()),
    },
    installation: input.installation
      ? {
          executable: sanitize(input.installation.executable, lexicalTempRoot, physicalTempRoot),
          version: input.installation.version,
          subscriptionType: input.installation.subscriptionType,
        }
      : undefined,
    preflight: diagnosticPreflight(input.preflightError, lexicalTempRoot, physicalTempRoot),
    lastRequest: input.metrics,
    lastWebSearch: input.searchMetrics,
    metricsLogError: input.metricsLogError,
    runtimeCleanup: input.runtimeCleanup,
  };
  const contents = `${JSON.stringify(report, undefined, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_REPORT_BYTES) {
    throw new ClaudeCodeError("diagnostic_too_large", `Diagnostic report exceeds ${MAX_REPORT_BYTES} bytes`);
  }
  const directory = await mkdtemp(join(lexicalTempRoot, "pi-claude-code-provider-diagnostics-"));
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "report.json");
    await writeFile(path, contents, { mode: 0o600, flag: "wx" });
    return path;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function probe(executable: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(executable, args, { timeout: 5_000, maxBuffer: 16 * 1024 });
    return stdout.trim().split(/\r?\n/, 1)[0]?.slice(0, 256) || undefined;
  } catch {
    return undefined;
  }
}

function diagnosticPreflight(error: unknown, lexicalTempRoot: string, physicalTempRoot: string): object {
  if (!error) return { ok: true };
  if (error instanceof ClaudeCodeError) {
    return {
      ok: false,
      errorCode: error.code,
      errorMessage: sanitize(error.message, lexicalTempRoot, physicalTempRoot)?.slice(0, 512),
    };
  }
  return { ok: false, errorCode: "unexpected", errorMessage: "Unexpected preflight failure" };
}

function sanitize(value: string | undefined, lexicalTempRoot: string, physicalTempRoot: string): string | undefined {
  if (value === undefined) return undefined;
  const replacements = [
    [homedir(), "<HOME>"],
    [physicalTempRoot, "<TMP_REAL>"],
    [lexicalTempRoot, "<TMP>"],
  ]
    .filter(([path]) => path.length > 1)
    .sort(([left], [right]) => right.length - left.length);
  let sanitized = value;
  for (const [path, replacement] of replacements) sanitized = sanitized.split(path).join(replacement);
  return sanitized;
}
