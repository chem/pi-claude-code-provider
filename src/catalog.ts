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

export function providerModelsForSubscription(subscriptionType: ClaudeSubscriptionType): ProviderModelConfig[] {
  const opusContextWindow = subscriptionType === "pro" ? 200_000 : 1_000_000;
  return [
    {
      id: "default",
      name: "Claude Code Default",
      reasoning: true,
      thinkingLevelMap: EFFORT_LEVELS,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    },
    {
      id: "sonnet",
      name: "Claude Code Sonnet",
      reasoning: true,
      thinkingLevelMap: EFFORT_LEVELS,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    },
    {
      id: "fable",
      name: "Claude Code Fable",
      reasoning: true,
      thinkingLevelMap: EFFORT_LEVELS,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    },
    {
      id: "opus",
      name: "Claude Code Opus",
      reasoning: true,
      thinkingLevelMap: EFFORT_LEVELS,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: opusContextWindow,
      maxTokens: 64_000,
    },
    {
      id: "haiku",
      name: "Claude Code Haiku",
      reasoning: true,
      thinkingLevelMap: EFFORT_LEVELS,
      input: ["text", "image"],
      cost: ZERO_COST,
      contextWindow: 200_000,
      maxTokens: 32_000,
    },
  ];
}
