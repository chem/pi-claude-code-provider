import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeOverflow } from "../../src/errors.ts";

test("normalizes Claude overflow wording idempotently", () => {
  assert.equal(
    normalizeClaudeOverflow("Prompt is too long for this model"),
    "context_length_exceeded: Prompt is too long for this model",
  );
  assert.equal(
    normalizeClaudeOverflow("context_length_exceeded: Prompt is too long"),
    "context_length_exceeded: Prompt is too long",
  );
});

test("does not normalize rate limits or unrelated large requests", () => {
  assert.equal(normalizeClaudeOverflow("rate limit: too many requests"), "rate limit: too many requests");
  assert.equal(normalizeClaudeOverflow("rate limit: too many tokens per minute"), "rate limit: too many tokens per minute");
  assert.equal(normalizeClaudeOverflow("request too large"), "request too large");
});
