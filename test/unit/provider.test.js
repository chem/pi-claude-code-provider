import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClaudeStream, isExpectedToolHandoffExit, waitForReadyOrExit } from "../../src/provider.ts";
import { getLastRequestMetrics } from "../../src/metrics.ts";
import { nodeFixtureSource } from "../support/node-fixture.js";
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
const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
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
const init = {
    type: "system",
    subtype: "init",
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "dontAsk",
    slash_commands: [],
    skills: [],
    plugins: [],
    apiKeySource: "none",
};
const toolInit = {
    ...init,
    tools: ["mcp__pi__read"],
    mcp_servers: [{ name: "pi", status: "connected" }],
};
const toolContext = {
    ...context,
    tools: [{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};
const toolTerminationResult = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: "tool_use",
    terminal_reason: "aborted_streaming",
    usage: { input_tokens: 4, output_tokens: 2 },
    modelUsage: { sonnet: { contextWindow: 1000000, maxOutputTokens: 64000 } },
};
async function waitForRequestMetrics(predicate) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const metrics = getLastRequestMetrics();
        if (metrics && predicate(metrics)) return metrics;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("request metrics did not settle");
}
test("provider streams a fake Claude response and honors payload replacement", async () => {
    const fake = await fakeClaude(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_fake",model:"claude-sonnet-5",usage:{input_tokens:0,output_tokens:0}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"text",text:""}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"fake ok"}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"fake ok",usage:{input_tokens:4,output_tokens:2}}) + "\\n");
  setTimeout(() => {}, 50);
});`);
    try {
        const stream = createClaudeStream({
            executable: fake.executable,
            version: "2.1.206",
            subscriptionType: "pro",
        })(model, context, {
            reasoning: "medium",
            onPayload(payload) {
                const logical = payload;
                return { ...logical, messages: [{ role: "user", content: "replacement", timestamp: 2 }] };
            },
        });
        const eventTypes = [];
        for await (const event of stream)
            eventTypes.push(event.type);
        const result = await stream.result();
        assert.deepEqual(eventTypes, ["start", "text_start", "text_delta", "text_end", "done"], result.errorMessage);
        assert.equal(result.responseModel, "claude-sonnet-5");
        assert.equal(result.usage.totalTokens, 6);
        assert.equal(result.usage.cost.total, 0);
        assert.equal(result.content[0]?.type, "text");
        const metrics = await waitForRequestMetrics((entry) => entry.stopReason === "stop");
        assert.equal(metrics.schemaVersion, 4);
        assert.equal(metrics.terminationExpected, false);
    }
    finally {
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
            version: "2.1.206",
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
    const originalKill = process.kill;
    process.kill = ((pid, signal) => {
        if (pid < 0) {
            const error = new Error("synthetic process-group EPERM");
            error.code = "EPERM";
            throw error;
        }
        return originalKill(pid, signal);
    });
    try {
        const result = await Promise.race([
            createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("provider stream did not settle")), 1000)),
        ]);
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /synthetic process-group EPERM/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process_cleanup");
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        process.kill = originalKill;
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider commits success only after clean exit and private-state cleanup", async () => {
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(init)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"result",is_error:false,result:process.cwd(),usage:{input_tokens:1,output_tokens:1}}) + "\\n");
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "stop");
        const privateDirectory = result.content.find((block) => block.type === "text")?.text;
        assert.ok(privateDirectory);
        await assert.rejects(access(privateDirectory));
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
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
            version: "2.1.206",
            subscriptionType: "pro",
        })(model, context, { reasoning: "medium", signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        const result = await stream.result();
        assert.equal(result.stopReason, "aborted");
        assert.match(result.errorMessage ?? "", /aborted/);
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
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const fake = await fakeClaude(`fs.writeFileSync(${JSON.stringify(marker)}, "spawned");`);
    try {
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
        if (originalTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = originalTmpdir;
        await rm(root, { recursive: true, force: true });
    }
});
test("provider does not spawn Claude when the request aborts during the launch claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-claim-abort-"));
    const marker = join(root, "spawned");
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const fake = await fakeClaude(`fs.writeFileSync(${JSON.stringify(marker)}, "spawned");`);
    try {
        const controller = new AbortController();
        const abortDuringClaim = async () => {
            controller.abort();
            await new Promise((resolve) => setImmediate(resolve));
        };
        const stream = createClaudeStream({
            executable: fake.executable,
            version: "test",
            subscriptionType: "pro",
        }, undefined, undefined, abortDuringClaim)(model, context, { reasoning: "medium", signal: controller.signal });
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
        if (originalTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = originalTmpdir;
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
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:JSON.stringify({path:process.cwd() + "/request.json"})}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const stream = createClaudeStream({
            executable: fake.executable,
            version: "2.1.206",
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
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_violation",model:"claude-sonnet-5",usage:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"toolu_violation",name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
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
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_cleanup_violation",model:"claude-sonnet-5",usage:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"toolu_cleanup_violation",name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
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
            failCleanup,
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
});

test("provider accepts an exact-PID Windows tool handoff", { skip: process.platform !== "win32" }, async () => {
    const fake = await fakeClaude(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_windows_tool",model:"claude-sonnet-5",usage:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"toolu_windows",name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"path":"package.json"}'}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
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
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:process.cwd(),name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"path":"README.md"}'}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const stream = createClaudeStream({
            executable: fake.executable,
            version: "2.1.212",
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
test("provider accepts an exit-143 tool handoff when Claude emits no acknowledgement", { skip: process.platform === "win32" }, async () => {
    const fake = await fakeClaude(`
process.on("SIGTERM", () => process.exit(143));
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_missing_ack",model:"claude-sonnet-5",usage:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"toolu_missing_ack",name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"path":"package.json"}'}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "2.1.212", subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
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
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_bad_exit",model:"claude-sonnet-5",usage:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"toolu_bad_exit",name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"path":"package.json"}'}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "2.1.212", subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /tool handoff exited unexpectedly.*code 1/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process_exit" && entry.exitCode === 1);
        assert.equal(metrics.lastPhase, "process_exited");
    }
    finally {
        await rm(fake.dir, { recursive: true, force: true });
    }
});
test("provider rejects a signal exit after tool-handoff termination", { skip: process.platform === "win32" }, async () => {
    const fake = await fakeClaude(`
process.on("SIGTERM", () => {});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify(${JSON.stringify(toolInit)}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_bad_signal",model:"claude-sonnet-5",usage:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"toolu_bad_signal",name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"path":"package.json"}'}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "2.1.212", subscriptionType: "pro" })(model, toolContext, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage ?? "", /tool handoff exited unexpectedly.*SIGKILL/);
        const metrics = await waitForRequestMetrics((entry) => entry.errorCategory === "process_exit" && entry.exitSignal === "SIGKILL");
        assert.equal(metrics.lastPhase, "process_exited");
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
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_abort_ack",model:"claude-sonnet-5",usage:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"tool_use",id:"toolu_abort_ack",name:"mcp__pi__read",input:{}}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:'{"path":"package.json"}'}}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
  process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_delta",delta:{stop_reason:"tool_use"}}}) + "\\n");
  setInterval(() => {}, 1000);
});`);
    try {
        const controller = new AbortController();
        const stream = createClaudeStream({ executable: fake.executable, version: "2.1.212", subscriptionType: "pro" })(model, toolContext, { reasoning: "medium", signal: controller.signal });
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
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test("provider enforces idle, system-prompt, and context-budget limits", async () => {
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
    const systemResult = await createClaudeStream(installation)(model, { ...context, systemPrompt: "x".repeat(120 * 1024 + 1) }, { reasoning: "medium" }).result();
    for (let attempt = 0; attempt < 20 && getLastRequestMetrics()?.errorCategory !== "system_prompt_size"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(systemResult.errorMessage ?? "", /system prompt.*122880/i);
    assert.equal(getLastRequestMetrics()?.errorCategory, "system_prompt_size");
    assert.equal(getLastRequestMetrics()?.messageCount, 1);
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
        const result = await createClaudeStream(installation, failCleanup)(tinyModel, context, { reasoning: "medium" }).result();
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
    const fake = await fakeClaude(`const index = process.argv.indexOf("--system-prompt-file"); const marker = fs.readFileSync(process.argv[index + 1], "utf8"); fs.writeFileSync(marker, process.cwd()); process.exit(9);`);
    try {
        const result = await createClaudeStream({ executable: fake.executable, version: "test", subscriptionType: "pro" })(model, { ...context, systemPrompt: marker }, { reasoning: "medium" }).result();
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
test("provider reports a synthetic response to Pi before streaming content", async () => {
    const fake = await fakeClaude(textResponseBody);
    try {
        const observed = [];
        const responses = [];
        const stream = createClaudeStream({
            executable: fake.executable,
            version: "2.1.206",
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
            version: "2.1.206",
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
            version: "2.1.206",
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
