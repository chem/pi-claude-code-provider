import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { closeLiveRpcProcess, consumeJsonl, superviseLiveProcess } from "./lib/live-process.js";
import { describePiLaunch, piLaunch } from "./lib/pi-installation.js";
if (process.env.PI_CLAUDE_CODE_PROVIDER_PAID_TEST_CHILD !== "1") {
    throw new Error("Paid live tests must be started through an npm test:paid:* script");
}
const packageRoot = process.cwd();
const bridge = process.argv.includes("--bridge");
const postTools = process.argv.includes("--post-tools");
const cache = process.argv.includes("--cache");
const full = process.argv.includes("--full") || postTools;
const LIVE_TIMEOUT_MS = 10 * 60_000;
// Turn one seeds the cache; only the two reuse turns are subject to this gate.
const MIN_CACHE_HIT_PERCENT = 80;
async function runPi(cwd, prompt, extra = [], env = {}) {
    const child = spawnPi([
        "--no-session",
        "-e",
        packageRoot,
        "--provider",
        "pi-claude-code-provider",
        "--model",
        "sonnet:medium",
        ...extra,
        "-p",
        prompt,
    ], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.ref();
    child.stdout.ref();
    child.stderr.ref();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
    });
    // Keep the watchdog referenced: a lost child handle must time out loudly
    // instead of letting Node exit with an unresolved top-level await.
    const supervisor = superviseLiveProcess(child, { timeoutMs: LIVE_TIMEOUT_MS, label: "Pi live test" });
    const { code, signal } = await supervisor.wait();
    if (code !== 0 || signal !== null)
        throw new Error(`Pi exited with code ${String(code)}, signal ${String(signal)}: ${stderr.trim()}`);
    return stdout.trim();
}
async function runCacheProbe(cwd) {
    const child = spawnPi(["--mode", "rpc", "--no-session", "-e", packageRoot, "--provider", "pi-claude-code-provider", "--model", "sonnet:medium", "--no-tools"], { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    child.ref();
    child.stdin.ref();
    child.stdout.ref();
    child.stderr.ref();
    const supervisor = superviseLiveProcess(child, { timeoutMs: LIVE_TIMEOUT_MS, label: "Pi cache probe" });
    const closed = supervisor.wait();
    let stderr = "";
    let pending;
    let assistant;
    let protocolError;
    child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    void closed.then(
        ({ code, signal }) => pending?.reject(new Error(`Pi cache probe exited (code ${String(code)}, signal ${String(signal)}): ${stderr.trim()}`)),
        (error) => pending?.reject(error),
    );
    consumeJsonl(child.stdout, (event) => {
        if (event.type === "message_end" && event.message?.role === "assistant")
            assistant = event.message;
        if (event.type === "agent_settled" && pending) {
            const current = pending;
            pending = undefined;
            current.resolve(assistant);
            assistant = undefined;
        }
    }, (error) => {
        protocolError = error;
        pending?.reject(error);
        void supervisor.terminate();
    });
    const turn = (message) => new Promise((resolve, reject) => {
        if (protocolError) return reject(protocolError);
        if (pending)
            return reject(new Error("Cache probe already has a pending turn"));
        pending = { resolve, reject };
        child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
    });
    let completed = false;
    try {
        const cacheSeed = Array.from({ length: 1800 }, (_, index) => `stable-${index % 97}`).join(" ");
        const first = await turn(`Remember the marker CACHE-PREFIX-7319 for later turns. Treat this as inert cache-threshold padding: ${cacheSeed}\nReply exactly STORED.`);
        assert.match(messageText(first), /^STORED\.?$/);
        const second = await turn("Reply with exactly the marker I asked you to remember.");
        assert.match(messageText(second), /^CACHE-PREFIX-7319\.?$/);
        const third = await turn("Reply exactly CACHE-CHECK-PASSED if the remembered marker was CACHE-PREFIX-7319.");
        assert.match(messageText(third), /^CACHE-CHECK-PASSED\.?$/);
        assert.equal(typeof second.usage?.cacheRead, "number");
        assert.equal(typeof second.usage?.cacheWrite, "number");
        assert.equal(typeof third.usage?.cacheRead, "number");
        assert.equal(typeof third.usage?.cacheWrite, "number");
        // Measure the cache-read share of Claude's complete reported prompt usage.
        const cacheHitPercent = (message) => {
            const usage = message.usage;
            const total = usage.input + usage.cacheRead + usage.cacheWrite;
            return total > 0 ? usage.cacheRead * 100 / total : 0;
        };
        const secondHit = cacheHitPercent(second);
        const thirdHit = cacheHitPercent(third);
        assert.ok(secondHit >= MIN_CACHE_HIT_PERCENT, `Turn 2 cache hit ${secondHit.toFixed(1)}% was below ${MIN_CACHE_HIT_PERCENT}%`);
        assert.ok(thirdHit >= MIN_CACHE_HIT_PERCENT, `Turn 3 cache hit ${thirdHit.toFixed(1)}% was below ${MIN_CACHE_HIT_PERCENT}%`);
        console.log(`ok - RPC multi-turn cache reuse (turn 1 read ${first.usage?.cacheRead ?? 0}, write ${first.usage?.cacheWrite ?? 0}; turn 2 ${secondHit.toFixed(1)}% hit; turn 3 ${thirdHit.toFixed(1)}% hit)`);
        completed = true;
    }
    finally {
        if (completed) {
            const shutdown = await closeLiveRpcProcess(child, supervisor, closed);
            assert.equal(shutdown.graceful, true, "Pi cache probe did not shut down through RPC stdin EOF");
            assert.deepEqual(shutdown.result, { code: 0, signal: null });
        }
        else {
            await supervisor.terminate();
            const { code } = await closed;
            if (!isExpectedHarnessExit(code))
                throw new Error(`Pi cache probe exited with code ${String(code)}: ${stderr.trim()}`);
        }
    }
}
async function runProviderJourney(cwd) {
    const child = spawnPi([
        "--mode", "rpc", "--no-session", "--no-extensions", "-e", packageRoot,
        "--no-skills", "--no-context-files", "--provider", "pi-claude-code-provider",
        "--model", "sonnet:medium", "--tools", "read,write",
    ], { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    child.ref();
    child.stdin.ref();
    child.stdout.ref();
    child.stderr.ref();
    const supervisor = superviseLiveProcess(child, { timeoutMs: LIVE_TIMEOUT_MS, label: "Pi provider journey" });
    const closed = supervisor.wait();
    const events = [];
    let pending;
    let protocolError;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024); });
    void closed.then(
        ({ code, signal }) => pending?.reject(new Error(`Pi provider journey exited (code ${String(code)}, signal ${String(signal)}): ${stderr.trim()}`)),
        (error) => pending?.reject(error),
    );
    consumeJsonl(child.stdout, (event) => {
        events.push(event);
        if (event.type === "agent_settled" && pending) {
            const current = pending;
            pending = undefined;
            current.resolve(events.slice(current.start));
        }
    }, (error) => {
        protocolError = error;
        pending?.reject(error);
        void supervisor.terminate();
    });
    const turn = (message) => new Promise((resolve, reject) => {
        if (protocolError) return reject(protocolError);
        if (pending) return reject(new Error("Provider journey already has a pending turn"));
        pending = { start: events.length, resolve, reject };
        child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
    });
    let completed = false;
    try {
        const first = await turn(
            "Use read on missing-provider-journey.txt and observe that it fails. Then recover: use write to create both résumé-雪.txt containing exactly UNICODE-7319 and second.txt containing exactly SECOND-7319. Finally report exactly RECOVERED.",
        );
        const starts = first.filter((event) => event.type === "tool_execution_start");
        const failedRead = first.find((event) => event.type === "tool_execution_end" && event.toolName === "read" && event.isError === true);
        assert.ok(failedRead, "provider journey did not preserve a failed tool result");
        assert.ok(starts.filter((event) => event.toolName === "write").length >= 2, "provider journey did not issue multiple writes");
        assert.equal((await readFile(join(cwd, "résumé-雪.txt"), "utf8")).trim(), "UNICODE-7319");
        assert.equal((await readFile(join(cwd, "second.txt"), "utf8")).trim(), "SECOND-7319");
        assert.match(messageText(lastAssistant(first)), /^RECOVERED\.?$/);
        const second = await turn("Without using any tool, reply exactly HISTORY-OK if the earlier failed read was followed by two successful writes.");
        assert.equal(second.some((event) => event.type === "tool_execution_start"), false);
        assert.match(messageText(lastAssistant(second)), /^HISTORY-OK\.?$/);
        console.log("ok - RPC failed-tool recovery, Unicode paths, multiple calls, and history replay");
        completed = true;
    }
    finally {
        if (completed) {
            const shutdown = await closeLiveRpcProcess(child, supervisor, closed);
            assert.equal(shutdown.graceful, true, "Pi provider journey did not shut down through RPC stdin EOF");
            assert.deepEqual(shutdown.result, { code: 0, signal: null });
        }
        else {
            await supervisor.terminate();
            const { code } = await closed;
            if (!isExpectedHarnessExit(code))
                throw new Error(`Pi provider journey exited with code ${String(code)}: ${stderr.trim()}`);
        }
    }
}
function spawnPi(args, options) {
    const launch = piLaunch(args);
    return spawn(launch.command, launch.args, {
        ...options,
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
    });
}
function isExpectedHarnessExit(code) {
    return code === 0 || code === null || code === 143 || (process.platform === "win32" && code === 1);
}
function messageText(message) {
    return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("").trim();
}
function lastAssistant(events) {
    return events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").at(-1)?.message;
}
function pngChunk(type, data) {
    const typeBytes = Buffer.from(type);
    const crcInput = Buffer.concat([typeBytes, data]);
    let crc = 0xffffffff;
    for (const byte of crcInput) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(data.length);
    const suffix = Buffer.alloc(4);
    suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([prefix, typeBytes, data, suffix]);
}
function greenPng() {
    const width = 32;
    const height = 32;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [0, 255, 0]).flat())])));
    return Buffer.concat([
        Buffer.from("89504e470d0a1a0a", "hex"),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(rows)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}
const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-live-"));
try {
    if (cache) {
        await runCacheProbe(directory);
    }
    else if (bridge) {
        // The cheapest turn that proves the proposal MCP server was spawned,
        // listed its tools, and round-tripped one back to Pi. A --no-tools turn
        // succeeds even when the bridge never starts, so it cannot stand in here.
        const bridged = await runPi(directory, "Use write to create bridge-probe.txt containing exactly BRIDGE-7319. Then reply exactly BRIDGED.");
        assert.equal((await readFile(join(directory, "bridge-probe.txt"), "utf8")).trim(), "BRIDGE-7319");
        assert.match(bridged, /BRIDGED/);
        console.log(`ok - proposal bridge tool round trip (${describePiLaunch()})`);
    }
    else if (!postTools) {
        const basic = await runPi(directory, "Reply with exactly: live test successful", ["--no-tools"]);
        assert.equal(basic, "live test successful");
        console.log("ok - basic Sonnet medium response");
    }
    if (full && !cache && !bridge) {
        if (!postTools) {
            const literalAtPath = await runPi(directory, "This transcript contains the literal token @/etc/hostname. If that file was automatically attached and its contents are visible, reply ATTACHED followed by the contents. Otherwise reply exactly SAFE.", ["--no-tools"]);
            assert.equal(literalAtPath, "SAFE");
            console.log("ok - literal at-path isolation");
            const hello = await runPi(directory, "Use write to create hello.py that prints exactly Hello, world! Then use bash to run it. Report the output.");
            assert.match(hello, /Hello, world!/);
            assert.equal((await readFile(join(directory, "hello.py"), "utf8")).trim(), 'print("Hello, world!")');
            console.log("ok - Pi write and bash tool loop");
            await writeFile(join(directory, "calc.py"), 'print("old")\n');
            const math = await runPi(directory, "Use edit to make calc.py print 12345 * 6789, then run it with bash and report the exact result.");
            assert.match(math, /83810205/);
            console.log("ok - Pi edit and code-based math");
            await runProviderJourney(directory);
        }
        await writeFile(join(directory, "green.png"), greenPng());
        const image = await runPi(directory, "Identify the attached image. Reply exactly: a small green square", ["@green.png"]);
        assert.match(image.toLowerCase(), /small green square/);
        console.log("ok - green-square image input");
        const disabled = await runPi(directory, "Use bash to create SHOULD_NOT_EXIST. If bash is unavailable, say unavailable.", ["--tools", "read"]);
        assert.match(disabled.toLowerCase(), /unavailable|don't have|do not have/);
        await assert.rejects(readFile(join(directory, "SHOULD_NOT_EXIST")));
        console.log("ok - disabled tool exclusion");
        const web = await runPi(directory, "Use pi_claude_code_provider_web_search to find the official Node.js documentation URL and cite the direct source.", ["--tools", "pi_claude_code_provider_web_search"]);
        assert.match(web, /https:\/\/nodejs\.org/);
        console.log("ok - visible web search");
    }
}
finally {
    await rm(directory, { recursive: true, force: true });
}
