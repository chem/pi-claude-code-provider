import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VERIFIED_VERSIONS } from "../../src/compatibility.ts";
import { PAID_LAUNCH_BUDGET_ENV } from "../../src/paid-launch-budget.ts";
import { closeLiveRpcProcess, consumeJsonl, superviseLiveProcess } from "../../scripts/lib/live-process.js";
import { piCliEntry } from "../../scripts/lib/pi-installation.js";
import { CLAUDE_HEADLESS_HELP, ELIGIBLE_CLAUDE_AUTH } from "../support/claude-fixture.js";
import { nodeFixtureArgs, nodeFixtureSource } from "../support/node-fixture.js";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../..", import.meta.url));

async function fakeClaude(directory, reply = "OK") {
  const executable = join(directory, process.platform === "win32" ? "claude.cjs" : "claude");
  const init = { type: "system", subtype: "init", tools: [], mcp_servers: [], model: "claude-sonnet-5", permissionMode: "dontAsk", slash_commands: [], skills: [], plugins: [], apiKeySource: "none" };
  // This fake CLI must not rely on buffered child stdout in restricted sandboxes.
  await writeFile(executable, nodeFixtureSource(`
if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${VERIFIED_VERSIONS.claudeCode}\n`)});
else if (process.argv[2] === "auth" && process.argv[3] === "status") process.stdout.write(JSON.stringify(${JSON.stringify(ELIGIBLE_CLAUDE_AUTH)}));
else if (process.argv.includes("--help")) process.stdout.write(${JSON.stringify(CLAUDE_HEADLESS_HELP)});
else {
  const systemPath = process.argv[process.argv.indexOf("--system-prompt-file") + 1];
  if (systemPath && require("node:fs").readFileSync(systemPath, "utf8").includes("AMBIENT_ISOLATION_MARKER")) {
    process.stderr.write("Ambient system prompt reached the fake provider");
    process.exit(93);
  }
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
    process.stdout.write(JSON.stringify({type:"result",is_error:false,result:${JSON.stringify(reply)}}) + "\\n");
  });
}
`), { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test("the guarded runner isolates ambient SYSTEM.md without changing the user's config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-paid-isolation-fixture-"));
  const agentDirectory = join(directory, "agent");
  await mkdir(agentDirectory);
  const systemFile = join(agentDirectory, "SYSTEM.md");
  await writeFile(systemFile, "AMBIENT_ISOLATION_MARKER");
  const executable = await fakeClaude(directory, "live test successful");
  const child = spawn(process.execPath, nodeFixtureArgs([join(root, "scripts", "paid-test-runner.js"), "smoke"]), {
    cwd: root,
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_OFFLINE: "1",
      PI_CLAUDE_CODE_PROVIDER_PATH: executable,
      PI_CLAUDE_CODE_PROVIDER_CONFIRM_PAID_TESTS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const supervisor = superviseLiveProcess(child, { timeoutMs: 20_000, label: "isolated paid smoke fixture" });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    assert.deepEqual(await supervisor.wait(), { code: 0, signal: null }, output);
    assert.match(output, /recorded 1\/1; aggregate 1\/1/);
    assert.equal(await readFile(systemFile, "utf8"), "AMBIENT_ISOLATION_MARKER");
  } finally {
    if (child.exitCode === null && child.signalCode === null) await supervisor.terminate();
    await rm(directory, { recursive: true, force: true });
  }
});

test("paid RPC accounting flushes one metric for every claim before graceful exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-paid-rpc-lifecycle-"));
  const stageDirectory = join(directory, "stage");
  const aggregateDirectory = join(directory, "aggregate");
  const metricsPath = join(directory, "metrics.jsonl");
  await mkdir(stageDirectory);
  await mkdir(aggregateDirectory);
  const executable = await fakeClaude(directory);
  // Preload only the test-launched Pi process; runtime Pi behavior stays unchanged.
  const child = spawn(process.execPath, nodeFixtureArgs([
    piCliEntry(), "--mode", "rpc", "--no-session", "--no-extensions", "-e", root,
    "--no-skills", "--no-context-files", "--provider", "pi-claude-code-provider",
    "--model", "sonnet:medium", "--no-tools",
  ]), {
    cwd: directory,
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
    env: {
      ...process.env,
      PI_CLAUDE_CODE_PROVIDER_PATH: executable,
      PI_CLAUDE_CODE_PROVIDER_METRICS_LOG: metricsPath,
      [PAID_LAUNCH_BUDGET_ENV.child]: "1",
      [PAID_LAUNCH_BUDGET_ENV.stageDirectory]: stageDirectory,
      [PAID_LAUNCH_BUDGET_ENV.stageCap]: "2",
      [PAID_LAUNCH_BUDGET_ENV.aggregateDirectory]: aggregateDirectory,
      [PAID_LAUNCH_BUDGET_ENV.aggregateCap]: "2",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const supervisor = superviseLiveProcess(child, { timeoutMs: 15_000, label: "paid RPC lifecycle fixture" });
  const closed = supervisor.wait();
  let pending;
  let protocolError;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024); });
  void closed.then(
    ({ code, signal }) => pending?.reject(new Error(`Pi fixture exited (code ${String(code)}, signal ${String(signal)}): ${stderr}`)),
    (error) => pending?.reject(error),
  );
  consumeJsonl(child.stdout, (event) => {
    if (event.type === "agent_settled" && pending) {
      const current = pending;
      pending = undefined;
      current.resolve();
    }
  }, (error) => {
    protocolError = error;
    if (pending) {
      const current = pending;
      pending = undefined;
      current.reject(error);
    }
  });
  const turn = (message) => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
  });

  try {
    await turn("Reply exactly OK.");
    if (protocolError) throw protocolError;
    await turn("Reply exactly OK again.");
    if (protocolError) throw protocolError;
    const shutdown = await closeLiveRpcProcess(child, supervisor, closed);
    assert.equal(shutdown.graceful, true);
    assert.deepEqual(shutdown.result, { code: 0, signal: null }, stderr);
    assert.equal((await readdir(stageDirectory)).filter((name) => name.endsWith(".claim")).length, 2);
    assert.equal((await readdir(aggregateDirectory)).filter((name) => name.endsWith(".claim")).length, 2);
    const records = (await readFile(metricsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(records.every((record) => record.stopReason === "stop" && record.cleanupComplete === true), true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) await supervisor.terminate().catch(() => {});
    await closed.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
