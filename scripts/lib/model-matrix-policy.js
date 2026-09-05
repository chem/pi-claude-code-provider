import { EXPECTED_MODEL_RESOLUTIONS } from "../../src/compatibility.ts";

export function resolvedModelMatches(modelId, servedModel) {
  const expected = EXPECTED_MODEL_RESOLUTIONS[modelId];
  // A dynamic default must still report a concrete Claude identity. Capacity,
  // output limits, and cleanup are checked independently by the live matrix.
  if (expected === null) {
    return typeof servedModel === "string" && /^claude-[a-z0-9][a-z0-9.-]*$/.test(servedModel) && !/\s/.test(servedModel);
  }
  return typeof expected === "string" && servedModel === expected;
}

export function servedContextWindowMatches(subscriptionType, modelId, configuredContextWindow, servedContextWindow) {
  // Claude Code may report the 1M-capable Opus variant on Pro even when the
  // account has no usage credits. Keep Pi's safe configured limit at 200K.
  if (subscriptionType === "pro" && (modelId === "opus" || modelId === "default") && configuredContextWindow === 200_000) {
    return servedContextWindow === 200_000 || servedContextWindow === 1_000_000;
  }
  return servedContextWindow === configuredContextWindow;
}
