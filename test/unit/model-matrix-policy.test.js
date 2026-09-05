import assert from "node:assert/strict";
import test from "node:test";
import { resolvedModelMatches, servedContextWindowMatches } from "../../scripts/lib/model-matrix-policy.js";

test("the account default accepts concrete model identities without pinning a family", () => {
    assert.equal(resolvedModelMatches("default", "claude-sonnet-5"), true);
    assert.equal(resolvedModelMatches("default", "claude-opus-5"), true);
    for (const value of [undefined, null, "", "default", "opus", "not-a-model", "claude-opus-5\n"]) {
        assert.equal(resolvedModelMatches("default", value), false);
    }
});

test("explicit aliases still require their verified model and unknown aliases fail", () => {
    assert.equal(resolvedModelMatches("sonnet", "claude-sonnet-5"), true);
    assert.equal(resolvedModelMatches("sonnet", "claude-opus-5"), false);
    assert.equal(resolvedModelMatches("opus", "claude-opus-5"), true);
    assert.equal(resolvedModelMatches("opus", "claude-sonnet-5"), false);
    assert.equal(resolvedModelMatches("unknown", undefined), false);
});

test("keeps Pro Opus configured at 200K while tolerating Claude's 1M capability report", () => {
    assert.equal(servedContextWindowMatches("pro", "opus", 200_000, 200_000), true);
    assert.equal(servedContextWindowMatches("pro", "opus", 200_000, 1_000_000), true);
    assert.equal(servedContextWindowMatches("pro", "opus", 200_000, 500_000), false);
    assert.equal(servedContextWindowMatches("pro", "default", 200_000, 200_000), true);
    assert.equal(servedContextWindowMatches("pro", "default", 200_000, 1_000_000), true);
    assert.equal(servedContextWindowMatches("pro", "default", 200_000, 500_000), false);
    assert.equal(servedContextWindowMatches("pro", "sonnet", 1_000_000, 200_000), false);
    assert.equal(servedContextWindowMatches("max", "opus", 1_000_000, 200_000), false);
    assert.equal(servedContextWindowMatches("max", "opus", 1_000_000, 1_000_000), true);
});
