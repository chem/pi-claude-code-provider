export function servedContextWindowMatches(subscriptionType, modelId, configuredContextWindow, servedContextWindow) {
  if (subscriptionType === "pro" && modelId === "opus" && configuredContextWindow === 200_000) {
    return servedContextWindow === 200_000 || servedContextWindow === 1_000_000;
  }
  return servedContextWindow === configuredContextWindow;
}
