import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ClaudeSubscriptionType } from "./types.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const EFFORT_LEVELS = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

function providerModel(
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
): ProviderModelConfig {
  return {
    id,
    name,
    reasoning: true,
    thinkingLevelMap: EFFORT_LEVELS,
    input: ["text", "image"],
    cost: ZERO_COST,
    contextWindow,
    maxTokens,
  };
}

export function providerModelsForSubscription(subscriptionType: ClaudeSubscriptionType): ProviderModelConfig[] {
  const opusContextWindow = subscriptionType === "pro" ? 200_000 : 1_000_000;
  return [
    providerModel("sonnet", "Claude Code Sonnet", 1_000_000, 64_000),
    providerModel("fable", "Claude Code Fable", 1_000_000, 64_000),
    providerModel("opus", "Claude Code Opus", opusContextWindow, 64_000),
    providerModel("haiku", "Claude Code Haiku", 200_000, 32_000),
  ];
}
