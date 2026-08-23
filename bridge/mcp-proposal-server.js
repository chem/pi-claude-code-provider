#!/usr/bin/env node
/**
 * Proposal-only MCP bridge: expose Pi schemas, reject every tools/call, and stay dependency-free.
 * Oversized input is fatal so rejected framing state is never reused.
 */
import { readFileSync, writeFileSync } from "node:fs";

const MAX_REQUEST_BYTES = 1024 * 1024;
const catalogPath = process.env.PI_CLAUDE_TOOL_CATALOG;
if (!catalogPath) failStartup("PI_CLAUDE_TOOL_CATALOG is required");

let tools;
try {
  tools = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (!Array.isArray(tools)) throw new Error("catalog must be an array");
} catch (error) {
  failStartup(`invalid tool catalog: ${error instanceof Error ? error.message : String(error)}`);
}

let pending = Buffer.alloc(0);
let inputFailed = false;
process.stdin.on("data", (chunk) => {
  if (inputFailed) return;
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf(0x0a, offset);
    if (newline === -1) {
      appendRecordBytes(chunk.subarray(offset));
      return;
    }
    const segment = chunk.subarray(offset, newline);
    const recordBytes = pending.length + segment.length;
    const lastByte = segment.length > 0 ? segment.at(-1) : pending.at(-1);
    if (recordBytes > MAX_REQUEST_BYTES + 1 || (recordBytes > MAX_REQUEST_BYTES && lastByte !== 0x0d)) {
      return failInput("MCP request exceeds the bridge limit");
    }
    const record = pending.length === 0 ? segment : Buffer.concat([pending, segment], recordBytes);
    pending = Buffer.alloc(0);
    const content = record.at(-1) === 0x0d ? record.subarray(0, -1) : record;
    acceptLine(content.toString("utf8"));
    if (inputFailed) return;
    offset = newline + 1;
  }
});

process.stdin.on("end", () => {
  if (!inputFailed && pending.length > 0) {
    const content = pending.at(-1) === 0x0d ? pending.subarray(0, -1) : pending;
    if (content.length > MAX_REQUEST_BYTES) failInput("MCP request exceeds the bridge limit");
    else acceptLine(content.toString("utf8"));
  }
});

process.stdin.on("error", (error) => failInput(`MCP input failure: ${error.message}`, false));

function appendRecordBytes(chunk) {
  const size = pending.length + chunk.length;
  if (size > MAX_REQUEST_BYTES + 1) return failInput("MCP request exceeds the bridge limit");
  pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk], size);
  if (pending.length > MAX_REQUEST_BYTES && pending.at(-1) !== 0x0d) {
    failInput("MCP request exceeds the bridge limit");
  }
}

function acceptLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Invalid JSON-RPC request");
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    sendError(null, -32600, "Invalid JSON-RPC request");
    return;
  }
  const requestId = message.id;
  if (message.method === "initialize") {
    if (requestId !== undefined) {
      send({
        jsonrpc: "2.0",
        id: requestId,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "pi-tool-proposals", version: "1.0.0" },
        },
      });
    }
    return;
  }
  if (message.method === "tools/list") {
    if (requestId !== undefined) send({ jsonrpc: "2.0", id: requestId, result: { tools } });
    mark(process.env.PI_CLAUDE_TOOL_READY, "ready\n");
    return;
  }
  if (message.method === "tools/call") {
    mark(process.env.PI_CLAUDE_TOOL_VIOLATION, "tools/call reached proposal-only MCP server\n");
    if (requestId !== undefined) {
      sendError(requestId, -32001, "Security invariant: this server proposes tools but never executes them");
    }
    return;
  }
  if (requestId !== undefined) sendError(requestId, -32601, `Method not found: ${String(message.method)}`);
}

function failInput(message, respond = true) {
  if (inputFailed) return;
  inputFailed = true;
  process.stdin.pause();
  process.stdin.destroy();
  if (!respond) {
    process.stderr.write(`${message}\n`, () => process.exit(1));
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message } })}\n`, () => process.exit(1));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function mark(path, contents) {
  if (!path) return;
  try {
    writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function failStartup(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
