import type { Api, Model } from "@earendil-works/pi-ai";
import type { MutableOutput } from "./types.ts";

export function createOutput(model: Model<Api>): MutableOutput {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    // Partial messages carry Pi's "pending" reason until a terminal event
    // supplies the real one, matching every built-in provider since Pi 0.83.0.
    stopReason: "pending",
    timestamp: Date.now(),
  };
}
