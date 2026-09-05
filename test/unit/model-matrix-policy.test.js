import assert from "node:assert/strict";
import test from "node:test";
import { servedContextWindowMatches } from "../../scripts/lib/model-matrix-policy.js";

test("keeps Pro Opus configured at 200K while tolerating Claude's 1M capability report", () => {
    assert.equal(servedContextWindowMatches("pro", "opus", 200_000, 200_000), true);
    assert.equal(servedContextWindowMatches("pro", "opus", 200_000, 1_000_000), true);
    assert.equal(servedContextWindowMatches("pro", "opus", 200_000, 500_000), false);
    assert.equal(servedContextWindowMatches("pro", "sonnet", 1_000_000, 200_000), false);
    assert.equal(servedContextWindowMatches("max", "opus", 1_000_000, 200_000), false);
    assert.equal(servedContextWindowMatches("max", "opus", 1_000_000, 1_000_000), true);
});
