import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as piAi from "@earendil-works/pi-ai";
import { createClaudeStream as createProviderStream, isExpectedToolHandoffExit, waitForReadyOrExit } from "../../src/provider.ts";
import { getLastRequestMetrics } from "../../src/metrics.ts";
import { superviseProcess, terminateProcessGroup } from "../../src/process-utils.ts";
import { SessionImageStore } from "../../src/session-image-store.ts";
import { resolveSession } from "../../src/session-registry.ts";
import { nodeFixtureSource } from "../support/node-fixture.js";
import { CAPTURED_CLAUDE_VERSION, PROVIDER_INIT_FIELDS, initRecord, streamRecoveryRecords, toolUseEvents } from "../support/claude-fixture.js";
const model = {
    id: "sonnet",
    name: "Sonnet",
    api: "pi-claude-code-provider-headless",
    provider: "pi-claude-code-provider",
    baseUrl: "pi-claude-code-provider://local",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
};
const baseMessages = [{ role: "user", content: "hello", timestamp: 1 }];
const readTool = { name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } };
// Pi normalizes every request into a transcript before a provider sees it,
// folding `systemPrompt` and `tools` into system messages. Fixtures go through
// Pi's own normalizer so they carry the shape the provider actually receives;
// building the pre-normalization shape by hand would leave those fields where
// the provider never reads them, and the assertions below would measure nothing.
const providerContext = (init = {}) => piAi.normalizeContext({ messages: baseMessages, ...init });
const context = providerContext({ tools: [] });
async function fakeClaude(body, { writeReady = true } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "fake-claude-"));
    const executable = join(dir, process.platform === "win32" ? "claude.cjs" : "claude");
    // Fake protocol output is synchronous only in this test child; some sandboxes
    // otherwise hide buffered Node stdout even when the child exits successfully.
    await writeFile(executable, nodeFixtureSource(`
	const fs = require("node:fs");
	${writeReady ? `
	const mcpIndex = process.argv.indexOf("--mcp-config");
	if (mcpIndex >= 0) {
  const config = JSON.parse(process.argv[mcpIndex + 1]);
  const ready = config.mcpServers?.pi?.env?.PI_CLAUDE_TOOL_READY;
  if (ready) fs.writeFileSync(ready, "ready\\n", { flag: "wx" });
	}` : ""}
	${body}\n`));
    await chmod(executable, 0o700);
    return { dir, executable };
}
const init = initRecord(PROVIDER_INIT_FIELDS);
const toolInit = {
    ...init,
    tools: ["mcp__pi__read"],
    mcp_servers: [{ name: "pi", status: "connected" }],
};
const toolContext = providerContext({ tools: [readTool] });
const { isContextOverflow, isRetryableAssistantError } = piAi;
const toolTerminationResult = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: "tool_use",
    terminal_reason: "aborted_streaming",
    usage: { input_tokens: 4, output_tokens: 2 },
    modelUsage: { sonnet: { contextWindow: 1000000, maxOutputTokens: 64000 } },
};
// The last request's metrics are process-global, so a waiter could match an
// earlier request's record. Snapshot them as each request starts and accept only
// a different record. Two requests started in one millisecond could record
// identical metrics, so each start first waits out the previous request's.
let metricsBeforeRequest;
let lastRequestStartedAt = 0;
// Every provider request runs Claude in Pi's session directory; tests that are
// not about that directory use the temporary root as the session.
function createClaudeStream(installation, dependencies = {}) {
    const streamSimple = createProviderStream(installation, { resolveSession: () => ({ cwd: tmpdir() }), ...dependencies });
    return (...request) => {
        while (Date.now() <= lastRequestStartedAt) { /* wait out the millisecond */ }
        metricsBeforeRequest = JSON.stringify(getLastRequestMetrics() ?? null);
        const stream = streamSimple(...request);
        lastRequestStartedAt = Date.now();
        return stream;
    };
}
async function waitForRequestMetrics(predicate) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const metrics = getLastRequestMetrics();
        if (metrics && JSON.stringify(metrics) !== metricsBeforeRequest && predicate(metrics)) return metrics;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("request metrics did not settle");
}
function supervisorWithCleanupFailure(child, options) {
    const supervisor = superviseProcess(child, options);
    let termination;
    return {
        ...supervisor,
        terminate() {
            termination ??= supervisor.terminate().then(() => { throw new Error("synthetic process-group EPERM"); });
            return termination;
        },
    };
}
test("provider streams a fake response after accepting a rich payload replacement", async () => {
    const fake = await fakeClaude(`
const path = require("node:path");
const privateDirectory = path.dirname(process.argv[process.argv.indexOf("--system-prompt-file") + 1]);
fs.writeFileSync(path.join(__dirname, "captured-preparation"), JSON.stringify({
  systemPrompt: fs.readFileSync(path.join(privateDirectory, "system-prompt.txt"), "utf8"),
  catalog: JSON.parse(fs.readFileSync(path.join(privateDirectory, "tools.json"), "utf8")),
  files: fs.readdirSync(privateDirectory),
}));
setTimeout(() => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_fake",model:"claude-sonnet-5",usage:{input_tokens:0,output_tokens:0}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"text",text:""}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"fake ok"}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"fake ok",usage:{input_tokens:4,output_tokens:2}}) + "\\n");
}, 50);`);
    const replacement = {
        systemPrompt: "replacement system",
        messages: [
            { role: "user", content: "replacement string", timestamp: 2 },
            { role: "user", content: [{ type: "text", text: "replacement blocks" }, { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 3 },
            { role: "assistant", content: [
                { type: "text", text: "assistant text" },
                { type: "thinking", thinking: "assistant thinking", redacted: true },
                { type: "toolCall", id: "call-paired", name: "read", arguments: { path: "README.md" } },
            ], timestamp: 4 },
            { role: "toolResult", toolCallId: "call-paired", toolName: "read", content: [{ type: "text", text: "paired result" }], isError: false, timestamp: 5 },
            { role: "toolResult", toolCallId: "call-orphan", toolName: "removed-tool", content: [{ type: "text", text: "orphan result" }], isError: true, timestamp: 6 },
        ],
        tools: [readTool],
    };
    let claims = 0;
    try {
        const stream = createClaudeStream(
            { executable: fake.executable, version: CAPTURED_CLAUDE_VERSION, subscriptionType: "pro" },
            { claimLaunch: async () => { claims++; } },
        )(model, context, { reasoning: "medium", onPayload: () => replacement });
        const eventTypes = [];
        for await (const event of stream)
            eventTypes.push(event.type);
        const result = await stream.result();
        assert.deepEqual(eventTypes, ["start", "text_start", "text_delta", "text_end", "done"], result.errorMessage);
        assert.equal(result.responseModel, "claude-sonnet-5");
        assert.equal(result.usage.totalTokens, 6);
        assert.equal(result.usage.cost.total, 0);
        assert.equal(result.content[0]?.type, "text");
        assert.equal(claims, 1);
        const captured = JSON.parse(await readFile(join(fake.dir, "captured-preparation"), "utf8"));
        assert.equal(captured.systemPrompt, "replacement system");
        assert.deepEqual(captured.catalog, [{ name: "read", description: "read", inputSchema: readTool.parameters }]);
        assert.ok(captured.files.some((name) => /^image-[0-9a-f]{64}\.png$/.test(name)));
        const metrics = await waitForRequestMetrics((entry) => entry.stopReason === "stop");
        assert.equal(metrics.schemaVersion, 5);
        assert.equal(metrics.messageCount, replacement.messages.length);
        assert.equal(metrics.toolCount, 1);
        assert.equal(metrics.imageCount, 1);
        assert.equal(metrics.terminationExpected, false);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider rejects malformed logical payloads before claim or spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-payload-invalid-"));
    const marker = join(root, "spawned");
    const fake = await fakeClaude(`fs.writeFileSync(${JSON.stringify(marker)}, "spawned");`);
    const circular = {};
    circular.self = circular;
    const cases = [
        [[null], [], /invalid message/],
        [[{ role: "future", content: [] }], [], /Unsupported Pi message role: future/],
        [[{ role: "user", content: [{ type: "text", text: 42 }] }], [], /text content must contain text/],
        [[{ role: "assistant", content: { type: "text", text: "not an array" } }], [], /assistant content must be an array/],
        [[{ role: "assistant", content: [{ type: "thinking", thinking: false }] }], [], /thinking content must contain thinking/],
        [[{ role: "assistant", content: [{ type: "toolCall", id: 1, name: "read", arguments: {} }] }], [], /tool-call ID must be a nonempty string/],
        [[{ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: [] }] }], [], /tool-call arguments must be an object/],
        [[{ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: "false" }], [], /isError must be boolean/],
        [[{ role: "user", content: [{ type: "image", data: "AA==" }] }], [], /string mimeType/],
        [[{ role: "user", content: [{ type: "image", data: 12345678, mimeType: "image/png" }] }], [], /not valid base64/],
        [[{ role: "assistant", content: [{ type: "thinking", thinking: "reasoning", redacted: "true" }] }], [], /thinking redacted must be boolean/],
        [[{ role: "user", content: [{ type: "image", data: "AA==", mimeType: ["image/png"] }] }], [], /string mimeType/],
        [context.messages, [null], /invalid active tool/],
        [context.messages, [{ name: "read", description: "read", parameters: [] }], /active tool schema must be an object/],
        [context.messages, [{ name: "read", description: "read", parameters: circular }], /must be JSON-serializable/],
    ];
    let claims = 0;
    try {
        for (const [messages, tools, expected] of cases) {
            const result = await createClaudeStream(
                { executable: fake.executable, version: "test", subscriptionType: "pro" },
                { claimLaunch: async () => { claims++; } },
            )(model, context, { onPayload: () => ({ messages, tools }) }).result();
            assert.equal(result.stopReason, "error");
            assert.match(result.errorMessage ?? "", expected);
        }
        assert.equal(claims, 0);
        await assert.rejects(access(marker));
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider accepts an empty response with exactly one terminal event", async () => {
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_empty",model:"claude-sonnet-5",usage:{input_tokens:0,output_tokens:0}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"",usage:{input_tokens:3,output_tokens:0}}) + "\\n");
  setTimeout(() => {}, 50);
});`);
    try {
        const stream = createClaudeStream({
            executable: fake.executable,
            version: CAPTURED_CLAUDE_VERSION,
            subscriptionType: "pro",
        })(model, context, { reasoning: "medium" });
        const events = [];
        for await (const event of stream)
            events.push(event.type);
        const result = await stream.result();
        assert.deepEqual(events, ["start", "done"]);
        assert.deepEqual(result.content, []);
        assert.equal(result.usage.totalTokens, 3);
        assert.equal(events.filter((type) => type === "done" || type === "error").length, 1);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider rejects a non-string successful result with exactly one terminal error", async () => {
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:{forged:true}}) + "\\n");
});`);
    try {
        const stream = createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" });
        const events = [];
        for await (const event of stream)
            events.push(event.type);
        const result = await stream.result();
        assert.deepEqual(events, ["start", "error"]);
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /non-string result field/);
        assert.equal(events.filter((type) => type === "done" || type === "error").length, 1);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider reports process-group cleanup rejection instead of leaving the stream unresolved", { skip: process.platform === "win32" }, async () => {
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"must not succeed",usage:{}}) + "\\n");
});`);
    try {
        const result = await Promise.race([
            createClaudeStream(
                { executable: fake.executable, version: "test", subscriptionType: "pro" },
                { supervise: supervisorWithCleanupFailure },
            )(model, context, { reasoning: "medium" }).result(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("provider stream did not settle")), 1000)),
        ]);
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /synthetic process-group EPERM/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process_cleanup");
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider settles once and retains marked state when process death is unknown", { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-unknown-liveness-"));
    const originalTmpdir = process.env.TMPDIR;
    const originalIdle = process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS;
    process.env.TMPDIR = root;
    process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS = "30";
    const fake = await fakeClaude(`setInterval(() => {}, 1000);`);
    let capturedChild;
    const superviseUnknown = (child, options) => {
        capturedChild = child;
        return superviseProcess(child, {
            ...options,
            terminate: async () => { throw new Error("synthetic stubborn provider EPERM"); },
        });
    };
    try {
        const stream = createClaudeStream(
            { executable: fake.executable, version: "test", subscriptionType: "pro" },
            { supervise: superviseUnknown },
        )(model, context, { timeoutMs: 1_000 });
        const events = [];
        let publishedFailure;
        for await (const event of stream) {
            events.push(event.type);
            if (event.type === "error") publishedFailure = event.error.errorMessage;
        }
        const result = await Promise.race([
            stream.result(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("provider stream did not settle")), 500)),
        ]);
        assert.equal(result.stopReason, "error");
        assert.equal(events.filter((type) => type === "error" || type === "done").length, 1);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process_cleanup" && entry.cleanupComplete === false);
        assert.equal(metrics.cleanupComplete, false);
        assert.match(publishedFailure ?? "", /no protocol activity for 30ms/);
        assert.match(result.errorMessage ?? "", /no protocol activity for 30ms/);
        assert.match(result.errorMessage ?? "", /synthetic stubborn provider EPERM/);
        assert.match(result.errorMessage ?? "", /runtime state was retained/);
        assert.equal((result.errorMessage?.match(/synthetic stubborn provider EPERM/g) ?? []).length, 1);
        const directories = (await readdir(root)).filter((name) => name.startsWith("pi-claude-code-provider-request-"));
        assert.equal(directories.length, 1);
        const marker = JSON.parse(await readFile(join(root, directories[0], ".pi-claude-code-provider-runtime.json"), "utf8"));
        assert.equal(marker.childPid, capturedChild.pid);
        assert.doesNotThrow(() => process.kill(capturedChild.pid, 0));
    } finally {
        if (capturedChild) await terminateProcessGroup(capturedChild);
        if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
        if (originalIdle === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS;
        else process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS = originalIdle;
        await rm(root, { recursive: true, force: true });
        await rm(fake.dir, { recursive: true, force: true });
    }
});

test("provider retains request and session images when tree cleanup fails after leader exit", { skip: process.platform === "win32", timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-exited-leader-"));
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const store = new SessionImageStore();
    store.open();
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  const descendant = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio:"ignore"});
  descendant.unref();
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"must not succeed",usage:{}}) + "\\n");
});`);
    let child;
    try {
        const stream = createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" }, {
            resolveSession: () => ({ cwd: root, imageStore: store }),
            supervise: (running, options) => {
                child = running;
                return superviseProcess(running, { ...options, terminate: async () => {
                    assert.equal(running.exitCode, 0);
                    assert.doesNotThrow(() => process.kill(-running.pid, 0));
                    throw new Error("synthetic surviving-group failure");
                } });
            },
        })(model, { messages: [{ role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 }] });
        const result = await stream.result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage, /synthetic surviving-group failure/);
        assert.match(result.errorMessage, /runtime state was retained/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process_cleanup");
        assert.equal(metrics.cleanupComplete, false);
        await store.close();
        const entries = await readdir(root);
        assert.equal(entries.filter((name) => name.startsWith("pi-claude-code-provider-request-")).length, 1);
        const images = entries.filter((name) => name.startsWith("pi-claude-code-provider-images-"));
        assert.equal(images.length, 1);
        assert.equal((await readdir(join(root, images[0]))).filter((name) => name.endsWith(".png")).length, 1);
    } finally {
        if (child) await terminateProcessGroup(child);
        await store.close();
        if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
        await rm(root, { recursive: true, force: true });
    }
});
test("provider runs Claude in the session directory and commits success only after private-state cleanup", async () => {
    const sessionDirectory = await mkdtemp(join(tmpdir(), "provider-session-directory-"));
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  const reported = JSON.stringify({ cwd: process.cwd(), privateDirectory: require("node:path").dirname(process.argv[process.argv.indexOf("--system-prompt-file") + 1]) });
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:reported,usage:{input_tokens:1,output_tokens:1}}) + "\\n");
});`);
    try {
        const result = await createClaudeStream(
            { executable: fake.executable, version: "test", subscriptionType: "pro" },
            { resolveSession: () => ({ cwd: sessionDirectory }) },
        )(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        const reported = JSON.parse(result.content.find((block) => block.type === "text")?.text ?? "{}");
        // Claude Code reports its cwd to the model, so it must be Pi's directory,
        // while private request state stays in, and is removed with, its own directory.
        assert.equal(await realpath(reported.cwd), await realpath(sessionDirectory));
        assert.notEqual(reported.privateDirectory, reported.cwd);
        await assert.rejects(access(reported.privateDirectory));
        await access(sessionDirectory);
    }
    finally {
        await Promise.all([fake.dir, sessionDirectory].map((directory) => rm(directory, { recursive: true, force: true })));
    }
});

test("tool-bearing side requests use a declared cwd, while markerless requests refuse or explicitly borrow", async () => {
    const parent = await mkdtemp(join(tmpdir(), "provider-parent-cwd-"));
    const child = await mkdtemp(join(tmpdir(), "provider-child-cwd-"));
    const spawnMarker = join(parent, "spawned");
    const fake = await fakeClaude(`
fs.writeFileSync(${JSON.stringify(spawnMarker)}, process.cwd());
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"ok",usage:{}}) + "\\n");
});`);
    const registry = new Map([["parent", { cwd: parent }]]);
    const installation = { executable: fake.executable, version: "test", subscriptionType: "pro" };
    const run = (systemPrompt, options = {}, allowBorrowSoleDirectory = false) => createClaudeStream(installation, {
        resolveSession: (request) => resolveSession(registry, { ...request, allowBorrowSoleDirectory }),
    })(model, providerContext({ tools: [readTool], systemPrompt }), options).result();
    const instructions = "You are the main-session subagent watchdog for Pi.\nReview only the supplied parent turn delta.";
    const proseOnly = `${instructions}\nWorking directory: ${child}`;
    try {
        const childTurn = await run(`Child agent\nCurrent working directory: ${child}`, { sessionId: "unregistered-child" });
        assert.equal(childTurn.stopReason, "stop", childTurn.errorMessage);
        assert.equal(await realpath(await readFile(spawnMarker, "utf8")), await realpath(child));
        assert.equal((await waitForRequestMetrics((entry) => entry.sessionResolution === "prompt")).errorCategory, undefined);
        await rm(spawnMarker);

        // pi-subagents HEAD sends this <cwd> in its leading system message,
        // alongside the helper's tool declarations.
        const watchdog = await run(`${instructions}\n\n<cwd>\n${child}\n</cwd>`);
        assert.equal(watchdog.stopReason, "stop", watchdog.errorMessage);
        assert.equal(await realpath(await readFile(spawnMarker, "utf8")), await realpath(child));
        assert.equal((await waitForRequestMetrics((entry) => entry.sessionResolution === "prompt")).errorCategory, undefined);
        await rm(spawnMarker);

        const refused = await run(proseOnly);
        assert.equal(refused.stopReason, "error");
        assert.match(refused.errorMessage ?? "", /refusing to borrow the sole live session/);
        assert.equal((await waitForRequestMetrics((entry) => entry.errorCategory === "working_directory")).sessionResolution, undefined);
        await assert.rejects(access(spawnMarker));

        const borrowed = await run(proseOnly, {}, true);
        assert.equal(borrowed.stopReason, "stop", borrowed.errorMessage);
        assert.equal(await realpath(await readFile(spawnMarker, "utf8")), await realpath(parent));
        assert.equal((await waitForRequestMetrics((entry) => entry.sessionResolution === "single")).errorCategory, undefined);
    } finally {
        await Promise.all([parent, child, fake.dir].map((directory) => rm(directory, { recursive: true, force: true })));
    }
});

test("a payload hook cannot add tools to a markerless tool-free borrow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-oneshot-cwd-"));
    let claims = 0;
    try {
        const result = await createClaudeStream(
            { executable: "/unused/claude", version: "test", subscriptionType: "pro" },
            {
                resolveSession: (request) => resolveSession(new Map([["parent", { cwd: directory }]]), request),
                claimLaunch: async () => { claims += 1; },
            },
        )(model, context, { onPayload: (payload) => ({ ...payload, tools: [readTool] }) }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /gained tools after before_provider_request/);
        assert.equal(claims, 0);
        assert.equal((await waitForRequestMetrics((entry) => entry.errorCategory === "working_directory")).sessionResolution, "oneshot");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a transcript declaring no prompt or tools reaches the hook as absent, not empty", async () => {
    let routed;
    let payload;
    const result = await createClaudeStream(
        { executable: "/unused/claude", version: "test", subscriptionType: "pro" },
        {
            resolveSession: (request) => { routed = request; return { cwd: tmpdir() }; },
            claimLaunch: async () => { throw new Error("stop before launch"); },
        },
    )(model, context, { onPayload: (value) => { payload = value; } }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /stop before launch/);
    assert.equal(routed.systemPrompt, undefined);
    assert.equal(routed.hasTools, false);
    assert.deepEqual(payload, { systemPrompt: undefined, messages: baseMessages, tools: undefined });
});

test("0.86 transcript replay routes a child and sends current prompt, tools, and history", async () => {
    const parent = await mkdtemp(join(tmpdir(), "provider-parent-transcript-"));
    const child = await mkdtemp(join(tmpdir(), "provider-child-transcript-"));
    const updatedRead = { ...readTool, description: "updated read" };
    const hookRead = { ...updatedRead, description: "hook read" };
    const initial = {
        role: "system", content: "Base instruction",
        sections: {
            project_context: "<project_context>\n<cwd>\n/incorrect\n</cwd>\n</project_context>",
            cwd: `<cwd>\n${child}\n</cwd>`,
            obsolete: "<obsolete>old</obsolete>",
            guidance: "<guidance>first</guidance>",
        },
        toolsAdded: [readTool], timestamp: 0,
    };
    const update = {
        role: "system", content: "Additional instruction",
        sections: { obsolete: null, guidance: "<guidance>current</guidance>" },
        toolsRemoved: [{ name: "read" }], toolsAdded: [updatedRead], timestamp: 2,
    };
    const input = { messages: [initial, context.messages[0], update] };
    const expectedPrompt = [
        "Base instruction", "Additional instruction", initial.sections.project_context,
        initial.sections.cwd, "<guidance>current</guidance>",
    ].join("\n\n");
    const fake = await fakeClaude(`
const path = require("node:path");
const privateDirectory = path.dirname(process.argv[process.argv.indexOf("--system-prompt-file") + 1]);
fs.writeFileSync(path.join(__dirname, "captured-transcript"), JSON.stringify({
  cwd: process.cwd(),
  prompt: fs.readFileSync(path.join(privateDirectory, "system-prompt.txt"), "utf8"),
  catalog: JSON.parse(fs.readFileSync(path.join(privateDirectory, "tools.json"), "utf8")),
}));
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"ok",usage:{}}) + "\\n");
});`);
    let routed;
    let hooked;
    try {
        const result = await createClaudeStream(
            { executable: fake.executable, version: "test", subscriptionType: "pro" },
            { resolveSession: (request) => { routed = request; return resolveSession(new Map([["parent", { cwd: parent }]]), request); } },
        )(model, input, {
            sessionId: "child",
            onPayload: (payload) => { hooked = payload; return { ...payload, tools: [hookRead] }; },
        }).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.equal(routed.systemPrompt, expectedPrompt);
        assert.equal(routed.hasTools, true);
        assert.equal(hooked.systemPrompt, expectedPrompt);
        assert.deepEqual(hooked.messages, context.messages);
        assert.deepEqual(hooked.tools, [updatedRead]);
        const captured = JSON.parse(await readFile(join(fake.dir, "captured-transcript"), "utf8"));
        assert.equal(await realpath(captured.cwd), await realpath(child));
        assert.equal(captured.prompt, expectedPrompt);
        assert.deepEqual(captured.catalog, [{ name: "read", description: "hook read", inputSchema: hookRead.parameters }]);
        assert.equal((await waitForRequestMetrics((entry) => entry.stopReason === "stop")).sessionResolution, "prompt");
    } finally {
        await Promise.all([parent, child, fake.dir].map((directory) => rm(directory, { recursive: true, force: true })));
    }
});

test("0.86 transcript one-shot borrowing refuses tools added by the payload hook", async () => {
    let claims = 0;
    const result = await createClaudeStream(
        { executable: "/unused/claude", version: "test", subscriptionType: "pro" },
        {
            resolveSession: (request) => resolveSession(new Map([["parent", { cwd: tmpdir() }]]), request),
            claimLaunch: async () => { claims += 1; },
        },
    )(model, { messages: [{ role: "system", content: "Summary", timestamp: 0 }, ...baseMessages] }, {
        sessionId: "summary",
        onPayload: (payload) => ({ ...payload, tools: [readTool] }),
    }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /gained tools after before_provider_request/);
    assert.equal(claims, 0);
});
test("provider forwards and reserves Pi's effective per-request output limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-max-tokens-"));
    const marker = join(directory, "max-tokens");
    const fake = await fakeClaude(`
fs.writeFileSync(${JSON.stringify(marker)}, process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? "missing");
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"bounded",usage:{},modelUsage:{sonnet:{contextWindow:3000,maxOutputTokens:64000}}}) + "\\n");
});`);
    try {
        const boundedModel = { ...model, contextWindow: 3_000, maxTokens: 64_000 };
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(
            boundedModel,
            context,
            { maxTokens: 2_048 },
        ).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.equal(await readFile(marker, "utf8"), "2048");
        assert.equal(getLastRequestMetrics()?.servedMaxOutputTokens, 64_000);
    } finally {
        await rm(directory, { recursive: true, force: true });
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("Haiku omits effort while recording Claude Code's default", async () => {
    const fake = await fakeClaude(`
fs.writeFileSync(require("node:path").join(__dirname, "argv.json"), JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"haiku ok",usage:{},modelUsage:{haiku:{contextWindow:200000,maxOutputTokens:32000}}}) + "\\n");
});`);
    try {
        const haiku = { ...model, id: "haiku", name: "Haiku", reasoning: false, contextWindow: 200_000, maxTokens: 32_000 };
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(haiku, context, { reasoning: "off" }).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        const args = JSON.parse(await readFile(join(fake.dir, "argv.json"), "utf8"));
        assert.equal(args.includes("--effort"), false);
        const metrics = await waitForRequestMetrics((entry) => entry.requestedModel === "haiku" && entry.stopReason === "stop");
        assert.equal(metrics.effort, "default");
    } finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider rejects a model without a usable output maximum before claiming a launch", async () => {
    let claims = 0;
    const invalidModel = { ...model, maxTokens: undefined };
    const result = await createClaudeStream(
        { executable: "/does/not/matter", version: "test", subscriptionType: "pro" },
        { claimLaunch: async () => { claims++; } },
    )(invalidModel, context, { maxTokens: 2_048 }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /maxTokens must be a positive integer/);
    assert.equal(claims, 0);
});
test("provider rejects a successful result followed by nonzero exit", async () => {
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"must not succeed",usage:{}}) + "\\n", () => process.exit(7));
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /successful result \(code 7/);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider keeps the exit diagnostic when overage is administratively disabled", async () => {
    // An advisory rate-limit event must never replace the real reason a Claude
    // process died, and must not mislabel the failure as a rate limit.
    const rateLimitInfo = {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.11,
        resetsAt: 1_800_000_000,
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
    };
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"rate_limit_event",rate_limit_info:${JSON.stringify(rateLimitInfo)}}) + "\\n", () => process.exit(9));
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /exited before a terminal event \(code 9/);
        assert.doesNotMatch(result.errorMessage ?? "", /rate limit/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process_exit" && entry.exitCode === 9);
        assert.equal(metrics.lastPhase, "process_exited");
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider rejects a process that hangs after a successful result", async () => {
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"must not finish early",usage:{}}) + "\\n");
  setInterval(() => {}, 1000);
});`);
    const originalIdle = process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS;
    process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS = "30";
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium", timeoutMs: 1000 }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /no protocol activity for 30ms/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process");
        assert.equal(metrics.terminationExpected, false);
    }
    finally {
        if (originalIdle === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS;
        else process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS = originalIdle;
        await rm(fake.dir, { recursive: true, force: true });
    }
});

test("provider aborts and returns an aborted terminal event", async () => {
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_abort",model:"claude-sonnet-5",usage:{input_tokens:0,output_tokens:0}}}}) + "\\n");
setInterval(() => {}, 1000);`);
    try {
        const controller = new AbortController();
        const stream = createClaudeStream({
            executable: fake.executable,
            version: CAPTURED_CLAUDE_VERSION,
            subscriptionType: "pro",
        })(model, context, { reasoning: "medium", signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        const events = [];
        for await (const event of stream) events.push(event.type);
        const result = await stream.result();
        assert.equal(result.stopReason, "aborted");
        assert.match(result.errorMessage ?? "", /aborted/);
        assert.equal(events.filter((type) => type === "done" || type === "error").length, 1);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "aborted");
        assert.equal(metrics.terminationExpected, true);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider does not spawn Claude for an already-aborted request", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-pre-abort-"));
    const marker = join(root, "spawned");
    const temporaryRootVariable = process.platform === "win32" ? "TEMP" : "TMPDIR";
    const originalTemporaryRoot = process.env[temporaryRootVariable];
    process.env[temporaryRootVariable] = root;
    try {
        assert.equal(tmpdir(), root);
        const fake = await fakeClaude(`fs.writeFileSync(${JSON.stringify(marker)}, "spawned");`);
        const controller = new AbortController();
        controller.abort();
        const stream = createClaudeStream({
            executable: fake.executable,
            version: "test",
            subscriptionType: "pro",
        })(model, context, { reasoning: "medium", signal: controller.signal });
        const events = [];
        for await (const event of stream)
            events.push(event.type);
        const result = await stream.result();
        assert.deepEqual(events, ["error"]);
        assert.equal(result.stopReason, "aborted");
        assert.match(result.errorMessage ?? "", /aborted/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "aborted" && entry.lastPhase === "prepared");
        assert.equal(metrics.terminationExpected, false);
        await assert.rejects(access(marker));
        let privateDirectories = [];
        for (let attempt = 0; attempt < 20; attempt++) {
            privateDirectories = (await readdir(root)).filter((name) => name.startsWith("pi-claude-code-provider-"));
            if (privateDirectories.length === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.deepEqual(privateDirectories, []);
    }
    finally {
        if (originalTemporaryRoot === undefined) delete process.env[temporaryRootVariable];
        else process.env[temporaryRootVariable] = originalTemporaryRoot;
        await rm(root, { recursive: true, force: true });
    }
});
test("provider does not spawn Claude when the request aborts during the launch claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-claim-abort-"));
    const marker = join(root, "spawned");
    const temporaryRootVariable = process.platform === "win32" ? "TEMP" : "TMPDIR";
    const originalTemporaryRoot = process.env[temporaryRootVariable];
    process.env[temporaryRootVariable] = root;
    try {
        assert.equal(tmpdir(), root);
        const fake = await fakeClaude(`fs.writeFileSync(${JSON.stringify(marker)}, "spawned");`);
        const controller = new AbortController();
        const abortDuringClaim = async () => {
            controller.abort();
            await new Promise((resolve) => setImmediate(resolve));
        };
        const stream = createClaudeStream({
            executable: fake.executable,
            version: "test",
            subscriptionType: "pro",
        }, { claimLaunch: abortDuringClaim })(model, context, { reasoning: "medium", signal: controller.signal });
        const result = await stream.result();
        assert.equal(result.stopReason, "aborted");
        assert.match(result.errorMessage ?? "", /aborted/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "aborted" && entry.lastPhase === "prepared");
        assert.equal(metrics.terminationExpected, false);
        await assert.rejects(access(marker));
        let privateDirectories = [];
        for (let attempt = 0; attempt < 20; attempt++) {
            privateDirectories = (await readdir(root)).filter((name) => name.startsWith("pi-claude-code-provider-"));
            if (privateDirectories.length === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.deepEqual(privateDirectories, []);
    }
    finally {
        if (originalTemporaryRoot === undefined) delete process.env[temporaryRootVariable];
        else process.env[temporaryRootVariable] = originalTemporaryRoot;
        await rm(root, { recursive: true, force: true });
    }
});
test("provider rejects invalid timeout configuration before spawning Claude", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-timeout-config-"));
    const marker = join(root, "spawned");
    const fake = await fakeClaude(`fs.writeFileSync(${JSON.stringify(marker)}, "spawned");`);
    const originalIdle = process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS;
    process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS = "banana";
    try {
        const result = await createClaudeStream({
            executable: fake.executable,
            version: "test",
            subscriptionType: "pro",
        })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /positive integer/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "timeout_config");
        assert.equal(metrics.lastPhase, "prepared");
        await assert.rejects(access(marker));
    }
    finally {
        if (originalIdle === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS;
        else process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS = originalIdle;
        await Promise.all([fake.dir, root].map((directory) => rm(directory, { recursive: true, force: true })));
    }
});

test("provider accepts Node's maximum timer delay and rejects the next millisecond before launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-timeout-boundary-"));
    const marker = join(root, "spawned");
    const fake = await fakeClaude(`fs.writeFileSync(${JSON.stringify(marker)}, "spawned"); process.exit(0);`);
    const names = [
        "PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS",
        "PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS",
        "PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS",
    ];
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning);
    process.on("warning", onWarning);
    try {
        for (const name of names) process.env[name] = "2147483647";
        await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
        assert.equal(await readFile(marker, "utf8"), "spawned");
        await rm(marker);
        for (const name of names) {
            process.env[name] = "2147483648";
            const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
            assert.equal(result.stopReason, "error");
            assert.match(result.errorMessage ?? "", /2147483647/);
            await waitForRequestMetrics((entry) => entry.errorCategory === "timeout_config");
            await assert.rejects(access(marker));
            process.env[name] = "2147483647";
        }
        assert.equal(warnings.some((warning) => warning.name === "TimeoutOverflowWarning"), false);
    } finally {
        process.off("warning", onWarning);
        for (const name of names) {
            if (original[name] === undefined) delete process.env[name];
            else process.env[name] = original[name];
        }
        await Promise.all([fake.dir, root].map((directory) => rm(directory, { recursive: true, force: true })));
    }
});
test("provider rejects tool calls against its private transport directory", async () => {
    const fake = await fakeClaude(`
process.on("SIGTERM", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolTerminationResult)}) + "\\n", () => process.exit(143));
});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_private",model:"claude-sonnet-5",usage:{input_tokens:0,output_tokens:0}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"toolu_private",name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:JSON.stringify({path:require("node:path").dirname(process.argv[process.argv.indexOf("--system-prompt-file") + 1]) + "/request.json"})}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const stream = createClaudeStream({
            executable: fake.executable,
            version: CAPTURED_CLAUDE_VERSION,
            subscriptionType: "pro",
        })(model, toolContext, { reasoning: "medium" });
        const result = await stream.result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /provider-private transport state/);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
// These cases start the real MCP bridge. Restricted sandboxes can drop live
// stdin to nested Node children, which makes readiness time out independently
// of provider behavior; run this integration coverage outside the sandbox.
test("provider checks MCP execution violations after tool-use termination", async () => {
    const fake = await fakeClaude(`
const violationConfigIndex = process.argv.indexOf("--mcp-config");
const violationConfig = JSON.parse(process.argv[violationConfigIndex + 1]);
const violation = violationConfig.mcpServers.pi.env.PI_CLAUDE_TOOL_VIOLATION;
if (${JSON.stringify(process.platform === "win32")}) fs.writeFileSync(violation, "attempt\\n", {flag:"wx"});
else process.on("SIGTERM", () => {
  fs.writeFileSync(violation, "attempt\\n", {flag:"wx"});
  process.stdout.write(JSON.stringify(${JSON.stringify(toolTerminationResult)}) + "\\n", () => process.exit(143));
});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  for (const record of ${JSON.stringify(toolUseEvents({ messageId: "msg_violation", toolUseId: "toolu_violation" }))}) process.stdout.write(JSON.stringify(record) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /Security invariant violated/);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider preserves MCP violation diagnostics when private cleanup also fails", async () => {
    const fake = await fakeClaude(`
const violationConfigIndex = process.argv.indexOf("--mcp-config");
const violationConfig = JSON.parse(process.argv[violationConfigIndex + 1]);
const violation = violationConfig.mcpServers.pi.env.PI_CLAUDE_TOOL_VIOLATION;
if (${JSON.stringify(process.platform === "win32")}) fs.writeFileSync(violation, "attempt\\n", {flag:"wx"});
else process.on("SIGTERM", () => {
  fs.writeFileSync(violation, "attempt\\n", {flag:"wx"});
  process.stdout.write(JSON.stringify(${JSON.stringify(toolTerminationResult)}) + "\\n", () => process.exit(143));
});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  for (const record of ${JSON.stringify(toolUseEvents({ messageId: "msg_cleanup_violation", toolUseId: "toolu_cleanup_violation" }))}) process.stdout.write(JSON.stringify(record) + "\\n");
  setInterval(() => {}, 1000);
});`);
    let privateDirectory;
    let cleanupAttempts = 0;
    const failCleanup = async (directory) => {
        privateDirectory = directory;
        cleanupAttempts++;
        throw new Error("synthetic cleanup failure");
    };
    try {
        const result = await createClaudeStream(
            { executable: fake.executable, version: "test", subscriptionType: "pro" },
            { cleanupDirectory: failCleanup },
        )(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /Security invariant violated/);
        assert.match(result.errorMessage ?? "", /private request cleanup failed: synthetic cleanup failure/);
        for (
            let attempt = 0;
            attempt < 20 && (cleanupAttempts < 2 || getLastRequestMetrics()?.cleanupComplete !== false);
            attempt++
        ) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(getLastRequestMetrics()?.errorCategory, "mcp_execution");
        assert.equal(getLastRequestMetrics()?.cleanupComplete, false);
        assert.ok(cleanupAttempts >= 2);
    }
    finally {
        if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("accepts only the platform-specific provider-terminated handoff exit", () => {
    assert.equal(isExpectedToolHandoffExit({ code: 143, signal: null }, "linux"), true);
    assert.equal(isExpectedToolHandoffExit({ code: 1, signal: null }, "win32"), true);
    assert.equal(isExpectedToolHandoffExit({ code: 143, signal: null }, "win32"), false);
    assert.equal(isExpectedToolHandoffExit({ code: 1, signal: "SIGTERM" }, "win32"), false);
    for (const signal of ["SIGTERM", "SIGKILL"]) {
        assert.equal(isExpectedToolHandoffExit({ code: null, signal }, "linux"), false);
        assert.equal(isExpectedToolHandoffExit({ code: null, signal, terminationSignals: [signal] }, "linux"), true);
        assert.equal(isExpectedToolHandoffExit({ code: null, signal, terminationSignals: [signal] }, "win32"), false);
    }
    assert.equal(isExpectedToolHandoffExit({ code: null, signal: "SIGKILL", terminationSignals: ["SIGTERM"] }, "linux"), false);
    assert.equal(isExpectedToolHandoffExit({ code: null, signal: "SIGTERM", terminationSignals: ["SIGTERM", "SIGKILL"] }, "linux"), true);
    assert.equal(isExpectedToolHandoffExit({ code: null, signal: "SIGINT", terminationSignals: ["SIGINT"] }, "linux"), false);
});

test("provider accepts an exact-PID Windows tool handoff", { skip: process.platform !== "win32" }, async () => {
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  for (const record of ${JSON.stringify(toolUseEvents({ messageId: "msg_windows_tool", toolUseId: "toolu_windows", partialJson: '{"path":"package.json"}' }))}) process.stdout.write(JSON.stringify(record) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "toolUse");
        const metrics = await waitForRequestMetrics((entry) => entry.stopReason === "toolUse" && entry.exitCode === 1);
        assert.equal(metrics.exitSignal, null);
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});

test("provider accepts the captured Claude tool-handoff acknowledgement after cleanup", { skip: process.platform === "win32" }, async () => {
    const fake = await fakeClaude(`
process.on("SIGTERM", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolTerminationResult)}) + "\\n", () => process.exit(143));
});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_tool",model:"claude-sonnet-5",usage:{input_tokens:0,output_tokens:0}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:require("node:path").dirname(process.argv[process.argv.indexOf("--system-prompt-file") + 1]),name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"path":"README.md"}'}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const stream = createClaudeStream({
            executable: fake.executable,
            version: CAPTURED_CLAUDE_VERSION,
            subscriptionType: "pro",
        })(model, toolContext, { reasoning: "medium" });
        const result = await stream.result();
        assert.equal(result.stopReason, "toolUse");
        const toolCall = result.content.find((block) => block.type === "toolCall");
        assert.ok(toolCall);
        await assert.rejects(access(toolCall.id));
        const metrics = await waitForRequestMetrics((entry) => entry.stopReason === "toolUse");
        assert.equal(result.usage.totalTokens, 6);
        assert.equal(metrics.terminationExpected, true);
        assert.equal(metrics.lastPhase, "completed");
        assert.equal(metrics.exitCode, 143);
        assert.equal(metrics.exitSignal, null);
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider settles and retains marked state when tool-handoff termination fails", { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-tool-cleanup-failure-"));
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  for (const record of ${JSON.stringify(toolUseEvents({ messageId: "msg_tool_cleanup", toolUseId: "toolu_cleanup", partialJson: '{"path":"package.json"}', messageStop: true }))}) process.stdout.write(JSON.stringify(record) + "\\n");
  setInterval(() => {}, 1000);
});`);
    let capturedChild;
    const superviseCleanupFailure = (child, options) => {
        capturedChild = child;
        return superviseProcess(child, {
            ...options,
            terminate: async () => { throw new Error("synthetic tool handoff EPERM"); },
        });
    };
    try {
        const stream = createClaudeStream(
            { executable: fake.executable, version: "test", subscriptionType: "pro" },
            { supervise: superviseCleanupFailure },
        )(model, toolContext, { reasoning: "medium" });
        const events = [];
        let publishedFailure;
        for await (const event of stream) {
            events.push(event.type);
            if (event.type === "error") publishedFailure = event.error.errorMessage;
        }
        const result = await Promise.race([
            stream.result(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("tool-handoff stream did not settle")), 500)),
        ]);
        assert.equal(result.stopReason, "error");
        assert.equal(events.filter((type) => type === "error" || type === "done").length, 1);
        assert.equal(publishedFailure, result.errorMessage);
        assert.match(result.errorMessage ?? "", /synthetic tool handoff EPERM/);
        assert.match(result.errorMessage ?? "", /runtime state was retained/);
        const metrics = await waitForRequestMetrics((entry) =>
            entry.errorCategory === "process_cleanup" && entry.cleanupComplete === false && entry.terminationExpected === true
        );
        assert.equal(metrics.stopReason, "error");
        const directories = (await readdir(root)).filter((name) => name.startsWith("pi-claude-code-provider-request-"));
        assert.equal(directories.length, 1);
        const marker = JSON.parse(await readFile(join(root, directories[0], ".pi-claude-code-provider-runtime.json"), "utf8"));
        assert.equal(marker.childPid, capturedChild.pid);
        assert.doesNotThrow(() => process.kill(capturedChild.pid, 0));
    }
    finally {
        if (capturedChild) await terminateProcessGroup(capturedChild);
        if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
        await rm(root, { recursive: true, force: true });
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider accepts an exit-143 tool handoff when Claude emits no acknowledgement", { skip: process.platform === "win32" }, async () => {
    const fake = await fakeClaude(`
process.on("SIGTERM", () => process.exit(143));
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  for (const record of ${JSON.stringify(toolUseEvents({ messageId: "msg_missing_ack", toolUseId: "toolu_missing_ack", partialJson: '{"path":"package.json"}' }))}) process.stdout.write(JSON.stringify(record) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: CAPTURED_CLAUDE_VERSION, subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "toolUse");
        const metrics = await waitForRequestMetrics((entry) => entry.stopReason === "toolUse" && entry.exitCode === 143);
        assert.equal(metrics.lastPhase, "completed");
        assert.equal(metrics.errorCategory, undefined);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider rejects an unexpected exit after the tool-handoff acknowledgement", { skip: process.platform === "win32" }, async () => {
    const fake = await fakeClaude(`
process.on("SIGTERM", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolTerminationResult)}) + "\\n", () => process.exit(1));
});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  for (const record of ${JSON.stringify(toolUseEvents({ messageId: "msg_bad_exit", toolUseId: "toolu_bad_exit", partialJson: '{"path":"package.json"}' }))}) process.stdout.write(JSON.stringify(record) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: CAPTURED_CLAUDE_VERSION, subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /tool handoff exited unexpectedly.*code 1/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process_exit" && entry.exitCode === 1);
        assert.equal(metrics.lastPhase, "process_exited");
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider accepts its own SIGKILL escalation after tool-handoff cleanup", { skip: process.platform === "win32" }, async () => {
    const fake = await fakeClaude(`
process.on("SIGTERM", () => {});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  for (const record of ${JSON.stringify(toolUseEvents({ messageId: "msg_bad_signal", toolUseId: "toolu_bad_signal", partialJson: '{"path":"package.json"}' }))}) process.stdout.write(JSON.stringify(record) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: CAPTURED_CLAUDE_VERSION, subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "toolUse");
        assert.equal(result.content.find((block) => block.type === "toolCall")?.name, "read");
        const metrics = await waitForRequestMetrics((entry) => entry.stopReason === "toolUse" && entry.exitSignal === "SIGKILL");
        assert.equal(metrics.lastPhase, "completed");
        assert.equal(metrics.cleanupComplete, true);
        assert.equal(metrics.errorCategory, undefined);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider rejects SIGKILL when it only sent SIGTERM", { skip: process.platform === "win32" }, async () => {
    const fake = await fakeClaude(`
process.on("SIGTERM", () => process.kill(process.pid, "SIGKILL"));
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  for (const record of ${JSON.stringify(toolUseEvents({ messageId: "msg_external_signal", toolUseId: "toolu_external_signal", partialJson: '{"path":"package.json"}' }))}) process.stdout.write(JSON.stringify(record) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: CAPTURED_CLAUDE_VERSION, subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /tool handoff exited unexpectedly.*SIGKILL/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process_exit" && entry.exitSignal === "SIGKILL");
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("caller abort wins after a tool proposal and before acknowledgement", { skip: process.platform === "win32" }, async () => {
    const markerDirectory = await mkdtemp(join(tmpdir(), "provider-tool-abort-"));
    const marker = join(markerDirectory, "tool-proposed");
    const fake = await fakeClaude(`
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(marker)}, "terminated");
  setTimeout(() => process.stdout.write(JSON.stringify(${JSON.stringify(toolTerminationResult)}) + "\\n", () => process.exit(143)), 100);
});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  for (const record of ${JSON.stringify(toolUseEvents({ messageId: "msg_abort_ack", toolUseId: "toolu_abort_ack", partialJson: '{"path":"package.json"}' }))}) process.stdout.write(JSON.stringify(record) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const controller = new AbortController();
        const stream = createClaudeStream({ executable: fake.executable, version: CAPTURED_CLAUDE_VERSION, subscriptionType: "pro" })(model, toolContext, { reasoning: "medium", signal: controller.signal });
        for (let attempt = 0; attempt < 200; attempt++) {
            try {
                await access(marker);
                break;
            }
            catch {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        }
        await access(marker);
        controller.abort();
        const result = await stream.result();
        assert.equal(result.stopReason, "aborted");
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "aborted" && entry.requestedModel === "sonnet");
        assert.equal(metrics.lastPhase, "process_exited");
        assert.notEqual(metrics.stopReason, "toolUse");
    }
    finally {
        await Promise.all([fake.dir, markerDirectory].map((directory) => rm(directory, { recursive: true, force: true })));
    }
});
test("provider reports malformed JSONL and early MCP exit without hanging", async () => {
    const malformed = await fakeClaude(`process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{bad\\n"));`);
    try {
        const result = await createClaudeStream({ executable: malformed.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /JSON|record/i);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "protocol_invalid_json");
        assert.equal(metrics.terminationExpected, false);
    }
    finally {
        await rm(malformed.dir, { recursive: true, force: true });
    }
    const early = await fakeClaude(`process.exit(7);`, { writeReady: false });
    const started = Date.now();
    try {
        const result = await createClaudeStream({ executable: early.executable, version: "test", subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /exited before.*became ready/);
        assert.ok(Date.now() - started < 1000);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "mcp_startup");
        assert.equal(metrics.terminationExpected, false);
    }
    finally {
        await rm(early.dir, { recursive: true, force: true });
    }
});
test("MCP readiness has a bounded timeout even while the process remains alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-ready-timeout-"));
    try {
        await assert.rejects(waitForReadyOrExit(join(directory, "missing"), 20, undefined, new Promise(() => { })), /did not become ready within 20ms/);
        // The failure mode this timeout actually reports is an unlaunchable bridge,
        // so it must carry the resolved command and Claude's own first-hand output.
        await assert.rejects(
            waitForReadyOrExit(join(directory, "missing"), 20, undefined, new Promise(() => { }), {
                bridgeArgv: ["/opt/pi/pi", "--config=/priv/bunfig.toml", "/pkg/bridge.js"],
                stderr: () => "  MCP server \"pi\" failed to connect\n",
            }),
            (error) => /launch argv: \["\/opt\/pi\/pi","--config=/.test(error.message)
                && /stderr: MCP server "pi" failed to connect/.test(error.message)
                && /pi-claude-code-provider-doctor/.test(error.message),
        );
        await assert.rejects(
            // The exit is observed on the second poll, so allow more than one interval.
            waitForReadyOrExit(join(directory, "missing"), 500, undefined, Promise.resolve({ code: 1, signal: null }), { stderr: () => "boom" }),
            (error) => /exited before the Pi proposal MCP server became ready \(code 1/.test(error.message)
                && /stderr: boom/.test(error.message),
        );
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test("provider enforces idle and context-budget limits", async () => {
    const idle = await fakeClaude(`process.stdin.resume(); process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n"); process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"idle",model:"claude-sonnet-5",usage:{}}}}) + "\\n"); setInterval(() => {}, 1000);`);
    const originalIdle = process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS;
    const originalTotal = process.env.PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS;
    process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS = "30";
    process.env.PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS = "1000";
    try {
        const result = await createClaudeStream({ executable: idle.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
        assert.match(result.errorMessage ?? "", /no protocol activity for 30ms/);
    }
    finally {
        if (originalIdle === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS; else process.env.PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS = originalIdle;
        if (originalTotal === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS; else process.env.PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS = originalTotal;
        await rm(idle.dir, { recursive: true, force: true });
    }
    for (let attempt = 0; attempt < 20 && getLastRequestMetrics()?.errorCategory !== "process"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const installation = { executable: "/does/not/run", version: "test", subscriptionType: "pro" };
    const tinyModel = { ...model, contextWindow: 100, maxTokens: 90 };
    const budgetResult = await createClaudeStream(installation)(tinyModel, context, { reasoning: "medium" }).result();
    for (let attempt = 0; attempt < 20 && getLastRequestMetrics()?.errorCategory !== "context_budget"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(budgetResult.errorMessage ?? "", /context_length_exceeded/);
    assert.equal(getLastRequestMetrics()?.errorCategory, "context_budget");
    assert.ok((getLastRequestMetrics()?.estimatedInputTokens ?? 0) > 0);
});
test("provider retains a caught failure category when private cleanup also fails", async () => {
    const installation = { executable: "/does/not/run", version: "test", subscriptionType: "pro" };
    const tinyModel = { ...model, contextWindow: 100, maxTokens: 90 };
    let privateDirectory;
    let cleanupAttempts = 0;
    const failCleanup = async (directory) => {
        privateDirectory = directory;
        cleanupAttempts++;
        throw new Error("synthetic cleanup failure");
    };
    try {
        const result = await createClaudeStream(installation, { cleanupDirectory: failCleanup })(tinyModel, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /context_length_exceeded/);
        assert.match(result.errorMessage ?? "", /private request cleanup failed: synthetic cleanup failure/);
        for (
            let attempt = 0;
            attempt < 20 && (cleanupAttempts < 2 || getLastRequestMetrics()?.cleanupComplete !== false);
            attempt++
        ) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(getLastRequestMetrics()?.errorCategory, "context_budget");
        assert.equal(getLastRequestMetrics()?.cleanupComplete, false);
    }
    finally {
        if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
    }
});
test("provider cleans private transport state after an early process failure", async () => {
    const markerDirectory = await mkdtemp(join(tmpdir(), "provider-cleanup-marker-"));
    const marker = join(markerDirectory, "cwd");
    const fake = await fakeClaude(`const index = process.argv.indexOf("--system-prompt-file"); const marker = fs.readFileSync(process.argv[index + 1], "utf8"); fs.writeFileSync(marker, require("node:path").dirname(process.argv[index + 1])); process.exit(9);`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, providerContext({ tools: [], systemPrompt: marker }), { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        const privateDirectory = await readFile(marker, "utf8");
        await assert.rejects(access(privateDirectory));
    }
    finally {
        await Promise.all([fake.dir, markerDirectory].map((directory) => rm(directory, { recursive: true, force: true })));
    }
});
const textResponseBody = `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_hook",model:"claude-sonnet-5",usage:{input_tokens:0,output_tokens:0}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"text",text:""}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"hook ok"}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"hook ok",usage:{input_tokens:4,output_tokens:2}}) + "\\n");
  setTimeout(() => {}, 50);
});`;
test("provider reports persistent private cleanup failure after a successful response", async () => {
    const fake = await fakeClaude(textResponseBody);
    let privateDirectory;
    const failCleanup = async (directory) => {
        privateDirectory = directory;
        throw new Error("synthetic EBUSY");
    };
    try {
        const result = await createClaudeStream({
            executable: fake.executable,
            version: CAPTURED_CLAUDE_VERSION,
            subscriptionType: "pro",
        }, { cleanupDirectory: failCleanup })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /private request cleanup failed: synthetic EBUSY/);
        assert.equal(result.content[0]?.text, "hook ok");
        const metrics = await waitForRequestMetrics((entry) => entry.cleanupComplete === false);
        assert.equal(metrics.stopReason, "error");
    }
    finally {
        await Promise.all([privateDirectory, fake.dir].filter(Boolean).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
    }
});
test("provider reports a synthetic response to Pi before streaming content", async () => {
    const fake = await fakeClaude(textResponseBody);
    try {
        const observed = [];
        const responses = [];
        const stream = createClaudeStream({
            executable: fake.executable,
            version: CAPTURED_CLAUDE_VERSION,
            subscriptionType: "pro",
        })(model, context, {
            reasoning: "medium",
            onResponse(response, responseModel) {
                responses.push({ response, modelId: responseModel.id });
                observed.push("response");
            },
        });
        for await (const event of stream)
            observed.push(event.type);
        const result = await stream.result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.equal(responses.length, 1);
        // No HTTP response exists, so the status is synthetic and headers are empty.
        assert.deepEqual(responses[0].response, { status: 200, headers: {} });
        assert.equal(responses[0].modelId, "sonnet");
        assert.deepEqual(observed, ["response", "start", "text_start", "text_delta", "text_end", "done"]);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider waits for Pi's async response handler before streaming content", async () => {
    const fake = await fakeClaude(textResponseBody);
    let releaseResponse;
    let responseStarted;
    const responseGate = new Promise((resolve) => {
        releaseResponse = resolve;
    });
    const responseEntered = new Promise((resolve) => {
        responseStarted = resolve;
    });
    try {
        const events = [];
        const stream = createClaudeStream({
            executable: fake.executable,
            version: CAPTURED_CLAUDE_VERSION,
            subscriptionType: "pro",
        })(model, context, {
            reasoning: "medium",
            async onResponse() {
                responseStarted();
                await responseGate;
                events.push("response");
            },
        });
        const consume = (async () => {
            for await (const event of stream)
                events.push(event.type);
        })();
        await responseEntered;
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(events, []);
        releaseResponse();
        await consume;
        const result = await stream.result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.deepEqual(events, ["response", "start", "text_start", "text_delta", "text_end", "done"]);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider fails before streaming when Pi's async response handler rejects", async () => {
    const fake = await fakeClaude(textResponseBody);
    let rejectResponse;
    let responseStarted;
    const responseGate = new Promise((_, reject) => {
        rejectResponse = reject;
    });
    const responseEntered = new Promise((resolve) => {
        responseStarted = resolve;
    });
    try {
        const events = [];
        const stream = createClaudeStream({
            executable: fake.executable,
            version: CAPTURED_CLAUDE_VERSION,
            subscriptionType: "pro",
        })(model, context, {
            reasoning: "medium",
            async onResponse() {
                responseStarted();
                await responseGate;
            },
        });
        const consume = (async () => {
            for await (const event of stream)
                events.push(event.type);
        })();
        await responseEntered;
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(events, []);
        rejectResponse(new Error("observer rejected"));
        await consume;
        const result = await stream.result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /after_provider_response handler failed: .*observer rejected/);
        assert.deepEqual(events, ["error"]);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "response_hook");
        assert.equal(metrics.stopReason, "error");
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});

// A 200K-window model reserving 32K output admits at most 168,000 estimated
// input tokens, which the byte estimator reaches at exactly 458,181 bytes.
const BUDGET_MODEL = { ...model, contextWindow: 200_000, maxTokens: 32_000 };
const LARGEST_ADMITTED_SYSTEM_PROMPT_BYTES = 458_181;
const DEAD_INSTALLATION = { executable: "/does/not/run", version: "test", subscriptionType: "pro" };
function markedSystemPrompt(bytes) {
    const head = "ALPHA-MARKER-4417\n";
    const tail = "\nOMEGA-MARKER-9308";
    return head + "F".repeat(bytes - head.length - tail.length) + tail;
}
test("provider transports a system prompt far above the former size cap", async () => {
    // 146,101 bytes is the size reported in issue #4, which the removed fixed
    // cap refused outright. Both ends of the file must survive the transport,
    // and the prompt must travel by path rather than in the argument vector.
    const systemPrompt = markedSystemPrompt(146_101);
    const fake = await fakeClaude(`
const path = require("node:path");
const text = fs.readFileSync(process.argv[process.argv.indexOf("--system-prompt-file") + 1], "utf8");
fs.writeFileSync(path.join(__dirname, "captured-large"), JSON.stringify({
  bytes: Buffer.byteLength(text),
  head: text.slice(0, 32),
  tail: text.slice(-32),
  argv: process.argv.slice(2),
}));
setTimeout(() => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_large",model:"claude-sonnet-5",usage:{input_tokens:0,output_tokens:0}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"text",text:""}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"large ok"}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"large ok",usage:{input_tokens:4,output_tokens:2}}) + "\\n");
}, 20);`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, providerContext({ tools: [], systemPrompt }), { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        const captured = JSON.parse(await readFile(join(fake.dir, "captured-large"), "utf8"));
        assert.equal(captured.bytes, 146_101);
        assert.ok(captured.head.startsWith("ALPHA-MARKER-4417"), captured.head);
        assert.ok(captured.tail.endsWith("OMEGA-MARKER-9308"), captured.tail);
        const flag = captured.argv.indexOf("--system-prompt-file");
        assert.ok(flag >= 0);
        assert.ok(captured.argv[flag + 1].endsWith("system-prompt.txt"));
        assert.ok(captured.argv.every((entry) => !entry.includes("ALPHA-MARKER-4417")));
        const metrics = await waitForRequestMetrics((entry) => entry.stopReason === "stop");
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider rejects a system prompt the served model cannot hold", async () => {
    const systemPrompt = "y".repeat(LARGEST_ADMITTED_SYSTEM_PROMPT_BYTES + 3);
    const result = await createClaudeStream(DEAD_INSTALLATION)(BUDGET_MODEL, providerContext({ tools: [], systemPrompt }), { reasoning: "medium" }).result();
    const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "system_prompt_budget");
    assert.match(result.errorMessage ?? "", /system prompt alone needs about \d+ tokens/);
    assert.match(result.errorMessage ?? "", /Reduce loaded system instructions, project context, or skill descriptions/);
    // Rejected before preparation, so no private directory was ever created and
    // the estimate that drove the decision is still reported.
    assert.equal(metrics.lastPhase, "payload_applied");
    assert.equal(metrics.transcriptBytes, 0);
    assert.ok(metrics.estimatedInputTokens > 0);
    assert.equal(metrics.cleanupComplete, true);
});
test("the system-prompt precheck admits the boundary and the full budget still decides", async () => {
    const systemPrompt = "y".repeat(LARGEST_ADMITTED_SYSTEM_PROMPT_BYTES);
    const result = await createClaudeStream(DEAD_INSTALLATION)(BUDGET_MODEL, providerContext({ tools: [], systemPrompt }), { reasoning: "medium" }).result();
    const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "context_budget");
    // The precheck is necessary, not sufficient: preparation ran, and the
    // transcript's own bytes then carried the request over the window.
    assert.equal(metrics.lastPhase, "prepared");
    assert.match(result.errorMessage ?? "", /context_length_exceeded/);
});
test("the system-prompt budget measures bytes rather than characters", async () => {
    const systemPrompt = "。".repeat(200_000);
    assert.equal(systemPrompt.length, 200_000);
    assert.equal(Buffer.byteLength(systemPrompt), 600_000);
    const result = await createClaudeStream(DEAD_INSTALLATION)(BUDGET_MODEL, providerContext({ tools: [], systemPrompt }), { reasoning: "medium" }).result();
    await waitForRequestMetrics((entry) => entry.errorCategory === "system_prompt_budget");
    assert.match(result.errorMessage ?? "", /system prompt alone needs about \d+ tokens/);
});
test("budget failures classify correctly for Pi's overflow recovery", async () => {
    const oversized = await createClaudeStream(DEAD_INSTALLATION)(BUDGET_MODEL, providerContext({ tools: [], systemPrompt: "y".repeat(LARGEST_ADMITTED_SYSTEM_PROMPT_BYTES + 3) }), { reasoning: "medium" }).result();
    await waitForRequestMetrics((entry) => entry.errorCategory === "system_prompt_budget");
    const overBudget = await createClaudeStream(DEAD_INSTALLATION)({ ...model, contextWindow: 100, maxTokens: 90 }, context, { reasoning: "medium" }).result();
    await waitForRequestMetrics((entry) => entry.errorCategory === "context_budget");
    const asMessage = (result) => ({ stopReason: "error", errorMessage: result.errorMessage ?? "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    // Compaction cannot shrink a system prompt, so the system-only failure must
    // not look like a recoverable overflow; the transcript one must.
    assert.equal(isContextOverflow(asMessage(oversized), BUDGET_MODEL.contextWindow), false);
    assert.equal(isContextOverflow(asMessage(overBudget), 100), true);
});
test("provider requires a usable model context window", async () => {
    for (const contextWindow of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const candidate = { ...model, contextWindow };
        if (contextWindow === undefined) delete candidate.contextWindow;
        const result = await createClaudeStream(DEAD_INSTALLATION)(candidate, context, { reasoning: "medium" }).result();
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "context_window");
        assert.match(result.errorMessage ?? "", /reports no usable context window/);
        assert.match(result.errorMessage ?? "", /contextWindow override/);
        assert.equal(metrics.lastPhase, "payload_applied");
    }
    // Only positivity and finiteness are required: the window is compared and
    // never propagated, so a fractional Pi override must still run.
    const fractional = await createClaudeStream(DEAD_INSTALLATION)({ ...model, contextWindow: 1_000_000.5 }, context, { reasoning: "medium" }).result();
    const metrics = await waitForRequestMetrics((entry) => entry.errorCategory !== "context_window");
    assert.notEqual(metrics.errorCategory, "context_window");
    assert.notEqual(metrics.lastPhase, "payload_applied");
    assert.ok(fractional.errorMessage);
});
test("the system-prompt budget is measured after Pi's payload hook", async () => {
    const oversized = "y".repeat(LARGEST_ADMITTED_SYSTEM_PROMPT_BYTES + 3);
    const inflated = await createClaudeStream(DEAD_INSTALLATION)(BUDGET_MODEL, context, { reasoning: "medium", onPayload: (payload) => ({ ...payload, systemPrompt: oversized }) }).result();
    await waitForRequestMetrics((entry) => entry.errorCategory === "system_prompt_budget");
    assert.match(inflated.errorMessage ?? "", /system prompt alone needs about \d+ tokens/);
    // The reverse direction proves the caller's own prompt is not what is
    // measured: a hook that replaces an oversized prompt must let the request run.
    await createClaudeStream(DEAD_INSTALLATION)(BUDGET_MODEL, providerContext({ tools: [], systemPrompt: oversized }), { reasoning: "medium", onPayload: (payload) => ({ ...payload, systemPrompt: "small" }) }).result();
    const metrics = await waitForRequestMetrics((entry) => entry.errorCategory !== "system_prompt_budget");
    assert.notEqual(metrics.errorCategory, "system_prompt_budget");
    assert.notEqual(metrics.lastPhase, "payload_applied");
});
test("provider rejects an invalid transcript-breakpoint setting before claiming a launch", async () => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT;
    process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT = "maybe";
    let claims = 0;
    try {
        const result = await createClaudeStream(DEAD_INSTALLATION, { claimLaunch: async () => { claims++; } })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT must be "on" or "off"/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "breakpoint_config");
        assert.equal(metrics.lastPhase, "prepared");
        assert.equal(claims, 0);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT;
        else process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT = original;
    }
});
test("provider sends Claude no transcript breakpoint when the setting is off", async () => {
    const fake = await fakeClaude(`
const path = require("node:path");
const NL = String.fromCharCode(10);
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(__dirname, "captured-stdin"), input);
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + NL);
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"ok",usage:{}}) + NL);
});`);
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT;
    process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT = "off";
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        const prompt = JSON.parse(await readFile(join(fake.dir, "captured-stdin"), "utf8")).message.content;
        assert.ok(prompt.length > 0);
        assert.equal(prompt.some((block) => "cache_control" in block), false);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT;
        else process.env.PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT = original;
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("a request keeps the image store it was placed on when that session shuts down", async () => {
    // A request whose session id this process never registered borrows another
    // live session's image store. That session can end while the request is still
    // preparing, and the lease used to be taken only afterwards, so the borrower
    // failed on a store it might never write to. onPayload runs in exactly that
    // window: after the session is resolved, before preparation.
    const store = new SessionImageStore();
    store.open();
    const fake = await fakeClaude(`
process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + String.fromCharCode(10));
process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"ok",usage:{}}) + String.fromCharCode(10));`);
    let closing;
    try {
        const result = await createProviderStream(
            { executable: fake.executable, version: "test", subscriptionType: "pro" },
            { resolveSession: () => ({ cwd: tmpdir(), imageStore: store }) },
        )(model, context, {
            reasoning: "medium",
            // Returning nothing leaves Pi's payload alone; the shutdown is the point.
            onPayload: () => { closing = store.close(); },
        }).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        // close() is still waiting on this request's lease, which is what keeps
        // the borrowed directory alive; it settles once the request released it.
        await closing;
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider writes no cache entry for a one-shot Pi asks not to cache", async () => {
    // Pi sets cacheRetention "none" on compaction, branch and turn-prefix
    // summaries. Each prompt is unique, so the 1h entry is never read back.
    const capture = `
const path = require("node:path");
const NL = String.fromCharCode(10);
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(__dirname, "captured-stdin"), input);
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + NL);
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"ok",usage:{}}) + NL);
});`;
    const marked = async (streamOptions) => {
        const fake = await fakeClaude(capture);
        try {
            const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, streamOptions).result();
            assert.equal(result.stopReason, "stop", result.errorMessage);
            const prompt = JSON.parse(await readFile(join(fake.dir, "captured-stdin"), "utf8")).message.content;
            assert.ok(prompt.length > 0);
            return prompt.some((block) => "cache_control" in block);
        }
        finally {
            await rm(fake.dir, { recursive: true, force: true });
        }
    };
    assert.equal(await marked({ reasoning: "medium", cacheRetention: "none" }), false);
    // Ordinary turns keep the breakpoint; only "none" opts out.
    assert.equal(await marked({ reasoning: "medium" }), true);
    assert.equal(await marked({ reasoning: "medium", cacheRetention: "short" }), true);
});
test("provider records a cache-breakpoint limit rejection as its own category", async () => {
    const rejection = { type: "result", is_error: true, api_error_status: 400, result: "API Error: 400 A maximum of 4 blocks with cache_control may be provided. Found 5." };
    const fake = await fakeClaude(`
const NL = String.fromCharCode(10);
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + NL);
  process.stdout.write(JSON.stringify(${JSON.stringify(rejection)}) + NL);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "cache_breakpoint_limit");
        assert.equal(metrics.stopReason, "error");
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});

test("provider refuses an unusable session working directory before preparing or launching", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-session-cwd-"));
    const regularFile = join(root, "not-a-directory");
    await writeFile(regularFile, "file");
    const spawnMarker = join(root, "spawned");
    const fake = await fakeClaude(`fs.writeFileSync(${JSON.stringify(spawnMarker)}, "spawned"); process.exit(0);`);
    try {
        // No fallback: another directory would again contradict Pi's own.
        const cases = [
            [undefined, /not available/],
            ["relative/project", /not absolute/],
            [join(root, "missing"), /unavailable: .*missing \(ENOENT\)/],
            [regularFile, /not a directory/],
        ];
        for (const [workingDirectory, message] of cases) {
            let claims = 0;
            const result = await createClaudeStream(
                { executable: fake.executable, version: "test", subscriptionType: "pro" },
                { resolveSession: () => (workingDirectory === undefined ? undefined : { cwd: workingDirectory }), claimLaunch: async () => { claims += 1; } },
            )(model, context, { reasoning: "medium" }).result();
            assert.equal(result.stopReason, "error");
            assert.match(result.errorMessage ?? "", message);
            assert.equal(claims, 0);
            const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "working_directory");
            // Validation precedes preparation, so no private request state was created.
            assert.equal(metrics.lastPhase, "payload_applied");
            assert.equal(metrics.transcriptBytes, 0);
        }
        await assert.rejects(access(spawnMarker));
    }
    finally {
        await Promise.all([root, fake.dir].map((directory) => rm(directory, { recursive: true, force: true })));
    }
});

test("provider does not retry elsewhere when the session directory disappears after validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-vanishing-cwd-"));
    const sessionDirectory = join(root, "project");
    await mkdir(sessionDirectory);
    const spawnMarker = join(root, "spawned");
    const fake = await fakeClaude(`fs.writeFileSync(${JSON.stringify(spawnMarker)}, process.cwd()); process.exit(0);`);
    try {
        let claims = 0;
        const result = await createClaudeStream(
            { executable: fake.executable, version: "test", subscriptionType: "pro" },
            {
                resolveSession: () => ({ cwd: sessionDirectory }),
                claimLaunch: async () => {
                    claims += 1;
                    await rm(sessionDirectory, { recursive: true, force: true });
                },
            },
        )(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /disappeared before Claude Code could start/);
        assert.doesNotMatch(result.errorMessage ?? "", /spawn .*ENOENT/);
        assert.equal(claims, 1);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory !== undefined);
        assert.equal(metrics.errorCategory, "working_directory");
        assert.equal(metrics.cleanupComplete, true);
        await assert.rejects(access(spawnMarker));
    }
    finally {
        await Promise.all([root, fake.dir].map((directory) => rm(directory, { recursive: true, force: true })));
    }
});

test("provider rejects image attachments from a temporary directory containing a double quote before launch", { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-quoted-temp-"));
    const quotedRoot = join(root, 'temp"root');
    await mkdir(quotedRoot);
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = quotedRoot;
    try {
        let claims = 0;
        const imageContext = {
            messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 1 }],
            tools: [],
        };
        const result = await createClaudeStream(
            { executable: join(root, "never-launched"), version: "test", subscriptionType: "pro" },
            { resolveSession: () => ({ cwd: root }), claimLaunch: async () => { claims += 1; } },
        )(model, imageContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /double quote/);
        assert.equal(claims, 0);
        await waitForRequestMetrics((entry) => entry.errorCategory === "image_path");
        assert.deepEqual(await readdir(quotedRoot), []);
    }
    finally {
        if (originalTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = originalTmpdir;
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * A captured scenario's records, with this test's own init so the tool inventory matches.
 * The fake writes everything at once and then waits, which is the worst case for a
 * handoff: every record Claude Code would emit while being terminated has already
 * arrived. It answers termination the way a real Claude process does.
 */
function capturedBody(scenario, terminalResult) {
    const records = streamRecoveryRecords(scenario)
        .filter((record) => !(record.type === "system" && record.subtype === "init"))
        // The capture ran to completion because nothing terminated it. A terminated
        // Claude never reaches its own result, so the acknowledgement below is the only
        // terminal record, while every record it emitted beforehand still arrives.
        .filter((record) => !(terminalResult && record.type === "result"))
        .map((record) => JSON.stringify(record));
    const onTerminate = terminalResult
        ? `process.stdout.write(${JSON.stringify(JSON.stringify(terminalResult))} + "\\n", () => process.exit(143));`
        : "process.exit(143);";
    return `
process.on("SIGTERM", () => { ${onTerminate} });
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  for (const record of ${JSON.stringify(records)}) process.stdout.write(record + "\\n");
  setInterval(() => {}, 1000);
});`;
}
test("provider fails retryably and cleans up when Claude Code recovers mid-response", async () => {
    // Claude Code keeps running after the interruption, working on a recovery whose
    // output cannot be published. The provider must stop it rather than wait.
    const fake = await fakeClaude(capturedBody("drop"));
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /stream ended before message_stop \(Claude Code began retrying: unknown\)/);
        assert.equal(isRetryableAssistantError(result), true);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "stream_interrupted");
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider publishes an output-limit response whose process exited before termination landed", async () => {
    // Claude Code can finish the continuation turn it starts after an output limit
    // and exit cleanly before the background termination arrives. The response Pi
    // asked for is complete and already mapped by then, so the turn must publish
    // rather than fail on an exit code the handoff did not expect. The captured
    // stream is replayed whole, ending in Claude Code's own successful result.
    const records = streamRecoveryRecords("max-tokens")
        .filter((record) => !(record.type === "system" && record.subtype === "init"))
        .map((record) => JSON.stringify(record));
    const fake = await fakeClaude(`
process.on("SIGTERM", () => {});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  for (const record of ${JSON.stringify(records)}) process.stdout.write(record + "\\n");
  process.stdout.write("", () => process.exit(0));
});`);
    try {
        const stream = createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" });
        const events = [];
        for await (const event of stream)
            events.push(event.type);
        const result = await stream.result();
        assert.equal(result.stopReason, "length", result.errorMessage);
        assert.equal(events.at(-1), "done");
        // Only the response Pi asked for is published; the continuation turn's
        // blocks were latched out of the stream.
        assert.equal(result.content.some((block) => block.type === "text" && block.text.length > 0), true);
        const metrics = await waitForRequestMetrics((entry) => entry.lastPhase === "completed");
        assert.equal(metrics.exitCode, 0);
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider returns a length stop when a response reaches the output limit", async () => {
    // Claude Code answers the limit with its own continuation turn; the provider stops
    // it at the stop reason and publishes the response the model actually produced.
    // Claude Code acknowledges the provider's termination with this shape, as it does
    // for a tool handoff.
    const fake = await fakeClaude(capturedBody("max-tokens", {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        stop_reason: "max_tokens",
        terminal_reason: "aborted_streaming",
        usage: { input_tokens: 4, output_tokens: 2 },
    }));
    try {
        const stream = createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" });
        const events = [];
        for await (const event of stream)
            events.push(event.type);
        const result = await stream.result();
        assert.equal(result.stopReason, "length", result.errorMessage);
        assert.equal(events.at(-1), "done");
        assert.equal(result.content.some((block) => block.type === "text" && block.text.length > 0), true);
        const metrics = await waitForRequestMetrics((entry) => entry.lastPhase === "completed");
        assert.equal(metrics.terminationExpected, true);
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
