import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import { CAPTURED_CLAUDE_HELP_PATH, CAPTURED_CLAUDE_VERSION, CLAUDE_HEADLESS_HELP, PROVIDER_INIT_FIELDS, initRecord, resultRecord, textResponseEvents } from "../support/claude-fixture.js";

test("the captured help artifact is real Claude Code help for the pinned version", () => {
  assert.match(CAPTURED_CLAUDE_VERSION, /^\d+\.\d+\.\d+$/);
  // Bumping the pinned version without recapturing must fail here rather than
  // somewhere confusing downstream.
  assert.equal(basename(CAPTURED_CLAUDE_HELP_PATH), `claude-${CAPTURED_CLAUDE_VERSION}-help.txt`);
  assert.equal(readFileSync(CAPTURED_CLAUDE_HELP_PATH, "utf8"), CLAUDE_HEADLESS_HELP);
  // Shape a hand-written flag list would not have: a usage banner and wrapped
  // descriptions. The retired fixture was a bare newline-joined list of names.
  assert.match(CLAUDE_HEADLESS_HELP, /^Usage: claude \[options\]/m);
  assert.ok(CLAUDE_HEADLESS_HELP.split("\n").length > 100);
  // The exact fiction the retired fixture carried: real help has never given
  // --system-prompt-file a row of its own, which is why preflight once needed
  // a special case to compensate.
  assert.doesNotMatch(CLAUDE_HEADLESS_HELP, /^\s*--system-prompt-file\b/m);
});

test("wire fixture builders return transparent records with explicit fields", () => {
  const init = initRecord(PROVIDER_INIT_FIELDS, { model: "served-model" });
  assert.equal(init.type, "system");
  assert.equal(init.model, "served-model");
  assert.deepEqual(resultRecord({ is_error: true, terminal_reason: "failed" }), {
    type: "result",
    is_error: true,
    terminal_reason: "failed",
  });
  const events = textResponseEvents("hello", { id: "msg_1", model: "served-model", usage: { output_tokens: 1 } });
  assert.equal(events[0].event.message.id, "msg_1");
  assert.equal(events.at(-1).result, "hello");
});
