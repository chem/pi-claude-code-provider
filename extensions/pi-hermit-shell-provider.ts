import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// Optional companion to the existing Claude Code provider. Pi only talks to a
// local hermit-shell instance: no Claude credentials are read or stored here.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

function model(id: string, name: string): ProviderModelConfig {
  return {
    id,
    name,
    // hermit-shell's OpenAI-compatible response does not expose thinking.
    reasoning: false,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
}

export default function registerHermitShell(pi: ExtensionAPI): void {
  if (process.env.PI_HERMIT_SHELL_PROVIDER_ENABLED !== "1") return;
  const port = Number(process.env.PI_HERMIT_SHELL_PORT ?? "8765");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PI_HERMIT_SHELL_PORT must be a TCP port between 1 and 65535");
  }
  pi.registerProvider("hermit-shell", {
    name: "Hermit Shell (local proxy)",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "local-only", // Pi needs a key; the local proxy owns authentication.
    api: "openai-completions",
    models: [
      model("claude-sonnet-4-6", "Claude Sonnet 4.6 (Hermit)"),
      model("claude-opus-4-6", "Claude Opus 4.6 (Hermit)"),
      model("claude-haiku-4-5", "Claude Haiku 4.5 (Hermit)"),
    ],
  });
}
