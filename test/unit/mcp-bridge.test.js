import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRIDGE_PATH } from "../../src/claude-args.ts";
import { JsonlParser } from "../../src/jsonl.ts";
import { nodeFixtureArgs } from "../support/node-fixture.js";

// These tests exercise live stdin sent to a nested Node child. Some restricted
// sandboxes drop that pipe traffic, causing request timeouts despite a healthy
// bridge. Run them outside the sandbox; normal shells and GitHub CI preserve it.
test("MCP bridge lists exact schemas and refuses execution", async () => {
  // Test-launch the real bridge with the preload; production bridge output stays untouched.
  await exerciseBridge({ name: "Node", command: process.execPath, args: nodeFixtureArgs([BRIDGE_PATH]) });
});

test("Node bridge fails closed on malformed input and malformed catalogs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-node-invalid-"));
  const catalog = join(directory, "tools.json");
  try {
    await writeFile(catalog, "not json", { mode: 0o600 });
    const invalidCatalog = spawn(process.execPath, nodeFixtureArgs([BRIDGE_PATH]), {
      env: { ...process.env, PI_CLAUDE_TOOL_CATALOG: catalog },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    invalidCatalog.stderr.on("data", (chunk) => stderr.push(chunk));
    const code = await new Promise((resolve, reject) => {
      invalidCatalog.once("error", reject);
      invalidCatalog.once("close", resolve);
    });
    assert.equal(code, 2);
    assert.match(Buffer.concat(stderr).toString("utf8"), /invalid tool catalog/);

    await writeFile(catalog, "[]", { mode: 0o600 });
    const child = spawn(process.execPath, nodeFixtureArgs([BRIDGE_PATH]), {
      env: { ...process.env, PI_CLAUDE_TOOL_CATALOG: catalog },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const response = new Promise((resolve, reject) => {
      const parser = new JsonlParser(resolve);
      child.stdout.on("data", (chunk) => {
        try { parser.push(chunk); } catch (error) { reject(error); }
      });
      child.once("error", reject);
    });
    child.stdin.write("not json\n");
    assert.deepEqual(await response, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON-RPC request" },
    });
    child.stdin.end();
    assert.equal(await new Promise((resolve) => child.once("close", resolve)), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bridge framing enforces its byte bound incrementally and handles stream boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-node-framing-"));
  const catalog = join(directory, "tools.json");
  await writeFile(catalog, "[]", { mode: 0o600 });
  try {
    const bounded = startBridge(catalog);
    const empty = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "future", pad: "" });
    const exact = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "future", pad: "x".repeat(1024 * 1024 - Buffer.byteLength(empty)) });
    assert.equal(Buffer.byteLength(exact), 1024 * 1024);
    bounded.child.stdin.write(`${exact}\n`);
    const unicode = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { note: "雪" } })}\r\n${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })}\n`);
    const split = unicode.indexOf(Buffer.from("雪")) + 1;
    bounded.child.stdin.write(unicode.subarray(0, split));
    bounded.child.stdin.write(unicode.subarray(split));
    bounded.child.stdin.end();
    const records = await bounded.records;
    assert.equal(records.find((record) => record.id === 1)?.error?.code, -32601);
    assert.equal(records.find((record) => record.id === 2)?.result?.serverInfo?.name, "pi-tool-proposals");
    assert.deepEqual(records.find((record) => record.id === 3)?.result?.tools, []);
    assert.equal((await bounded.closed).code, 0);

    const oversized = startBridge(catalog);
    oversized.child.stdin.write(Buffer.alloc(1024 * 1024 + 1, 0x78));
    const early = await Promise.race([oversized.closed, delay(1_000)]);
    assert.ok(early, "bridge did not reject an oversized unterminated record while stdin stayed open");
    assert.equal(early.code, 1);
    const overflowRecords = await oversized.records;
    assert.match(overflowRecords[0]?.error?.message ?? "", /exceeds the bridge limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function startBridge(catalog) {
  const child = spawn(process.execPath, nodeFixtureArgs([BRIDGE_PATH]), {
    env: { ...process.env, PI_CLAUDE_TOOL_CATALOG: catalog },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const values = [];
  const parser = new JsonlParser((value) => values.push(value));
  child.stdout.on("data", (chunk) => parser.push(chunk));
  const records = new Promise((resolve) => child.stdout.on("end", () => {
    parser.end();
    resolve(values);
  }));
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, records, closed };
}

async function exerciseBridge(bridge) {
  const directory = await mkdtemp(join(tmpdir(), `mcp-${bridge.name.toLowerCase()}-`));
  const catalog = join(directory, "tools.json");
  const violation = join(directory, "violation");
  const ready = join(directory, "ready");
  const expectedTools = [{ name: "probe", description: "probe", inputSchema: { type: "object" } }];
  await writeFile(catalog, JSON.stringify(expectedTools), { mode: 0o600 });
  const child = spawn(bridge.command, bridge.args, {
    env: {
      ...process.env,
      PI_CLAUDE_TOOL_CATALOG: catalog,
      PI_CLAUDE_TOOL_VIOLATION: violation,
      PI_CLAUDE_TOOL_READY: ready,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  const waiters = new Map();
  let protocolError;
  const parser = new JsonlParser((value) => {
    responses.set(value.id, value);
    waiters.get(value.id)?.resolve(value);
    waiters.delete(value.id);
  });
  const failProtocol = (error) => {
    protocolError = error instanceof Error ? error : new Error(String(error));
    for (const waiter of waiters.values()) waiter.reject(protocolError);
    waiters.clear();
  };
  child.stdout.on("data", (chunk) => {
    try { parser.push(chunk); } catch (error) { failProtocol(error); }
  });
  child.stdout.on("end", () => {
    try { parser.end(); } catch (error) { failProtocol(error); }
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", (error) => { failProtocol(error); reject(error); });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const request = async (id, method) => {
    if (protocolError) throw protocolError;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: method === "tools/call" ? { name: "probe" } : {} })}\n`);
    if (responses.has(id)) return responses.get(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`${bridge.name} MCP response ${id} timed out`));
      }, 2_000);
      waiters.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
    });
  };
  try {
    await assert.rejects(access(ready));
    const initialized = await request(1, "initialize");
    await assert.rejects(access(ready));
    const listed = await request(2, "tools/list");
    await waitForPath(ready);
    const firstCall = await request(3, "tools/call");
    const secondCall = await request(4, "tools/call");
    const unknown = await request(5, "future/method");
    await waitForPath(violation);
    assert.equal(initialized.result.serverInfo.name, "pi-tool-proposals");
    assert.deepEqual(listed.result.tools, expectedTools);
    assert.match(String(firstCall.error.message), /never executes/);
    assert.match(String(secondCall.error.message), /never executes/);
    assert.equal(unknown.error.code, -32601);
  } finally {
    child.stdin.end();
    const result = await Promise.race([closed, delay(1_000)]);
    if (!result) child.kill("SIGKILL");
    else assert.deepEqual(result, { code: 0, signal: null });
    await rm(directory, { recursive: true, force: true });
  }
}

function delay(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref();
  });
}

async function waitForPath(path) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
