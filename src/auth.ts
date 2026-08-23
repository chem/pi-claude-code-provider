import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { ClaudeCodeError } from "./errors.ts";
import { scriptLaunch, type ScriptLaunch } from "./host-runtime.ts";
import { validateProcessTerminationCapability } from "./process-utils.ts";
import type { ClaudeAuthStatus, ClaudeInstallation, ClaudeSubscriptionType } from "./types.ts";

const execFileAsync = promisify(execFile);
const ELIGIBLE_SUBSCRIPTIONS: ReadonlySet<string> = new Set(["pro", "max", "team", "enterprise"]);
const REQUIRED_HEADLESS_FLAGS = [
  "--print",
  "--setting-sources",
  "--settings",
  "--disable-slash-commands",
  "--permission-mode",
  "--no-chrome",
  "--prompt-suggestions",
  "--output-format",
  "--input-format",
  "--include-partial-messages",
  "--verbose",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--mcp-config",
  "--tools",
  "--allowedTools",
  "--model",
  "--effort",
] as const;

export function claudeExecutable(): string {
  return process.env.PI_CLAUDE_CODE_PROVIDER_PATH?.trim() || "claude";
}

export function parseAuthStatus(stdout: string): ClaudeSubscriptionType {
  let status: ClaudeAuthStatus;
  try {
    status = JSON.parse(stdout) as ClaudeAuthStatus;
  } catch {
    throw new ClaudeCodeError("auth_invalid", "Claude Code returned invalid authentication status JSON");
  }
  const subscription = status.subscriptionType?.toLowerCase();
  if (!status.loggedIn || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty" || !subscription) {
    throw new ClaudeCodeError(
      "auth_ineligible",
      "Claude Code must be logged in through a first-party claude.ai subscription",
    );
  }
  if (!ELIGIBLE_SUBSCRIPTIONS.has(subscription)) {
    throw new ClaudeCodeError("auth_ineligible", `Unsupported Claude subscription type: ${subscription}`);
  }
  return subscription as ClaudeSubscriptionType;
}

export async function inspectClaudeInstallation(): Promise<ClaudeInstallation> {
  const configuredExecutable = claudeExecutable();
  let executable: string;
  try {
    executable = await resolveExecutable(configuredExecutable, "Claude Code", "executable_missing");
  } catch {
    throw new ClaudeCodeError(
      "executable_missing",
      `Claude Code executable is not runnable: ${configuredExecutable}`,
    );
  }

  try {
    await validateProcessTerminationCapability();
  } catch (error) {
    throw new ClaudeCodeError(
      "process_cleanup_unavailable",
      error instanceof Error ? error.message : "Windows process-tree cleanup is unavailable",
    );
  }

  try {
    const [{ stdout: versionOutput }, { stdout: authOutput }, { stdout: helpOutput }] = await Promise.all([
      execClaudeFile(executable, ["--version"]),
      execClaudeFile(executable, ["auth", "status"]),
      execClaudeFile(executable, ["--help"]),
    ]);
    const version = versionOutput.trim().match(/\d+\.\d+\.\d+/)?.[0];
    if (!version) throw new ClaudeCodeError("version_invalid", "Could not determine the Claude Code version");
    validateClaudeCapabilities(helpOutput);
    return {
      executable,
      version,
      subscriptionType: parseAuthStatus(authOutput),
    };
  } catch (error) {
    if (error instanceof ClaudeCodeError) throw error;
    const cause = error as NodeJS.ErrnoException;
    if (cause.code === "ENOENT") {
      throw new ClaudeCodeError("executable_missing", `Claude Code executable was not found: ${executable}`);
    }
    throw new ClaudeCodeError("preflight_failed", `Claude Code preflight failed: ${cause.message}`);
  }
}

export function claudeLaunch(executable: string, args: readonly string[]): ScriptLaunch {
  // Windows does not honor shebangs. Supporting JavaScript entry points also
  // lets deterministic fixtures use the hosting runtime without invoking a shell.
  if (process.platform === "win32" && /\.[cm]?js$/i.test(executable)) {
    return scriptLaunch(executable, args);
  }
  return { command: executable, args: [...args], env: {} };
}

async function execClaudeFile(executable: string, args: readonly string[]) {
  const launch = claudeLaunch(executable, args);
  return execFileAsync(launch.command, launch.args, {
    timeout: 10_000,
    env: buildClaudeEnvironment(launch.env),
  });
}

export function validateClaudeCapabilities(helpOutput: string): void {
  const missing: string[] = REQUIRED_HEADLESS_FLAGS.filter((flag) => !hasCliOption(helpOutput, flag));
  if (!hasCliOption(helpOutput, "--system-prompt")) missing.push("--system-prompt");
  if (!hasCliOption(helpOutput, "--system-prompt-file")) missing.push("--system-prompt-file");
  if (missing.length > 0) {
    throw new ClaudeCodeError(
      "capability_missing",
      `Claude Code is missing required headless capabilities: ${missing.join(", ")}`,
    );
  }
}

function hasCliOption(helpOutput: string, option: string): boolean {
  const bracketedSystemPrompt = /(?:^|[\s,])--system-prompt\[-file\](?=$|[\s,=<\[])/m.test(helpOutput);
  if (bracketedSystemPrompt && (option === "--system-prompt" || option === "--system-prompt-file")) return true;
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s,])${escaped}(?=$|[\\s,=<\\[])`, "m").test(helpOutput);
}

async function resolveExecutable(configured: string, label: string, code: string): Promise<string> {
  if (isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) {
    try {
      await access(configured, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return await realpath(configured);
    } catch {
      throw new ClaudeCodeError(code, `${label} executable is not runnable: ${configured}`);
    }
  }
  const suffixes = process.platform === "win32" ? windowsExecutableSuffixes() : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${configured}${suffix}`);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return await realpath(candidate);
      } catch {
        // Try the next directly launchable suffix or PATH entry.
      }
    }
  }
  throw new ClaudeCodeError(code, `${label} is required but ${configured} was not found on PATH`);
}

function windowsExecutableSuffixes(): string[] {
  const directlyLaunchable = new Set([".com", ".exe", ".js", ".cjs", ".mjs"]);
  const configured = (process.env.PATHEXT ?? ".COM;.EXE")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => directlyLaunchable.has(value));
  configured.sort((left, right) => Number(right === ".exe") - Number(left === ".exe"));
  return [...new Set([...configured, ""])];
}

const ALLOWED_ENVIRONMENT = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export function buildClaudeEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ALLOWED_ENVIRONMENT) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return { ...env, ...extra };
}
