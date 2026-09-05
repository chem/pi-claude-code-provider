import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Claude Code's help, captured byte-for-byte. Re-pin with
// `npm run capture:claude-surface` and update this constant deliberately; a
// hand-written approximation invents spellings the CLI never emitted.
export const CAPTURED_CLAUDE_VERSION = "2.1.261";
export const CAPTURED_CLAUDE_HELP_PATH = fileURLToPath(
  new URL(`./captured/claude-${CAPTURED_CLAUDE_VERSION}-help.txt`, import.meta.url),
);
export const CLAUDE_HEADLESS_HELP = readFileSync(CAPTURED_CLAUDE_HELP_PATH, "utf8");

export const PROVIDER_INIT_FIELDS = Object.freeze({
  tools: Object.freeze([]),
  mcp_servers: Object.freeze([]),
  model: "claude-sonnet-5",
  permissionMode: "dontAsk",
  slash_commands: Object.freeze([]),
  skills: Object.freeze([]),
  plugins: Object.freeze([]),
  apiKeySource: "none",
});

export function initRecord(fields, overrides = {}) {
  return { type: "system", subtype: "init", ...fields, ...overrides };
}

export function resultRecord(fields) {
  return { type: "result", ...fields };
}

export function textResponseEvents(text, { id, model, usage = {} }) {
  return [
    { type: "stream_event", event: { type: "message_start", message: { id, model, usage: {} } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    resultRecord({ is_error: false, result: text, usage }),
  ];
}

export const ELIGIBLE_CLAUDE_AUTH = Object.freeze({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "pro",
});

export const ELIGIBLE_CLAUDE_AUTH_JSON = JSON.stringify(ELIGIBLE_CLAUDE_AUTH);
