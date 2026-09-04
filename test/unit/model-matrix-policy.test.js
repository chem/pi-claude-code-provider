import assert from "node:assert/strict";
import test from "node:test";
import { planModelMatrixCases, servedContextWindowMatches } from "../../scripts/lib/model-matrix-policy.js";

test("keeps Fable aliases selectable but outside the blocking model matrix", () => {
    const advertisedModels = ["default", "sonnet", "fable", "fable-5.1", "opus", "haiku"];
    const { coreCases, selectableCases } = planModelMatrixCases(advertisedModels);
    const caseNames = (cases) => cases.map(({ model, effort }) => `${model}:${effort}`);
    const coreNames = caseNames(coreCases);
    const selectableNames = caseNames(selectableCases);

    assert.equal(coreNames.length, 20);
    assert.equal(coreNames.includes("fable:medium"), false);
    assert.equal(coreNames.includes("fable-5.1:medium"), false);
    assert.equal(selectableNames.includes("fable:medium"), true);
    assert.equal(selectableNames.includes("fable-5.1:medium"), true);
});

test("keeps Pro Opus configured at 200K while tolerating Claude's 1M capability report", () => {
    assert.equal(servedContextWindowMatches("pro", "opus", 200_000, 200_000), true);
    assert.equal(servedContextWindowMatches("pro", "opus", 200_000, 1_000_000), true);
    assert.equal(servedContextWindowMatches("pro", "opus", 200_000, 500_000), false);
    assert.equal(servedContextWindowMatches("pro", "sonnet", 1_000_000, 200_000), false);
    assert.equal(servedContextWindowMatches("max", "opus", 1_000_000, 200_000), false);
    assert.equal(servedContextWindowMatches("max", "opus", 1_000_000, 1_000_000), true);
});
