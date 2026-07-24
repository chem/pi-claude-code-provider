export function servedContextWindowMatches(subscriptionType, modelId, configuredContextWindow, servedContextWindow) {
  // Claude Code may report the 1M-capable Opus variant on Pro even when the
  // account has no usage credits. Keep Pi's safe configured limit at 200K.
  if (subscriptionType === "pro" && modelId === "opus" && configuredContextWindow === 200_000) {
    return servedContextWindow === 200_000 || servedContextWindow === 1_000_000;
  }
  return servedContextWindow === configuredContextWindow;
}
