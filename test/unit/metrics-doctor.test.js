import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { platformStatus, versionStatus } from "../../src/compatibility.ts";
import { writeDiagnosticReport } from "../../src/diagnostics.ts";
import { bridgeArgv, formatBridgeArgv } from "../../src/claude-args.ts";
import { formatDoctorSummary, probeBridge } from "../../src/doctor.ts";
import { ClaudeCodeError } from "../../src/errors.ts";
import { appendRequestMetrics, appendSearchMetrics, flushMetricsLog, getLastRequestMetrics, getMetricsLogError, recordRequestMetrics, recordSearchMetrics, serializeRequestMetrics, serializeSearchMetrics } from "../../src/metrics.ts";

const metrics = {
    schemaVersion: 4, timestamp: "2026-07-12T00:00:00.000Z", platform: "linux", architecture: "x64", nodeVersion: "v24.16.0", claudeVersion: "2.1.207", requestedModel: "sonnet", resolvedModel: "claude-sonnet-5", effort: "medium",
    messageCount: 2, toolCount: 1, imageCount: 0, transcriptBytes: 100, catalogBytes: 50, imageBytes: 0, estimatedInputTokens: 1000,
    servedContextWindow: 1000000, servedMaxOutputTokens: 64000, cacheRead: 10, cacheWrite: 20, inputTokens: 30, outputTokens: 2,
    cacheHitPercent: 16.67, durationMs: 250, lastPhase: "completed", cleanupComplete: true, stopReason: "stop", exitCode: 0, exitSignal: null, terminationExpected: false,
};
test("metrics serialization is content-free, appendable, and mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-metrics-"));
    const path = join(directory, "metrics.jsonl");
    try {
        assert.doesNotMatch(serializeRequestMetrics(metrics), /prompt|secret|pi-claude-code-provider-/i);
        await appendRequestMetrics(path, metrics);
        await chmod(path, 0o644);
        await appendRequestMetrics(path, { ...metrics, stopReason: "error", errorCategory: "protocol" });
        const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(lines.length, 2);
        assert.equal(lines[0].schemaVersion, 4);
        assert.equal(lines[0].terminationExpected, false);
        assert.equal(lines[1].errorCategory, "protocol");
        if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test("web-search metrics append a discriminated content-free record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-search-metrics-"));
    const path = join(directory, "metrics.jsonl");
    const search = { schemaVersion: 1, timestamp: metrics.timestamp, platform: "linux", architecture: "x64", nodeVersion: process.version, claudeVersion: "2.1.209", requestBytes: 12, capturedBytes: 34, resultBytes: 56, durationMs: 78, lastPhase: "completed", initialized: true, cleanupComplete: true, exitCode: 0, exitSignal: null };
    try {
        assert.doesNotMatch(serializeSearchMetrics(search), /query|result text|secret/i);
        await appendSearchMetrics(path, search);
        const record = JSON.parse((await readFile(path, "utf8")).trim());
        assert.equal(record.kind, "web_search");
        assert.equal(record.requestBytes, 12);
        if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test("recording web-search metrics honors the configured private log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-record-search-metrics-"));
    const path = join(directory, "metrics.jsonl");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    const search = { schemaVersion: 1, timestamp: metrics.timestamp, platform: "linux", architecture: "x64", nodeVersion: process.version, claudeVersion: "2.1.209", requestBytes: 1, capturedBytes: 2, resultBytes: 3, durationMs: 4, lastPhase: "completed", initialized: true, cleanupComplete: true };
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = path;
    try {
        recordSearchMetrics(search);
        await flushMetricsLog();
        assert.equal(JSON.parse(await readFile(path, "utf8")).kind, "web_search");
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original;
        await rm(directory, { recursive: true, force: true });
    }
});
test("metrics flush serializes every queued provider and search record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-flush-metrics-"));
    const path = join(directory, "metrics.jsonl");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    const search = { schemaVersion: 1, timestamp: metrics.timestamp, platform: "linux", architecture: "x64", nodeVersion: process.version, claudeVersion: "2.1.209", requestBytes: 1, capturedBytes: 2, resultBytes: 3, durationMs: 4, lastPhase: "completed", initialized: true, cleanupComplete: true };
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = path;
    try {
        recordRequestMetrics(metrics);
        recordSearchMetrics(search);
        recordRequestMetrics({ ...metrics, requestedModel: "haiku" });
        await flushMetricsLog();
        const lines = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(lines.length, 3);
        assert.equal(lines[0].requestedModel, "sonnet");
        assert.equal(lines[1].kind, "web_search");
        assert.equal(lines[2].requestedModel, "haiku");
        if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    finally {
        await flushMetricsLog();
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original;
        await rm(directory, { recursive: true, force: true });
    }
});
test("last metrics are defensively cloned", () => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    try {
        recordRequestMetrics(metrics);
        const first = getLastRequestMetrics();
        first.cacheRead = 999;
        assert.equal(getLastRequestMetrics().cacheRead, 10);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original;
    }
});
test("metrics logging exposes only a sanitized latest failure", async () => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = join(tmpdir(), "pi-claude-code-provider-missing-directory", "metrics.jsonl");
    try {
        recordRequestMetrics(metrics);
        await flushMetricsLog();
        assert.equal(getMetricsLogError(), "ENOENT");
        assert.doesNotMatch(getMetricsLogError(), /tmp|metrics\.jsonl/);
        delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        recordRequestMetrics(metrics);
        assert.equal(getMetricsLogError(), undefined);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original;
    }
});
function doctorBase() {
    return { platformStatus: platformStatus("linux", "x64", "6.6-microsoft-standard-WSL2", "Ubuntu"), piStatus: versionStatus("Pi", "1", "1"), claudeStatus: versionStatus("Claude Code", "2", "1"), installation: { executable: "/usr/bin/claude", version: "2", subscriptionType: "pro" }, modelIds: ["sonnet"], runtimeCleanup: { removed: 0, failures: 0 } };
}
test("doctor summary handles absent, successful, and failed request diagnostics", () => {
    const base = { platformStatus: platformStatus("linux", "x64", "6.6-microsoft-standard-WSL2", "Ubuntu"), piStatus: versionStatus("Pi", "1", "1"), claudeStatus: versionStatus("Claude Code", "2", "1"), installation: { executable: "/usr/bin/claude", version: "2", subscriptionType: "pro" }, modelIds: ["sonnet"], runtimeCleanup: { removed: 0, failures: 0 } };
    assert.match(formatDoctorSummary(base), /no request metrics recorded/);
    assert.match(formatDoctorSummary({ ...base, metrics }), /1000 estimated transport tokens.*30 input, 10 cache read, 20 cache write, 16\.67% cache hit.*250ms.*stop/);
    assert.match(formatDoctorSummary({ ...base, metrics: { ...metrics, cacheRead: 0, cacheWrite: 0, cacheHitPercent: 0 } }), /30 input, 0 cache read, 0 cache write, 0% cache hit/);
    assert.match(formatDoctorSummary({ ...base, metrics: { ...metrics, inputTokens: 0, cacheRead: 0, cacheWrite: 0, cacheHitPercent: undefined } }), /reported token usage unavailable/);
    const failed = formatDoctorSummary({ ...base, metrics: { ...metrics, stopReason: "error", errorCategory: "protocol" } });
    assert.match(failed, /error \(protocol\)/);
    assert.match(formatDoctorSummary({ ...base, metricsLogError: "EACCES" }), /metrics log error: EACCES/);
    assert.match(formatDoctorSummary({ ...base, runtimeCleanup: { removed: 2, failures: 1 } }), /stale runtime cleanup: 2 removed, 1 failure/);
    assert.match(formatDoctorSummary({ ...base, metrics: { ...metrics, cleanupComplete: false, errorCategory: "process_cleanup" } }), /process_cleanup.*cleanup incomplete/);
    assert.doesNotMatch(failed, /prompt|secret|pi-claude-code-provider-/i);
});

test("diagnostic reports are bounded, private, redacted, and content-free", async () => {
    const path = await writeDiagnosticReport({
        platformStatus: platformStatus("darwin", "arm64"),
        piStatus: versionStatus("Pi", "1", "1"),
        preflightError: new ClaudeCodeError("executable_missing", `Claude missing below ${homedir()}`),
        metrics,
        runtimeCleanup: { removed: 2, failures: 1 },
    });
    try {
        if (process.platform !== "win32") {
            assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
            assert.equal((await stat(path)).mode & 0o777, 0o600);
        }
        const contents = await readFile(path, "utf8");
        assert.ok(Buffer.byteLength(contents) < 64 * 1024);
        assert.match(contents, /pi-claude-code-provider-diagnostics-v2/);
        assert.match(contents, /<HOME>/);
        assert.match(contents, /"runtimeCleanup"/);
        assert.match(contents, /"removed": 2/);
        assert.match(contents, /"failures": 1/);
        assert.doesNotMatch(contents, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(contents, /prompt|query|stderr|private@example/i);
    }
    finally {
        await rm(dirname(path), { recursive: true, force: true });
    }
});

test("the doctor completes a real bridge handshake under the hosting runtime", async () => {
    const probe = await probeBridge();
    assert.equal(probe.ok, true, probe.detail);
    assert.deepEqual(probe.argv, bridgeArgv());
    assert.match(probe.detail, /1 tool listed, ready marker written/);
    // A version or path check passes on an install whose bridge can never start,
    // so the summary must surface the handshake result and the resolved command.
    const summary = formatDoctorSummary({ ...doctorBase(), bridgeProbe: probe });
    assert.match(summary, /bridge ok via /);
    assert.match(summary, new RegExp(`runtime ${process.versions.bun ? "Bun" : "Node"} `));
    const broken = formatDoctorSummary({
        ...doctorBase(),
        bridgeProbe: { ok: false, argv: probe.argv, detail: "handshake failed (no tools/list result, ready marker missing)" },
    });
    assert.match(broken, /bridge BROKEN via .*ready marker missing/);
});

test("the diagnostic report records the distribution that decides bridge launching", async () => {
    const path = await writeDiagnosticReport({
        ...doctorBase(),
        bridgeProbe: { ok: false, argv: bridgeArgv(), detail: "handshake failed" },
    });
    try {
        const report = JSON.parse(await readFile(path, "utf8"));
        assert.equal(report.system.bunVersion, process.versions.bun);
        assert.match(report.system.hostRuntime, /^(Node|Bun) \S+ at /);
        assert.equal(report.bridge.ok, false);
        assert.ok(Array.isArray(report.bridge.argv));
        assert.match(report.bridge.detail, /handshake failed/);
        assert.doesNotMatch(JSON.stringify(report), new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
        await rm(dirname(path), { recursive: true, force: true });
    }
});

test("bridge argv diagnostics preserve argument boundaries", () => {
    const argv = ["/runtime with space/pi", "--config=/private config/bunfig.toml", "/package path/bridge.js"];
    assert.deepEqual(JSON.parse(formatBridgeArgv(argv)), argv);
    const summary = formatDoctorSummary({
        ...doctorBase(),
        bridgeProbe: { ok: false, argv, detail: "handshake failed" },
    });
    assert.ok(summary.includes(formatBridgeArgv(argv)));
});
