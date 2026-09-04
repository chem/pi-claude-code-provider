const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_MODELS = ["default", "sonnet", "opus", "haiku"];
const UNGATED_MODELS = new Set(["fable", "fable-5.1"]);

export function planModelMatrixCases(advertisedModels) {
  const mediumOnlyModels = advertisedModels.filter((model) => !EFFORT_MODELS.includes(model));
  const coreCases = [
    { model: "sonnet", effort: "medium" },
    ...EFFORT_MODELS
      .flatMap((model) => EFFORTS.map((effort) => ({ model, effort })))
      .filter(({ model, effort }) => model !== "sonnet" || effort !== "medium"),
    ...mediumOnlyModels
      .filter((model) => !UNGATED_MODELS.has(model))
      .map((model) => ({ model, effort: "medium" })),
  ];
  const selectableCases = [
    ...coreCases,
    ...mediumOnlyModels
      .filter((model) => UNGATED_MODELS.has(model))
      .map((model) => ({ model, effort: "medium" })),
  ];
  return { coreCases, selectableCases };
}

export function servedContextWindowMatches(subscriptionType, modelId, configuredContextWindow, servedContextWindow) {
  // Claude Code may report the 1M-capable Opus variant on Pro even when the
  // account has no usage credits. Keep Pi's safe configured limit at 200K.
  if (subscriptionType === "pro" && modelId === "opus" && configuredContextWindow === 200_000) {
    return servedContextWindow === 200_000 || servedContextWindow === 1_000_000;
  }
  return servedContextWindow === configuredContextWindow;
}
