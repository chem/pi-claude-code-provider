import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPECTED_MODEL_FAMILIES } from "../src/compatibility.ts";
import { inspectClaudeInstallation } from "../src/auth.ts";
import { providerModelsForSubscription } from "../src/catalog.ts";
import { consumeJsonl, superviseLiveProcess } from "./lib/live-process.js";
import { livePiLaunch } from "./lib/pi-installation.js";
import { servedContextWindowMatches } from "./lib/model-matrix-policy.js";

if (process.env.PI_CLAUDE_CODE_PROVIDER_PAID_TEST_CHILD !== "1") {
    throw new Error("The paid model matrix must be started through an npm test:paid:* script");
}

const packageRoot = process.cwd();
const installation = await inspectClaudeInstallation();
const providerModels = providerModelsForSubscription(installation.subscriptionType);
const efforts = ["low", "medium", "high", "xhigh", "max"];
const effortModels = ["sonnet", "opus", "haiku"];
const advertisedModels = providerModels.map((model) => model.id);
assert.deepEqual(Object.keys(EXPECTED_MODEL_FAMILIES), advertisedModels, "compatibility targets must match advertised models");
// Fable 5 availability and included quota vary by subscription tier. It is
// intentionally opt-in and excluded from the blocking gate; the standalone
// case remains selectable for accounts with Fable access.
const ungatedModels = new Set(["fable"]);
const mediumOnlyModels = advertisedModels.filter((model) => !effortModels.includes(model));
const coreCases = [
    { model: "sonnet", effort: "medium" },
    ...effortModels.flatMap((model) => efforts.map((effort) => ({ model, effort }))).filter(({ model, effort }) => model !== "sonnet" || effort !== "medium"),
    ...mediumOnlyModels.filter((model) => !ungatedModels.has(model)).map((model) => ({ model, effort: "medium" })),
];
const selectableCases = [
    ...coreCases,
    ...mediumOnlyModels.filter((model) => ungatedModels.has(model)).map((model) => ({ model, effort: "medium" })),
];
const CASE_TIMEOUT_MS = 4 * 60_000;
const selectedCase = process.argv[2] === "--case" ? process.argv[3] : undefined;
if ((process.argv.length > 2 && (!selectedCase || process.argv.length !== 4)) || (selectedCase && !selectableCases.some(({ model, effort }) => `${model}:${effort}` === selectedCase))) {
    throw new Error(`Unknown model matrix case: ${process.argv.slice(2).join(" ")}`);
}
const selectedCases = selectedCase ? selectableCases.filter(({ model, effort }) => `${model}:${effort}` === selectedCase) : coreCases;

async function runCase(cwd, model, effort) {
    const metricsBefore = await metricsEntries();
    const runtimeBefore = await runtimeDirectories();
    const launch = livePiLaunch([
        "--no-session", "-e", packageRoot, "--provider", "pi-claude-code-provider", "--model", `${model}:${effort}`,
        "--no-tools", "--mode", "json", "Reply exactly OK.",
    ]);
    const child = spawn(launch.command, launch.args, {
        cwd,
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
        env: {
            ...process.env,
            PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS: "60000",
            PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS: "180000",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.ref();
    child.stdout.ref();
    child.stderr.ref();
    const events = [];
    let assistantError;
    let protocolError;
    let stderr = "";
    const supervisor = superviseLiveProcess(child, { timeoutMs: CASE_TIMEOUT_MS, label: `${model}:${effort}` });
    consumeJsonl(child.stdout, (event) => {
        events.push(event);
        if (!assistantError && event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
            assistantError = event.message.errorMessage ?? "unknown assistant error";
            void supervisor.terminate();
        }
    }, (error) => {
        protocolError = `invalid Pi JSON event: ${error.message}`;
        void supervisor.terminate();
    });
    child.stderr.on("data", (chunk) => stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024));
    const { code, signal } = await supervisor.wait();
    if (protocolError) throw new Error(`${model}:${effort}: ${protocolError}`);
    if (assistantError) throw new Error(`${model}:${effort}: ${assistantError}`);
    if (code !== 0 || signal !== null) throw new Error(`${model}:${effort} exited ${String(code)}, signal ${String(signal)}: ${stderr.trim()}`);
    const message = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").at(-1)?.message;
    if (!message) throw new Error(`${model}:${effort} returned no assistant message`);
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
    assert.match(text, /^OK\.?$/, `${model}:${effort} response text`);
    assert.match(message.responseModel, EXPECTED_MODEL_FAMILIES[model], `${model}:${effort} resolved model`);
    const metrics = await waitForMetrics(metricsBefore.length, model, effort);
    const configured = providerModels.find((entry) => entry.id === model);
    assert.equal(metrics.cleanupComplete, true, `${model}:${effort} private-state cleanup`);
    assert.equal(
        servedContextWindowMatches(installation.subscriptionType, model, configured.contextWindow, metrics.servedContextWindow),
        true,
        `${model}:${effort} served context window`,
    );
    if (installation.subscriptionType === "pro" && model === "opus") {
        assert.equal(configured.contextWindow, 200_000, `${model}:${effort} safe configured context window`);
    }
    assert.equal(metrics.servedMaxOutputTokens, configured.maxTokens, `${model}:${effort} served maximum output`);
    const leaked = (await runtimeDirectories()).filter((name) => !runtimeBefore.includes(name));
    assert.deepEqual(leaked, [], `${model}:${effort} left private runtime directories`);
    return {
        resolvedModel: message.responseModel,
        contextWindow: metrics.servedContextWindow,
        maxOutputTokens: metrics.servedMaxOutputTokens,
    };
}

const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-matrix-"));
try {
    for (const { model, effort } of selectedCases) {
        const served = await runCase(directory, model, effort);
        console.log(`ok - ${model}:${effort} -> ${served.resolvedModel}; context ${served.contextWindow}, max output ${served.maxOutputTokens}`);
    }
    console.log(`ok - ${selectedCases.length} blocking model/effort combinations passed`);
}
finally {
    await rm(directory, { recursive: true, force: true });
}

async function metricsEntries() {
    const path = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    if (!path) throw new Error("The paid model matrix requires its private metrics log");
    try {
        return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    }
    catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
    }
}

async function runtimeDirectories() {
    return (await readdir(tmpdir(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-claude-code-provider-request-"))
        .map((entry) => entry.name)
        .sort();
}

async function waitForMetrics(previousCount, model, effort) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const entries = await metricsEntries();
        const metrics = entries.slice(previousCount).findLast((entry) => entry.requestedModel === model && entry.effort === effort);
        if (metrics) return metrics;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${model}:${effort} produced no request metrics`);
}
