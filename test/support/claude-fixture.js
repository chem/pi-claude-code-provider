export const CLAUDE_HEADLESS_HELP = [
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
  "--system-prompt",
  "--system-prompt-file",
  "--model",
  "--effort",
].join("\n");

// Relevant option spellings captured from Claude Code 2.1.241's real help.
export const CLAUDE_2_1_241_HEADLESS_HELP = `
  -p, --print
  --setting-sources <sources>
  --settings <file-or-json>
  --disable-slash-commands
  --permission-mode <mode>
  --no-chrome
  --prompt-suggestions [value]
  --output-format <format>
  --input-format <format>
  --include-partial-messages
  --verbose
  --no-session-persistence
  --strict-mcp-config
  --mcp-config <configs...>
  --tools <tools...>
  --allowedTools, --allowed-tools <tools...>
  Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file]
  --model <model>
  --effort <level>
`;

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
