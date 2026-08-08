import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nodeFixtureArgs, nodeFixtureSource } from "../support/node-fixture.js";

function captureNode(args) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("test Node fixture stdio remains observable through nested child pipes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "node-fixture-"));
  const executable = join(directory, "fixture.cjs");
  const largeOutput = "x".repeat(256 * 1024);
  try {
    await writeFile(executable, nodeFixtureSource(`
process.stdout.write("fixture-out", () => process.stdout.write("-callback"));
process.stderr.write("fixture-err");
`), { mode: 0o700 });
    await chmod(executable, 0o700);
    assert.deepEqual(await captureNode([executable]), {
      code: 0,
      signal: null,
      stdout: "fixture-out-callback",
      stderr: "fixture-err",
    });
    assert.deepEqual(await captureNode(nodeFixtureArgs([
      "-e",
      "process.stdout.write('preload-out'); process.stderr.write('preload-err'); process.stdout.write('x'.repeat(256 * 1024));",
    ])), {
      code: 0,
      signal: null,
      stdout: `preload-out${largeOutput}`,
      stderr: "preload-err",
    });
  }
  finally {
    await rm(directory, { recursive: true, force: true });
  }
});
