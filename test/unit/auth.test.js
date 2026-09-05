import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { REQUIRED_HEADLESS_FLAGS, buildClaudeEnvironment, inspectClaudeInstallation, parseAuthStatus, validateClaudeCapabilities } from "../../src/auth.ts";
import { MINIMUM_VERSIONS, meetsMinimumVersion } from "../../src/compatibility.ts";
import { validateProcessTerminationCapability, windowsTaskkillExecutable } from "../../src/process-utils.ts";
import { CAPTURED_CLAUDE_VERSION, CLAUDE_HEADLESS_HELP, ELIGIBLE_CLAUDE_AUTH, ELIGIBLE_CLAUDE_AUTH_JSON } from "../support/claude-fixture.js";
import { nodeFixtureSource } from "../support/node-fixture.js";

// Preflight mechanics are independent of the compatibility baseline, so these
// fixtures track the captured help artifact rather than a constant a paid gate moves.
const FIXTURE_CLAUDE_VERSION = CAPTURED_CLAUDE_VERSION;

function missingClaudeCapabilities(help) {
    try {
        validateClaudeCapabilities(help);
        return [];
    } catch (error) {
        assert.match(error.message, /missing required headless capabilities:/);
        return error.message.split(": ").at(-1).split(", ");
    }
}

test("normalizes every eligible subscription without returning PII", () => {
    for (const subscriptionType of ["pro", "max", "team", "enterprise"]) {
        const status = { ...ELIGIBLE_CLAUDE_AUTH, subscriptionType: subscriptionType.toUpperCase() };
        assert.equal(parseAuthStatus(JSON.stringify(status)), subscriptionType);
    }
});
test("rejects API and malformed auth", () => {
    assert.throws(() => parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "apiKey" })), /subscription/);
    assert.throws(() => parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "free" })), /Unsupported/);
    assert.throws(() => parseAuthStatus("not json"), /invalid/);
});
test("builds an allowlisted Claude environment", () => {
    const forbidden = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "CLAUDE_CODE_OAUTH_TOKEN"];
    const originals = Object.fromEntries(forbidden.map((name) => [name, process.env[name]]));
    for (const name of forbidden)
        process.env[name] = "secret";
    try {
        const env = buildClaudeEnvironment();
        for (const name of forbidden)
            assert.equal(env[name], undefined);
        assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
        assert.equal(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS, undefined);
        assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
        assert.equal(env.HOME, process.env.HOME);
    }
    finally {
        for (const name of forbidden) {
            if (originals[name] === undefined)
                delete process.env[name];
            else
                process.env[name] = originals[name];
        }
    }
});
test("requires the Claude Code headless command surface", () => {
    // Every assertion runs against help the CLI really emitted, so a spelling
    // this project assumes but Claude Code never produces cannot pass here.
    assert.doesNotThrow(() => validateClaudeCapabilities(CLAUDE_HEADLESS_HELP));
    assert.equal(REQUIRED_HEADLESS_FLAGS.length > 0, true);
    for (const option of REQUIRED_HEADLESS_FLAGS) {
        const pattern = new RegExp(`${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
        assert.equal(pattern.test(CLAUDE_HEADLESS_HELP), true, `${option} appears in captured help`);
        assert.equal(missingClaudeCapabilities(CLAUDE_HEADLESS_HELP).includes(option), false, `${option} positive token`);
        assert.equal(
            missingClaudeCapabilities(CLAUDE_HEADLESS_HELP.replace(pattern, "--removed-flag")).includes(option),
            true,
            `${option} omission`,
        );
        assert.equal(
            missingClaudeCapabilities(CLAUDE_HEADLESS_HELP.replace(pattern, `${option}-old`)).includes(option),
            true,
            `${option} near miss`,
        );
    }
});

test("does not require the documented flags Claude Code hides from its help", () => {
    // --system-prompt-file is documented and accepted, but has no help row.
    // Requiring it made preflight fail where the real launch succeeds.
    assert.equal(CLAUDE_HEADLESS_HELP.includes("--system-prompt-file "), false);
    assert.equal(REQUIRED_HEADLESS_FLAGS.includes("--system-prompt-file"), false);
    assert.doesNotThrow(() => validateClaudeCapabilities(CLAUDE_HEADLESS_HELP));
});

test("matches option aliases and value notation", () => {
    assert.doesNotThrow(() => validateClaudeCapabilities(
        CLAUDE_HEADLESS_HELP
            .replace("--allowedTools", "--allowedTools, --allowed-tools=<tools...>")
            .replace("--model", "--model=<model>")
            .replace("--prompt-suggestions", "--prompt-suggestions [value]"),
    ));
});

test("compares versions numerically rather than lexically", () => {
    // The failure this guards is real: "2.1.9" sorts above "2.1.241" as strings.
    assert.equal(meetsMinimumVersion("2.1.9", "2.1.241"), false);
    assert.equal(meetsMinimumVersion("2.1.261", MINIMUM_VERSIONS.claudeCode), true);
    assert.equal(meetsMinimumVersion("2.1.260", MINIMUM_VERSIONS.claudeCode), false);
    assert.equal(meetsMinimumVersion("2.2.0", MINIMUM_VERSIONS.claudeCode), true);
    assert.equal(meetsMinimumVersion("3.0.0", MINIMUM_VERSIONS.claudeCode), true);
    assert.equal(meetsMinimumVersion("0.85.1", MINIMUM_VERSIONS.pi), true);
    assert.equal(meetsMinimumVersion("0.84.10", MINIMUM_VERSIONS.pi), false);
});

// Fake Claude programs use synchronous test-only stdio because some restricted
// sandboxes lose buffered output from nested Node children despite a zero exit.
test("resolves a directly launchable Claude executable through Windows PATHEXT", { skip: process.platform !== "win32" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-auth-path-"));
    const claude = join(directory, "claude.cjs");
    await writeFile(claude, nodeFixtureSource(`
if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${FIXTURE_CLAUDE_VERSION}\n`)});
else if (process.argv[2] === "auth") process.stdout.write(${JSON.stringify(ELIGIBLE_CLAUDE_AUTH_JSON)});
else process.stdout.write(${JSON.stringify(CLAUDE_HEADLESS_HELP)});
`));
    const original = {
        path: process.env.PATH,
        pathExt: process.env.PATHEXT,
        override: process.env.PI_CLAUDE_CODE_PROVIDER_PATH,
    };
    process.env.PATH = directory;
    process.env.PATHEXT = ".CJS;.CMD";
    delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    try {
        const installation = await inspectClaudeInstallation();
        assert.equal(installation.executable, await realpath(claude));
        assert.equal(installation.subscriptionType, "pro");
    }
    finally {
        if (original.path === undefined) delete process.env.PATH; else process.env.PATH = original.path;
        if (original.pathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = original.pathExt;
        if (original.override === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH; else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original.override;
        await rm(directory, { recursive: true, force: true });
    }
});

test("validates the built-in Windows taskkill capability without PATH lookup", { skip: process.platform !== "win32" }, async () => {
    assert.match(windowsTaskkillExecutable(), /[\\/]System32[\\/]taskkill\.exe$/i);
    await assert.doesNotReject(validateProcessTerminationCapability());
    await assert.rejects(validateProcessTerminationCapability("win32", {}), /SystemRoot/);
});

test("preflight honors and functionally validates the Claude executable override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-auth-"));
    const claude = join(directory, process.platform === "win32" ? "claude.cjs" : "claude");
    await writeFile(claude, nodeFixtureSource(`
if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${FIXTURE_CLAUDE_VERSION}\n`)});
else if (process.argv[2] === "auth") process.stdout.write(${JSON.stringify(ELIGIBLE_CLAUDE_AUTH_JSON)});
else process.stdout.write(${JSON.stringify(CLAUDE_HEADLESS_HELP)});
`), { mode: 0o700 });
    await chmod(claude, 0o700);
    const originalClaude = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = claude;
    try {
        const installation = await inspectClaudeInstallation();
        assert.equal(installation.executable, await realpath(claude));
        assert.equal(installation.version, FIXTURE_CLAUDE_VERSION);
        assert.equal(installation.subscriptionType, "pro");
        await writeFile(claude, "#!/usr/bin/env node\n", { mode: 0o700 });
        await assert.rejects(inspectClaudeInstallation(), /determine the Claude Code version/);
    }
    finally {
        if (originalClaude === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH; else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = originalClaude;
        await rm(directory, { recursive: true, force: true });
    }
});
