import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getLastSearchMetrics } from "../../src/metrics.ts";
import { superviseProcess, terminateProcessGroup } from "../../src/process-utils.ts";
import { searchWithClaude } from "../../src/web-search.ts";
import { nodeFixtureSource } from "../support/node-fixture.js";

const searchInit = {
    type: "system", subtype: "init", tools: ["WebFetch", "WebSearch"], mcp_servers: [], model: "claude-sonnet-5",
    permissionMode: "dontAsk", slash_commands: [], skills: [], plugins: [], apiKeySource: "none",
};

async function fakeSearch(body) {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-search-fake-"));
    const executable = join(directory, process.platform === "win32" ? "fake-claude.cjs" : "fake-claude");
    // Nested Node child stdout can disappear in restricted sandboxes; use the
    // shared test-only preload so a missing init remains a real protocol failure.
    await writeFile(executable, nodeFixtureSource(body), { mode: 0o700 });
    await chmod(executable, 0o700);
    return { directory, executable };
}

function supervisorWithCleanupFailure(child, options) {
    const supervisor = superviseProcess(child, options);
    let termination;
    return {
        ...supervisor,
        terminate() {
            termination ??= supervisor.terminate().then(() => {
                throw new Error("synthetic search process-group EPERM");
            });
            return termination;
        },
    };
}

test("web search uses a relative private request reference and validates its result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-search-test-"));
    const executable = join(directory, process.platform === "win32" ? "fake-claude.cjs" : "fake-claude");
    await writeFile(executable, nodeFixtureSource(`
const prompt = process.argv.find((arg) => arg.startsWith("Research the query")) ?? "";
if (!prompt.includes("@./search-request.json") || prompt.includes(process.cwd() + "/search-request.json")) process.exit(7);
process.stdout.write(JSON.stringify(${JSON.stringify(searchInit)}) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "sourced result" }) + "\\n");
`), { mode: 0o700 });
    await chmod(executable, 0o700);
    try {
        const installation = { executable, version: "test", subscriptionType: "pro" };
        assert.equal(await searchWithClaude(installation, { query: "query" }), "sourced result");
        const metrics = getLastSearchMetrics();
        assert.equal(metrics.lastPhase, "completed");
        assert.equal(metrics.initialized, true);
        assert.equal(metrics.cleanupComplete, true);
        assert.equal(metrics.resultBytes, Buffer.byteLength("sourced result"));
        assert.doesNotMatch(JSON.stringify(metrics), /query|sourced result/);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("web search forwards rate-limit notices and preserves null error diagnostics", async () => {
    const fake = await fakeSearch(`
process.stdout.write(JSON.stringify(${JSON.stringify(searchInit)}) + "\\n");
process.stdout.write(JSON.stringify({type:"rate_limit_event",rate_limit_info:{status:"allowed_warning",rateLimitType:"five_hour",utilization:0.876,resetsAt:1800000000}}) + "\\n");
process.stdout.write(JSON.stringify({type:"result",subtype:"success",is_error:true,result:null,api_error_status:429,errors:["search loop failed"]}) + "\\n");`);
    try {
        const notices = [];
        const installation = { executable: fake.executable, version: "test", subscriptionType: "pro" };
        await assert.rejects(
            searchWithClaude(installation, { query: "query" }, { onRateLimitNotice: (notice) => notices.push(notice) }),
            /429.*search loop failed/,
        );
        assert.deepEqual(notices, [{
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.876,
            resetsAt: 1_800_000_000_000,
        }]);
    }
    finally {
        await rm(fake.directory, { recursive: true, force: true });
    }
});

test("ignores malformed advisory rate-limit events", async () => {
    for (const rateLimitInfo of ["null", "[]", "undefined"]) {
        const fake = await fakeSearch(`
process.stdout.write(JSON.stringify(${JSON.stringify(searchInit)}) + "\\n");
const rateLimitEvent = {type:"rate_limit_event"};
if (${JSON.stringify(rateLimitInfo)} === "null") rateLimitEvent.rate_limit_info = null;
if (${JSON.stringify(rateLimitInfo)} === "[]") rateLimitEvent.rate_limit_info = [];
process.stdout.write(JSON.stringify(rateLimitEvent) + "\\n");
process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"sourced result"}) + "\\n");`);
        try {
            const installation = { executable: fake.executable, version: "test", subscriptionType: "pro" };
            assert.equal(await searchWithClaude(installation, { query: "query" }), "sourced result");
        }
        finally {
            await rm(fake.directory, { recursive: true, force: true });
        }
    }
});

test("web search preserves process-group cleanup rejection and removes private state", async () => {
    const successful = await fakeSearch(`
process.stdout.write(JSON.stringify(${JSON.stringify(searchInit)}) + "\\n");
process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"must not succeed"}) + "\\n");`);
    try {
        const installation = { executable: successful.executable, version: "test", subscriptionType: "pro" };
        await assert.rejects(
            searchWithClaude(installation, { query: "query" }, { supervise: supervisorWithCleanupFailure }),
            /synthetic search process-group EPERM/,
        );
        const metrics = getLastSearchMetrics();
        assert.equal(metrics.errorCategory, "process_cleanup");
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(successful.directory, { recursive: true, force: true });
    }
});

test("web search rejects promptly and retains marked state when process death is unknown", { skip: process.platform === "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "search-unknown-liveness-"));
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const fake = await fakeSearch(`setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    let capturedChild;
    const superviseUnknown = (child, options) => {
        capturedChild = child;
        setImmediate(() => controller.abort());
        return superviseProcess(child, {
            ...options,
            terminate: async () => { throw new Error("synthetic stubborn search EPERM"); },
        });
    };
    try {
        await assert.rejects(
            Promise.race([
                searchWithClaude(
                    { executable: fake.executable, version: "test", subscriptionType: "pro" },
                    { query: "query", signal: controller.signal },
                    { timeoutMs: 1_000, supervise: superviseUnknown },
                ),
                new Promise((_, reject) => setTimeout(() => reject(new Error("web search did not settle")), 500)),
            ]),
            (error) => {
                assert.match(error.message, /Web search was cancelled/);
                assert.match(error.message, /synthetic stubborn search EPERM/);
                assert.match(error.message, /runtime state was retained/);
                assert.equal((error.message.match(/synthetic stubborn search EPERM/g) ?? []).length, 1);
                return true;
            },
        );
        const metrics = getLastSearchMetrics();
        assert.equal(metrics.errorCategory, "process_cleanup");
        assert.equal(metrics.cleanupComplete, false);
        const directories = [];
        for (const name of await readdir(root)) {
            if (!name.startsWith("pi-claude-code-provider-search-")) continue;
            try {
                await access(join(root, name, ".pi-claude-code-provider-runtime.json"));
                directories.push(name);
            } catch { /* Ignore the fake executable directory. */ }
        }
        assert.equal(directories.length, 1);
        const marker = JSON.parse(await readFile(join(root, directories[0], ".pi-claude-code-provider-runtime.json"), "utf8"));
        assert.equal(marker.childPid, capturedChild.pid);
        assert.doesNotThrow(() => process.kill(capturedChild.pid, 0));
    } finally {
        if (capturedChild) await terminateProcessGroup(capturedChild);
        if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
        await rm(root, { recursive: true, force: true });
        await rm(fake.directory, { recursive: true, force: true });
    }
});

test("web search preserves a protocol failure when process cleanup also fails", async () => {
    const malformed = await fakeSearch(`process.stdout.write("not json");`);
    try {
        const installation = { executable: malformed.executable, version: "test", subscriptionType: "pro" };
        await assert.rejects(
            searchWithClaude(installation, { query: "query" }, { supervise: supervisorWithCleanupFailure }),
            /malformed JSONL; Claude Code process tree cleanup failed: synthetic search process-group EPERM/,
        );
        const metrics = getLastSearchMetrics();
        assert.equal(metrics.errorCategory, "protocol_invalid_json");
        assert.equal(metrics.cleanupComplete, true);
    }
    finally {
        await rm(malformed.directory, { recursive: true, force: true });
    }
});

test("web search fails closed on missing, duplicate, and unexpected initialization", async () => {
    const cases = [
        { body: `process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"no init"})+"\\n");`, pattern: /before initialization/ },
        { body: `const init=${JSON.stringify(searchInit)}; process.stdout.write(JSON.stringify(init)+"\\n"+JSON.stringify(init)+"\\n");`, pattern: /duplicate initialization/ },
        { body: `process.stdout.write(JSON.stringify(${JSON.stringify({ ...searchInit, tools: ["Bash"] })})+"\\n");`, pattern: /unexpected tool set/ },
        { body: `process.stdout.write(JSON.stringify(${JSON.stringify({ ...searchInit, mcp_servers: [{ name: "rogue", status: "connected" }] })})+"\\n");`, pattern: /unexpected MCP server/ },
        { body: `process.stdout.write(JSON.stringify(${JSON.stringify({ ...searchInit, plugins: ["rogue"] })})+"\\n");`, pattern: /unexpected customizations/ },
        { body: `process.stdout.write(JSON.stringify(${JSON.stringify({ ...searchInit, apiKeySource: "ANTHROPIC_API_KEY" })})+"\\n");`, pattern: /subscription-backed/ },
    ];
    for (const entry of cases) {
        const fake = await fakeSearch(entry.body);
        try {
            const installation = { executable: fake.executable, version: "test", subscriptionType: "pro" };
            await assert.rejects(searchWithClaude(installation, { query: "query" }), entry.pattern);
        }
        finally {
            await rm(fake.directory, { recursive: true, force: true });
        }
    }
});

test("web search rejects oversized requests before launch", async () => {
    const installation = { executable: "/does/not/matter", version: "test", subscriptionType: "pro" };
    await assert.rejects(searchWithClaude(installation, { query: "x".repeat(64 * 1024 + 1) }), /65536-byte limit/);
    assert.equal(getLastSearchMetrics().errorCategory, "request_too_large");
    assert.equal(getLastSearchMetrics().cleanupComplete, true);
});
test("web search rejects malformed and oversized responses and cleans its cwd", async () => {
    const malformed = await fakeSearch(`const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify("MARKER")}, process.cwd()); process.stdout.write("not json");`);
    const marker = join(malformed.directory, "cwd");
    const source = await readFile(malformed.executable, "utf8");
    await writeFile(malformed.executable, source.replace(JSON.stringify("MARKER"), JSON.stringify(marker)), { mode: 0o700 });
    try {
        const installation = { executable: malformed.executable, version: "test", subscriptionType: "pro" };
        await assert.rejects(searchWithClaude(installation, { query: "query" }), /malformed JSONL/);
        await assert.rejects(access(await readFile(marker, "utf8")));
    }
    finally {
        await rm(malformed.directory, { recursive: true, force: true });
    }
    const oversized = await fakeSearch(`process.stdout.write("x".repeat(2 * 1024 * 1024 + 1));`);
    try {
        const installation = { executable: oversized.executable, version: "test", subscriptionType: "pro" };
        await assert.rejects(searchWithClaude(installation, { query: "query" }), /maximum captured response size/);
    }
    finally {
        await rm(oversized.directory, { recursive: true, force: true });
    }
});
test("web search preserves primary failures when private cleanup also fails", async () => {
    const malformed = await fakeSearch(`process.stdout.write("not json");`);
    let privateDirectory;
    const failCleanup = async (directory) => {
        privateDirectory = directory;
        throw new Error("synthetic cleanup failure");
    };
    try {
        const installation = { executable: malformed.executable, version: "test", subscriptionType: "pro" };
        await assert.rejects(
            searchWithClaude(installation, { query: "query" }, { cleanupDirectory: failCleanup }),
            /malformed JSONL; private web-search request cleanup failed: synthetic cleanup failure/,
        );
        const metrics = getLastSearchMetrics();
        assert.equal(metrics.errorCategory, "protocol_invalid_json");
        assert.equal(metrics.cleanupComplete, false);
    }
    finally {
        if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
        await rm(malformed.directory, { recursive: true, force: true });
    }
});
test("web search still fails a successful result when private cleanup fails", async () => {
    const successful = await fakeSearch(`
process.stdout.write(JSON.stringify(${JSON.stringify(searchInit)}) + "\\n");
process.stdout.write(JSON.stringify({type:"result",is_error:false,result:"must not escape"}) + "\\n");`);
    let privateDirectory;
    const failCleanup = async (directory) => {
        privateDirectory = directory;
        throw new Error("synthetic cleanup failure");
    };
    try {
        const installation = { executable: successful.executable, version: "test", subscriptionType: "pro" };
        await assert.rejects(
            searchWithClaude(installation, { query: "query" }, { cleanupDirectory: failCleanup }),
            /private web-search request cleanup failed: synthetic cleanup failure/,
        );
        const metrics = getLastSearchMetrics();
        assert.equal(metrics.errorCategory, "cleanup");
        assert.equal(metrics.cleanupComplete, false);
    }
    finally {
        if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
        await rm(successful.directory, { recursive: true, force: true });
    }
});
test("Windows web-search abort terminates only its owned process tree", { skip: process.platform !== "win32" }, async () => {
    const hanging = await fakeSearch(`
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(path.dirname(process.argv[1]), "pid"), String(process.pid));
setInterval(() => {}, 1000);`);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const controller = new AbortController();
    let pending;
    try {
        pending = searchWithClaude(
            { executable: hanging.executable, version: "test", subscriptionType: "pro" },
            { query: "query", signal: controller.signal },
            { timeoutMs: 1000 },
        );
        const pidPath = join(hanging.directory, "pid");
        for (let attempt = 0; attempt < 100; attempt++) {
            try { await access(pidPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
        }
        const targetPid = Number(await readFile(pidPath, "utf8"));
        controller.abort();
        await assert.rejects(pending, /cancelled/);
        assert.throws(() => process.kill(targetPid, 0));
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    }
    finally {
        controller.abort();
        await pending?.catch(() => {});
        await terminateProcessGroup(unrelated);
        await rm(hanging.directory, { recursive: true, force: true });
    }
});

test("web search handles pre-launch abort, abort, and timeout", async () => {
    const preCancelled = await fakeSearch(`
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(__dirname, "spawned"), "spawned");`);
    const hanging = await fakeSearch(`setInterval(() => {}, 1000);`);
    const installation = { executable: hanging.executable, version: "test", subscriptionType: "pro" };
    try {
        const cancelledBeforeLaunch = new AbortController();
        cancelledBeforeLaunch.abort();
        await assert.rejects(
            searchWithClaude(
                { executable: preCancelled.executable, version: "test", subscriptionType: "pro" },
                { query: "query", signal: cancelledBeforeLaunch.signal },
            ),
            /cancelled/,
        );
        await assert.rejects(access(join(preCancelled.directory, "spawned")));
        const preLaunchMetrics = getLastSearchMetrics();
        assert.equal(preLaunchMetrics.errorCategory, "aborted");
        assert.equal(preLaunchMetrics.cleanupComplete, true);

        const controller = new AbortController();
        const aborted = searchWithClaude(installation, { query: "query", signal: controller.signal }, { timeoutMs: 1000 });
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(aborted, /cancelled/);
        await assert.rejects(searchWithClaude(installation, { query: "query" }, { timeoutMs: 30 }), /no protocol activity for 30ms|exceeded 30ms/);
    }
    finally {
        await rm(preCancelled.directory, { recursive: true, force: true });
        await rm(hanging.directory, { recursive: true, force: true });
    }
});
