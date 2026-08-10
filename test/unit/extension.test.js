import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import initializePiClaudeCodeProvider from "../../extensions/pi-claude-code-provider.ts";
import { VERIFIED_VERSIONS } from "../../src/compatibility.ts";
import { CLAUDE_HEADLESS_HELP, ELIGIBLE_CLAUDE_AUTH } from "../support/claude-fixture.js";
import { nodeFixtureSource } from "../support/node-fixture.js";

const piClaudeCodeProvider = (pi) => initializePiClaudeCodeProvider(pi);

function fakePi(initialTools = []) {
    const commands = new Map();
    const handlers = new Map();
    const providers = new Map();
    const tools = new Map(initialTools.map((tool) => [tool.name, tool]));
    return {
        commands,
        handlers,
        providers,
        tools,
        api: {
            registerCommand(name, options) { commands.set(name, options); },
            registerProvider(name, config) { providers.set(name, config); },
            registerTool(tool) { tools.set(tool.name, tool); },
            on(event, handler) {
                const values = handlers.get(event) ?? [];
                values.push(handler);
                handlers.set(event, values);
            },
            getAllTools() { return [...tools.values()]; },
        },
    };
}

async function createFakeClaude(searchResult = "ok", { searchDelayMs = 0, rateLimitInfo } = {}) {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-extension-"));
    const executable = join(directory, process.platform === "win32" ? "claude.cjs" : "claude");
    const rateLimitEvents = Array.isArray(rateLimitInfo) ? rateLimitInfo : rateLimitInfo ? [rateLimitInfo] : [];
    const init = { type: "system", subtype: "init", tools: ["WebFetch", "WebSearch"], mcp_servers: [], model: "claude-sonnet-5", permissionMode: "dontAsk", slash_commands: [], skills: [], plugins: [], apiKeySource: "none" };
    const providerInit = { ...init, tools: [] };
    // Keep fake Claude JSONL visible in sandboxes that lose buffered Node child stdout.
    await writeFile(executable, nodeFixtureSource(`
if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${VERIFIED_VERSIONS.claudeCode}\n`)});
else if (process.argv[2] === "auth" && process.argv[3] === "status") process.stdout.write(JSON.stringify(${JSON.stringify(ELIGIBLE_CLAUDE_AUTH)}));
else if (process.argv.includes("--help")) process.stdout.write(${JSON.stringify(CLAUDE_HEADLESS_HELP)});
else {
  setTimeout(() => {
    const providerMode = process.argv.includes("--system-prompt-file");
    process.stdout.write(JSON.stringify(providerMode ? ${JSON.stringify(providerInit)} : ${JSON.stringify(init)}) + "\\n");
    for (const rateLimitInfo of ${JSON.stringify(rateLimitEvents)}) process.stdout.write(JSON.stringify({type:"rate_limit_event",rate_limit_info:rateLimitInfo}) + "\\n");
    process.stdout.write(JSON.stringify({type:"result",is_error:false,result:${JSON.stringify(searchResult)}}) + "\\n");
  }, ${searchDelayMs});
}
`), { mode: 0o700 });
    await chmod(executable, 0o700);
    return { directory, executable };
}

test("routes rate-limit warnings to the active Pi UI without requiring one", async () => {
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.876,
        resetsAt: 1_800_000_000,
    } });
    const original = {
        executable: process.env.PI_CLAUDE_CODE_PROVIDER_PATH,
        metrics: process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG,
    };
    const metricsPath = join(directory, "metrics.jsonl");
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = metricsPath;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        assert.ok(provider);
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");

        const notices = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");
        const warning = notices.find(({ message }) => message.includes("rate limit warning"));
        assert.deepEqual(warning, {
            message: `[pi-claude-code-provider] Claude rate limit warning: 87% used (five_hour); resets at ${new Date(1_800_000_000_000).toLocaleTimeString()}`,
            level: "warning",
        });
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const records = (await readFile(metricsPath, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(records.length, 2);
        assert.equal(records.every((record) => record.requestedModel === "sonnet"), true);
    }
    finally {
        if (original.executable === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original.executable;
        if (original.metrics === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original.metrics;
        await rm(directory, { recursive: true, force: true });
    }
});

test("does not report a disabled overage as a rate limit", async () => {
    // The steady state on a subscription without usage credits: the plan window
    // is healthy and overage is administratively unavailable on every event.
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.11,
        resetsAt: 1_800_000_000,
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
    } });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message, level) { notices.push({ message, level }); } } });
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");
        assert.deepEqual(notices.filter(({ message }) => message.includes("rate limit")), []);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("reports a repeated rate-limit warning once per session", async () => {
    const warning = {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.77,
        resetsAt: 1_800_000_000,
    };
    // Claude repeats the notice within one process and across the fresh process
    // this transport spawns for every tool round-trip.
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: [warning, warning] });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message, level) { notices.push({ message, level }); } } });
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.deepEqual(notices.filter(({ message }) => message.includes("rate limit")), [{
            message: `[pi-claude-code-provider] Claude rate limit warning: 77% used (five_hour); resets at ${new Date(1_800_000_000_000).toLocaleTimeString()}`,
            level: "warning",
        }]);

        // A new session starts from a clean slate.
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const later = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message, level) { later.push({ message, level }); } } });
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(later.filter(({ message }) => message.includes("rate limit")).length, 1);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("converts fractional weekly utilization to a percentage", async () => {
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.861,
    } });
    const original = {
        executable: process.env.PI_CLAUDE_CODE_PROVIDER_PATH,
        metrics: process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG,
    };
    const metricsPath = join(directory, "metrics.jsonl");
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = metricsPath;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        assert.ok(provider);
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");
        assert.deepEqual(notices.find(({ message }) => message.includes("rate limit warning")), {
            message: "[pi-claude-code-provider] Claude rate limit warning: 86% used (seven_day)",
            level: "warning",
        });
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original.executable === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original.executable;
        if (original.metrics === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original.metrics;
        await rm(directory, { recursive: true, force: true });
    }
});

test("failed preflight retains the doctor and reports one session error", async () => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = "/does/not/exist/claude";
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        assert.equal(pi.commands.has("pi-claude-code-provider-doctor"), true);
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.tools.size, 0);
        const notices = [];
        const sessionStart = pi.handlers.get("session_start") ?? [];
        assert.equal(sessionStart.length, 1);
        sessionStart[0]({}, { ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal(notices.length, 1);
        assert.equal(notices[0].level, "error");
        assert.match(notices[0].message, /^\[pi-claude-code-provider\]/);
        assert.match(notices[0].message, /unavailable.*pi-claude-code-provider-doctor.*reload/i);
        await pi.commands.get("pi-claude-code-provider-doctor").handler("report", { ui: { notify(message, level) { notices.push({ message, level }); } } });
        const reportPath = notices.at(-1).message.match(/written to (.*); preflight/)?.[1];
        assert.ok(reportPath);
        try {
            assert.equal(notices.at(-1).level, "warning");
            if (process.platform !== "win32") assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
            assert.match(await readFile(reportPath, "utf8"), /"errorCode": "executable_missing"/);
        }
        finally {
            await rm(dirname(reportPath), { recursive: true, force: true });
        }
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
    }
});

test("truncated web-search output is retained only for the session", async () => {
    const { directory, executable } = await createFakeClaude("x".repeat(60 * 1024));
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const existingWebSearch = { name: "web_search" };
        const pi = fakePi([existingWebSearch]);
        await piClaudeCodeProvider(pi.api);
        assert.equal(pi.providers.has("pi-claude-code-provider"), true);
        const notices = [];
        const sessionStart = pi.handlers.get("session_start") ?? [];
        assert.equal(sessionStart.length, 1);
        sessionStart[0]({}, { ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal(pi.tools.get("web_search"), existingWebSearch);
        assert.equal(notices.some(({ message }) => /(?:Pi|Claude Code) .*unverified/.test(message)), false);
        assert.equal(notices.every(({ message }) => message.startsWith("[pi-claude-code-provider]")), true);
        const search = pi.tools.get("pi_claude_code_provider_web_search");
        assert.ok(search);
        assert.match(search.description, new RegExp(`${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines`));
        const result = await search.execute("call", { query: "query" }, undefined);
        assert.equal(result.details.truncated, true);
        assert.ok(result.details.fullOutputPath);
        await access(result.details.fullOutputPath);
        const shutdown = pi.handlers.get("session_shutdown") ?? [];
        assert.equal(shutdown.length, 1);
        await shutdown[0]({}, {});
        await assert.rejects(access(result.details.fullOutputPath));
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("web-search output finishing after shutdown is not retained", async () => {
    const { directory, executable } = await createFakeClaude("x".repeat(60 * 1024), { searchDelayMs: 50 });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    const outputDirectories = async () => (await readdir(tmpdir(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-claude-code-provider-search-output-"))
        .map((entry) => entry.name)
        .sort();
    const before = await outputDirectories();
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        pi.handlers.get("session_start")[0]({}, { ui: { notify() { } } });
        const search = pi.tools.get("pi_claude_code_provider_web_search");
        const pending = search.execute("call", { query: "query" }, undefined);
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const result = await pending;
        assert.equal(result.details.truncated, true);
        assert.equal(result.details.fullOutputPath, undefined);
        assert.doesNotMatch(result.content[0].text, /Full output:/);
        const after = await outputDirectories();
        assert.deepEqual(after.filter((name) => !before.includes(name)), []);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("an occupied permanent web-search name is preserved with a prefixed warning", async () => {
    const { directory, executable } = await createFakeClaude();
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const existingSearch = { name: "pi_claude_code_provider_web_search", owner: "other-extension" };
        const pi = fakePi([existingSearch]);
        await piClaudeCodeProvider(pi.api);
        const notices = [];
        const sessionStart = pi.handlers.get("session_start") ?? [];
        assert.equal(sessionStart.length, 1);
        sessionStart[0]({}, { ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal(pi.tools.get("pi_claude_code_provider_web_search"), existingSearch);
        const collision = notices.find(({ message }) => message.includes("tool name is already occupied"));
        assert.ok(collision);
        assert.equal(collision.level, "warning");
        assert.match(collision.message, /^\[pi-claude-code-provider\]/);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});
