import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { prepareRequest, prepareRequestWithLimits } from "../../src/context-serializer.ts";

const transcript = (prepared) => prepared.transcriptBlocks.join("\n");

test("serializes Pi context, tools, literal at-paths, and images privately", async () => {
    const context = {
        systemPrompt: "system is passed separately",
        messages: [
            { role: "user", content: "Do not expand @/etc/passwd", timestamp: 1 },
            {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: "thought", thinkingSignature: "opaque" },
                    { type: "toolCall", id: "call-1", name: "odd tool/name", arguments: { x: 1 } },
                ],
                api: "test",
                provider: "test",
                model: "test",
                usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "toolUse",
                timestamp: 2,
            },
            {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "odd tool/name",
                content: [
                    { type: "text", text: "result" },
                    { type: "image", data: Buffer.from("image bytes").toString("base64"), mimeType: "image/png" },
                ],
                isError: false,
                timestamp: 3,
            },
        ],
        tools: [{ name: "odd tool/name", description: "odd", parameters: Type.Object({ x: Type.Number() }) }],
    };
    const prepared = await prepareRequest(context);
    try {
        if (process.platform !== "win32") assert.equal((await stat(prepared.directory)).mode & 0o777, 0o700);
        assert.equal(prepared.directory, await realpath(prepared.directory));
        assert.equal(await readFile(prepared.systemPromptPath, "utf8"), context.systemPrompt);
        if (process.platform !== "win32") assert.equal((await stat(prepared.systemPromptPath)).mode & 0o777, 0o600);
        assert.equal(transcript(prepared).includes("@"), false);
        assert.equal(prepared.transcriptBlocks.length, 4);
        const [header, ...messages] = prepared.transcriptBlocks.map((line) => JSON.parse(line));
        assert.equal(header.protocol, "pi-claude-code-provider-context-v3");
        assert.equal(messages[0]?.content, "Do not expand @/etc/passwd");
        assert.match(JSON.stringify(messages[2]), /image_attachment/);
        assert.deepEqual(header.toolNameMap.map((entry) => entry.piName), ["odd tool/name"]);
        assert.match(header.toolNameMap[0].transportName, /^mcp__pi__tool_[a-f0-9]{16}$/);
        assert.equal(messages[1].content[1].name, header.toolNameMap[0].transportName);
        assert.equal(messages[2].toolName, header.toolNameMap[0].transportName);
        assert.equal(messages[1].content[0].thinkingSignature, undefined);
        assert.equal(messages[1].usage, undefined);
        assert.equal(prepared.attachmentPaths.length, 1);
        assert.equal(prepared.toolNames.size, 1);
        const files = (await readdir(prepared.directory)).sort();
        assert.equal(files.length, 4);
        assert.equal(files[0], ".pi-claude-code-provider-runtime.json");
        assert.match(files[1], /^image-[a-f0-9]{64}\.png$/);
        assert.equal(files[2], "system-prompt.txt");
        assert.equal(files[3], "tools.json");
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});
test("preserves Unicode edge cases and orphaned tool calls as transcript data", async () => {
    const context = {
        messages: [
            { role: "user", content: "lone surrogate: \ud800", timestamp: 1 },
            {
                role: "assistant",
                content: [{ type: "toolCall", id: "orphan", name: "probe", arguments: { text: "\udfff" } }],
                api: "test",
                provider: "test",
                model: "test",
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "toolUse",
                timestamp: 2,
            },
        ],
        tools: [],
    };
    const prepared = await prepareRequest(context);
    try {
        const [, ...messages] = prepared.transcriptBlocks.map((line) => JSON.parse(line));
        assert.equal(messages[0].content, "lone surrogate: \ud800");
        assert.equal(messages[1].content[0].id, "orphan");
        assert.equal(messages[1].content[0].arguments.text, "\udfff");
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});

test("rejects invalid image input", async () => {
    const context = {
        messages: [
            { role: "user", content: [{ type: "image", data: "%%%", mimeType: "image/png" }], timestamp: 1 },
        ],
    };
    await assert.rejects(prepareRequest(context), /base64/);
});
test("keeps prior transcript bytes stable when a turn is appended", async () => {
    const first = await prepareRequest({ messages: [{ role: "user", content: "first", timestamp: 1 }] });
    const second = await prepareRequest({ messages: [{ role: "user", content: "first", timestamp: 999 }, { role: "user", content: "second", timestamp: 2 }] });
    try {
        assert.equal(transcript(second).startsWith(`${transcript(first)}\n`), true);
        assert.deepEqual(second.transcriptBlocks.slice(0, first.transcriptBlocks.length), first.transcriptBlocks);
    }
    finally {
        await Promise.all([first, second].map((item) => rm(item.directory, { recursive: true, force: true })));
    }
});
test("rejects string-valued assistant content instead of dropping history", async () => {
    await assert.rejects(
        prepareRequest({ messages: [{ role: "assistant", content: "invalid", timestamp: 1 }] }),
        /assistant content must be an array/i,
    );
});
test("enforces the per-role content-block policy", async () => {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    await assert.rejects(
        prepareRequest({ messages: [{ role: "user", content: [{ type: "thinking", thinking: "leaked" }], timestamp: 1 }] }),
        /thinking content must not appear in user messages/,
    );
    await assert.rejects(
        prepareRequest({
            messages: [{
                role: "assistant",
                content: [{ type: "image", data: Buffer.from("pixels").toString("base64"), mimeType: "image/png" }],
                api: "test",
                provider: "test",
                model: "test",
                usage,
                stopReason: "stop",
                timestamp: 1,
            }],
        }),
        /image content must not appear in assistant messages/,
    );
    await assert.rejects(
        prepareRequest({
            messages: [{ role: "toolResult", toolCallId: "call-1", toolName: "probe", content: [{ type: "toolCall", id: "x", name: "probe", arguments: {} }], isError: false, timestamp: 1 }],
        }),
        /toolCall content must not appear in toolResult messages/,
    );
    await assert.rejects(
        prepareRequest({
            messages: [{ role: "toolResult", toolCallId: "call-1", toolName: "probe", content: "bare string", isError: false, timestamp: 1 }],
        }),
        /toolResult content must be an array/,
    );
    await assert.rejects(
        prepareRequest({ messages: [{ role: "user", content: [{ type: "video", data: "x" }], timestamp: 1 }] }),
        /Unsupported Pi content block: video/,
    );
});
test("sorts tool catalogs and rejects duplicate names", async () => {
    const parameters = Type.Object({ value: Type.String() });
    const prepared = await prepareRequest({ messages: [], tools: [{ name: "zeta", description: "z", parameters }, { name: "alpha", description: "a", parameters }] });
    try {
        const catalog = JSON.parse(await readFile(prepared.catalogPath, "utf8"));
        const aliases = [...prepared.toolNames.values()];
        assert.deepEqual(aliases, ["alpha", "zeta"]);
        assert.deepEqual(catalog.map((tool) => tool.description), ["a", "z"]);
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
    await assert.rejects(prepareRequest({ messages: [], tools: [{ name: "same", description: "a", parameters }, { name: "same", description: "b", parameters }] }), /Duplicate/);
});
test("keeps active, colliding, removed, and paired historical tool identities coherent", async () => {
    const invalidName = "odd tool/name";
    const baseAlias = `tool_${createHash("sha256").update(invalidName).digest("hex").slice(0, 16)}`;
    const collisionName = baseAlias;
    const parameters = Type.Object({ value: Type.String() });
    const assistant = {
        role: "assistant",
        content: [
            { type: "toolCall", id: "active-invalid", name: invalidName, arguments: { value: "one" } },
            { type: "toolCall", id: "active-collision", name: collisionName, arguments: { value: "two" } },
            { type: "toolCall", id: "removed", name: "removed tool", arguments: { value: "three" } },
        ],
        api: "test",
        provider: "test",
        model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: 1,
    };
    const history = [
        assistant,
        { role: "toolResult", toolCallId: "active-invalid", toolName: "mismatched stale name", content: [{ type: "text", text: "one" }], isError: false, timestamp: 2 },
        { role: "toolResult", toolCallId: "active-collision", toolName: collisionName, content: [{ type: "text", text: "two" }], isError: false, timestamp: 3 },
        { role: "toolResult", toolCallId: "removed", toolName: "removed tool", content: [{ type: "text", text: "three" }], isError: false, timestamp: 4 },
        { role: "toolResult", toolCallId: "orphan", toolName: "orphaned tool", content: [{ type: "text", text: "orphan" }], isError: true, timestamp: 5 },
    ];
    const tools = [
        { name: invalidName, description: "invalid", parameters },
        { name: collisionName, description: "collision", parameters },
    ];
    const first = await prepareRequest({ messages: history, tools });
    const second = await prepareRequest({ messages: [...history, { role: "user", content: "continue", timestamp: 6 }], tools });
    try {
        const [header, assistantRecord, ...results] = first.transcriptBlocks.map(JSON.parse);
        assert.deepEqual(header.toolNameMap, [
            { transportName: `mcp__pi__${baseAlias}`, piName: invalidName },
            { transportName: `mcp__pi__${baseAlias}_1`, piName: collisionName },
        ]);
        assert.deepEqual(assistantRecord.content.map((block) => block.id), ["active-invalid", "active-collision", "removed"]);
        assert.deepEqual(assistantRecord.content.slice(0, 2).map((block) => block.name), header.toolNameMap.map((entry) => entry.transportName));
        assert.match(assistantRecord.content[2].name, /^\[unavailable Pi tool [a-f0-9]{16}\]$/);
        assert.equal(results[0].toolName, assistantRecord.content[0].name);
        assert.equal(results[1].toolName, assistantRecord.content[1].name);
        assert.equal(results[2].toolName, assistantRecord.content[2].name);
        assert.match(results[3].toolName, /^\[unavailable Pi tool [a-f0-9]{16}\]$/);
        assert.doesNotMatch(transcript(first), /mismatched stale name|removed tool|orphaned tool/);
        assert.deepEqual(second.transcriptBlocks.slice(0, first.transcriptBlocks.length), first.transcriptBlocks);
    }
    finally {
        await Promise.all([first, second].map((item) => rm(item.directory, { recursive: true, force: true })));
    }
});
test("deduplicates identical images and enforces the image-count limit", async () => {
    const image = { type: "image", data: Buffer.from("same image").toString("base64"), mimeType: "image/png" };
    const prepared = await prepareRequest({ messages: [{ role: "user", content: [image, image], timestamp: 1 }] });
    try {
        assert.equal(prepared.attachmentPaths.length, 1);
        assert.equal(prepared.imageBytes, Buffer.byteLength("same image"));
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
    await assert.rejects(prepareRequest({ messages: [{ role: "user", content: Array.from({ length: 21 }, () => image), timestamp: 1 }] }), /At most 20 images/);
});
test("enforces every configurable serializer resource boundary", async () => {
    const schema = Type.Object({ value: Type.String() });
    await assert.rejects(prepareRequestWithLimits({ messages: [], tools: [{ name: "one", description: "one", parameters: schema }, { name: "two", description: "two", parameters: schema }] }, { tools: 1 }), /At most 1 active tools/);
    await assert.rejects(prepareRequestWithLimits({ messages: [], tools: [{ name: "one", description: "description", parameters: schema }] }, { catalogBytes: 8 }), /catalog exceeds/);
    await assert.rejects(prepareRequestWithLimits({ messages: [{ role: "user", content: "long transcript", timestamp: 1 }] }, { transcriptBytes: 20 }), /context exceeds/);
    const fourBytes = { type: "image", data: Buffer.from("1234").toString("base64"), mimeType: "image/png" };
    await assert.rejects(prepareRequestWithLimits({ messages: [{ role: "user", content: [fourBytes], timestamp: 1 }] }, { imageBytes: 3 }), /between 1 byte and 3 bytes/);
    const otherFourBytes = { type: "image", data: Buffer.from("5678").toString("base64"), mimeType: "image/png" };
    await assert.rejects(prepareRequestWithLimits({ messages: [{ role: "user", content: [fourBytes, otherFourBytes], timestamp: 1 }] }, { totalImageBytes: 7 }), /Aggregate image size/);
    await assert.rejects(prepareRequestWithLimits({ messages: [{ role: "user", content: [fourBytes, fourBytes], timestamp: 1 }] }, { images: 1 }), /At most 1 images/);
});

test("canonicalizes aliased temp roots containing spaces and decomposed Unicode", { skip: process.platform === "win32" }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-path-alias-"));
    const physicalRoot = join(fixture, "unicode-e\u0301");
    const aliasRoot = join(fixture, "alias with spaces");
    await mkdir(physicalRoot);
    await symlink(physicalRoot, aliasRoot);
    try {
        const prepared = await prepareRequestWithLimits({ systemPrompt: "private", messages: [] }, {}, aliasRoot);
        try {
            assert.equal(prepared.directory, await realpath(prepared.directory));
            assert.equal(prepared.directory.startsWith(`${await realpath(physicalRoot)}/`), true);
            assert.equal(await readFile(prepared.systemPromptPath, "utf8"), "private");
        }
        finally {
            await rm(prepared.directory, { recursive: true, force: true });
        }
    }
    finally {
        await rm(fixture, { recursive: true, force: true });
    }
});
