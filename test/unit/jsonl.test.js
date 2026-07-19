import assert from "node:assert/strict";
import test from "node:test";
import { JsonlParser } from "../../src/jsonl.ts";
test("parses split UTF-8 and strict LF records", () => {
    const values = [];
    const parser = new JsonlParser((value) => values.push(value));
    const bytes = Buffer.from(`${JSON.stringify({ text: "snowman ☃ and controls  " })}\r\n{"n":2}`);
    parser.push(bytes.subarray(0, 18));
    parser.push(bytes.subarray(18, 25));
    parser.push(bytes.subarray(25));
    parser.end();
    assert.deepEqual(values, [{ text: "snowman ☃ and controls  " }, { n: 2 }]);
});
test("does not split Unicode line separators inside JSON strings", () => {
    const values = [];
    const parser = new JsonlParser((value) => values.push(value));
    parser.push(Buffer.from(`${JSON.stringify({ text: "a b c" })}\n`));
    parser.end();
    assert.deepEqual(values, [{ text: "a b c" }]);
});
test("rejects malformed and oversized records", () => {
    const malformed = new JsonlParser(() => { });
    assert.throws(() => malformed.push(Buffer.from("nope\n")), /malformed/);
    const oversized = new JsonlParser(() => { }, 4);
    assert.throws(() => oversized.push(Buffer.from("12345")), /oversized/);
});
