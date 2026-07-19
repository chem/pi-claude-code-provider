import assert from "node:assert/strict";
import test from "node:test";
import { providerModelsForSubscription } from "../../src/catalog.ts";

test("derives only the Opus context window from the subscription type", () => {
    for (const subscriptionType of ["pro", "max", "team", "enterprise"]) {
        const models = providerModelsForSubscription(subscriptionType);
        assert.deepEqual(models.map((model) => model.id), ["default", "sonnet", "fable", "opus", "haiku"]);
        assert.equal(models.find((model) => model.id === "opus").contextWindow, subscriptionType === "pro" ? 200_000 : 1_000_000);
        assert.equal(models.find((model) => model.id === "default").contextWindow, 1_000_000);
        assert.equal(models.find((model) => model.id === "sonnet").contextWindow, 1_000_000);
        assert.equal(models.find((model) => model.id === "fable").contextWindow, 1_000_000);
        assert.equal(models.find((model) => model.id === "haiku").contextWindow, 200_000);
    }
});
