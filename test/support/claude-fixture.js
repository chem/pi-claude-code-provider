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

export const ELIGIBLE_CLAUDE_AUTH = Object.freeze({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  subscriptionType: "pro",
});

export const ELIGIBLE_CLAUDE_AUTH_JSON = JSON.stringify(ELIGIBLE_CLAUDE_AUTH);
