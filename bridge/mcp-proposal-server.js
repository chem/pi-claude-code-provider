#!/usr/bin/env node
/** Proposal-only MCP bridge: expose Pi schemas, reject every tools/call, and stay dependency-free. */
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

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

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
    sendError(null, -32700, "MCP request exceeds the bridge limit");
    return;
  }
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
});

input.on("error", (error) => {
  process.stderr.write(`MCP input failure: ${error.message}\n`);
  process.exitCode = 1;
});

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
