import { execFile, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface ProcessSupervisorOptions {
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  onFailure: (error: Error) => void;
}

export interface ProcessSupervisor {
  touch(): void;
  wait(): Promise<ProcessResult>;
  terminate(): Promise<void>;
  dispose(): void;
}

type ProcessKiller = (pid: number, signal?: NodeJS.Signals | number) => true;

export function superviseProcess(child: ChildProcess, options: ProcessSupervisorOptions): ProcessSupervisor {
  let idleTimer: NodeJS.Timeout | undefined;
  let totalTimer: NodeJS.Timeout | undefined;
  let disposed = false;
  let settled = false;
  let failed = false;
  let terminationPromise: Promise<void> | undefined;
  let resolveResult: ((result: ProcessResult) => void) | undefined;
  const result = new Promise<ProcessResult>((resolve) => {
    resolveResult = resolve;
  });

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
  };

  const terminate = (): Promise<void> => {
    terminationPromise ??= terminateProcessGroup(child);
    return terminationPromise;
  };

  const fail = (error: Error): void => {
    if (disposed || failed) return;
    failed = true;
    options.onFailure(error);
    // A timeout or pipe error has already established the primary failure, but
    // platform process cleanup must still be observed to avoid an unhandled rejection.
    void terminate().catch((terminationError: unknown) => {
      options.onFailure(new Error(`Claude Code process cleanup failed: ${errorMessage(terminationError)}`));
    });
  };
  const onChildError = (error: Error): void => {
    fail(error);
    if (!settled) {
      settled = true;
      clearTimers();
      resolveResult?.({ code: child.exitCode, signal: child.signalCode, error });
    }
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    resolveResult?.({ code, signal });
  };
  const onStdinError = (error: Error): void => fail(new Error(`Claude Code stdin failed: ${error.message}`));
  const onStdoutError = (error: Error): void => fail(new Error(`Claude Code stdout failed: ${error.message}`));
  const onStderrError = (error: Error): void => fail(new Error(`Claude Code stderr failed: ${error.message}`));

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      fail(new Error(`Claude Code produced no protocol activity for ${options.idleTimeoutMs}ms`));
    }, options.idleTimeoutMs);
    idleTimer.unref();
  };

  child.once("error", onChildError);
  child.once("close", onClose);
  child.stdin?.on("error", onStdinError);
  child.stdout?.on("error", onStdoutError);
  child.stderr?.on("error", onStderrError);
  armIdle();
  totalTimer = setTimeout(() => {
    fail(new Error(`Claude Code request exceeded ${options.totalTimeoutMs}ms`));
  }, options.totalTimeoutMs);
  totalTimer.unref();

  return {
    touch: armIdle,
    wait: () => result,
    terminate,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
      child.removeListener("error", onChildError);
      child.removeListener("close", onClose);
      child.stdin?.removeListener("error", onStdinError);
      child.stdout?.removeListener("error", onStdoutError);
      child.stderr?.removeListener("error", onStderrError);
    },
  };
}

export async function terminateProcessGroup(
  child: ChildProcess,
  graceMs = 500,
  killProcess: ProcessKiller = process.kill,
): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child, pid, graceMs);
    return;
  }

  try {
    killProcess(-pid, "SIGTERM");
  } catch (error) {
    if (isMissingProcess(error)) {
      await terminateDirectChild(child, graceMs);
      return;
    }
    throw processGroupCleanupError(pid, "SIGTERM", child, error);
  }

  if (await waitForProcessGroupExit(pid, graceMs, killProcess)) return;
  try {
    killProcess(-pid, "SIGKILL");
  } catch (error) {
    if (isMissingProcess(error)) return;
    throw processGroupCleanupError(pid, "SIGKILL", child, error);
  }
  if (!(await waitForProcessGroupExit(pid, graceMs, killProcess))) {
    throw new Error(
      `Process group ${pid} did not terminate after SIGKILL ` +
      `(child exitCode=${String(child.exitCode)}, signalCode=${String(child.signalCode)})`,
    );
  }
}

export function windowsTaskkillExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const systemRoot = environment.SystemRoot?.trim() || environment.WINDIR?.trim();
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable; cannot locate taskkill.exe");
  }
  return join(systemRoot, "System32", "taskkill.exe");
}

export async function validateProcessTerminationCapability(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (platform !== "win32") return;
  const executable = windowsTaskkillExecutable(environment);
  try {
    await access(executable, constants.F_OK);
  } catch {
    throw new Error(`Windows process-tree cleanup is unavailable: ${executable} is not accessible`);
  }
}

async function terminateWindowsProcessTree(child: ChildProcess, pid: number, graceMs: number): Promise<void> {
  if (!validPid(pid)) throw new Error("Claude Code child process has no valid process ID");
  if (child.exitCode !== null || child.signalCode !== null) return;

  let taskkillFailure: unknown;
  try {
    // Never terminate by image name or process enumeration: other terminals may
    // be running unrelated Claude instances. /T is rooted only at this child.pid.
    await runTaskkill(windowsTaskkillExecutable(), pid);
  } catch (error) {
    taskkillFailure = error;
  }

  await waitForChildClose(child, graceMs);
  if (taskkillFailure) {
    if (isTaskkillMissingProcess(taskkillFailure) && (child.exitCode !== null || child.signalCode !== null)) return;
    if (child.exitCode === null && child.signalCode === null) {
      // This retained ChildProcess handle still identifies only our direct child.
      // Best effort reduces leakage, but tree-cleanup failure remains an error.
      child.kill("SIGKILL");
      await waitForChildClose(child, graceMs);
    }
    throw new Error(`Process tree ${pid} cleanup failed: ${errorMessage(taskkillFailure)}`);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForChildClose(child, graceMs);
    throw new Error(`Process tree ${pid} did not terminate after taskkill`);
  }
}

async function runTaskkill(executable: string, pid: number): Promise<void> {
  // Invoke taskkill directly: a shell is unnecessary, and avoiding one prevents
  // Git Bash/MSYS from rewriting native arguments such as /PID.
  await new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 },
      (error) => error ? reject(error) : resolve(),
    );
  });
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
  killProcess: ProcessKiller,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      killProcess(-pid, 0);
    } catch (error) {
      if (isMissingProcess(error)) return true;
      // POSIX signal 0 performs an existence/permission probe. EPERM therefore
      // means the group may still exist, not that cleanup itself was denied.
      // Keep polling; actual SIGTERM/SIGKILL permission failures remain fatal.
      if (!isPermissionDenied(error)) throw processGroupProbeError(pid, error);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function terminateDirectChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.kill("SIGTERM")) return;
  await waitForChildClose(child, graceMs);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForChildClose(child, graceMs);
  }
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function isTaskkillMissingProcess(error: unknown): boolean {
  // taskkill uses status 128 when the exact PID disappeared before it acted.
  // Avoid localized stderr parsing and accept it only after our child closed.
  return error instanceof Error && "code" in error && error.code === 128;
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}

function processGroupCleanupError(
  pid: number,
  phase: "SIGTERM" | "SIGKILL",
  child: ChildProcess,
  error: unknown,
): Error {
  return new Error(
    `Process group ${pid} cleanup failed during ${phase} ` +
    `(child exitCode=${String(child.exitCode)}, signalCode=${String(child.signalCode)}): ${errorDetails(error)}`,
    { cause: error },
  );
}

function processGroupProbeError(pid: number, error: unknown): Error {
  return new Error(`Process group ${pid} status probe failed: ${errorDetails(error)}`, { cause: error });
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const fields = ["code", "errno", "syscall"]
    .filter((field) => field in error)
    .map((field) => `${field}=${String((error as unknown as Record<string, unknown>)[field])}`);
  return fields.length > 0 ? `${error.message} [${fields.join(" ")}]` : error.message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
