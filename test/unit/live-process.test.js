import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { closeLiveRpcProcess, consumeJsonl, superviseLiveProcess } from "../../scripts/lib/live-process.js";

test("live-process supervision clears normal exits and enforces deadlines", async () => {
  const clean = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  assert.deepEqual(await superviseLiveProcess(clean, { timeoutMs: 1_000, label: "clean" }).wait(), {
    code: 0,
    signal: null,
  });

  const hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  await assert.rejects(
    superviseLiveProcess(hung, { timeoutMs: 30, label: "hung" }).wait(),
    /hung exceeded 30ms/,
  );
});

test("live RPC shutdown prefers stdin EOF and bounds forced-cleanup fallback", async () => {
  const spawnOptions = {
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
    stdio: ["pipe", "ignore", "ignore"],
  };
  const clean = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));"], spawnOptions);
  const cleanSupervisor = superviseLiveProcess(clean, { timeoutMs: 2_000, label: "clean RPC" });
  const cleanClosed = cleanSupervisor.wait();
  assert.deepEqual(await closeLiveRpcProcess(clean, cleanSupervisor, cleanClosed, 500), {
    result: { code: 0, signal: null },
    graceful: true,
  });

  const hung = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"], spawnOptions);
  const hungSupervisor = superviseLiveProcess(hung, { timeoutMs: 2_000, label: "hung RPC" });
  const hungClosed = hungSupervisor.wait();
  const forced = await closeLiveRpcProcess(hung, hungSupervisor, hungClosed, 100);
  assert.equal(forced.graceful, false);
  assert.equal(hung.exitCode !== null || hung.signalCode !== null, true);
});

test("live JSONL consumption reports parser failures through its callback", async () => {
  const stream = new PassThrough();
  const values = [];
  const failure = new Promise((resolve) => {
    consumeJsonl(stream, (value) => values.push(value), resolve);
  });
  stream.end('{"ok":true}\nmalformed\n');
  assert.match((await failure).message, /malformed JSONL/);
  assert.deepEqual(values, [{ ok: true }]);
});
