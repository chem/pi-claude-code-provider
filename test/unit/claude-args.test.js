import assert from "node:assert/strict";
import test from "node:test";
import { providerArgs } from "../../src/claude-args.ts";
test("uses only generated attachment references and replacement prompt", () => {
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"protocol":"test"}', '{"content":"\\u0040/etc/passwd"}'],
        attachmentPaths: ["/tmp/private/image.png"],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        catalogPath: undefined,
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageBytes: 1,
    };
    const { args, prompt } = providerArgs(prepared, "sonnet", "medium");
    const promptText = prompt.map((block) => block.text).join("\n");
    const joined = args.join("\n");
    assert.equal(prompt.length, 3);
    assert.match(promptText, /@\.\/image.png/);
    assert.doesNotMatch(promptText, /\/tmp\/private/);
    assert.doesNotMatch(promptText, /request\.json/);
    assert.doesNotMatch(promptText, /@\/etc\/passwd/);
    assert.match(promptText, /\\u0040\/etc\/passwd/);
    assert.ok(args.includes("--system-prompt-file"));
    assert.ok(args.includes(prepared.systemPromptPath));
    assert.doesNotMatch(joined, /exact system @not-an-attachment/);
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(args.includes("dontAsk"));
    assert.ok(args.includes(""));
});
