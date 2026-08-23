import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_INIT_FIELDS, initRecord, resultRecord, textResponseEvents } from "../support/claude-fixture.js";

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
