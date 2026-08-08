import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildClaudeEnvironment, inspectClaudeInstallation, parseAuthStatus, validateClaudeCapabilities } from "../../src/auth.ts";
import { VERIFIED_VERSIONS } from "../../src/compatibility.ts";
import { validateProcessTerminationCapability, windowsTaskkillExecutable } from "../../src/process-utils.ts";
import { CLAUDE_HEADLESS_HELP, ELIGIBLE_CLAUDE_AUTH, ELIGIBLE_CLAUDE_AUTH_JSON } from "../support/claude-fixture.js";
import { nodeFixtureSource } from "../support/node-fixture.js";

const bracketedSystemPromptHelp = CLAUDE_HEADLESS_HELP.replace("--system-prompt\n--system-prompt-file", "--system-prompt[-file]");

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
        assert.equal(env.DISABLE_NON_ESSENTIAL_MODEL_CALLS, "1");
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
    assert.doesNotThrow(() => validateClaudeCapabilities(CLAUDE_HEADLESS_HELP));
    assert.throws(() => validateClaudeCapabilities(CLAUDE_HEADLESS_HELP.replace("--effort", "")), /--effort/);
    assert.throws(() => validateClaudeCapabilities(CLAUDE_HEADLESS_HELP.replace("--system-prompt-file", "")), /--system-prompt-file/);
    assert.throws(() => validateClaudeCapabilities(CLAUDE_HEADLESS_HELP.replace("--system-prompt\n", "")), /--system-prompt/);
    assert.throws(() => validateClaudeCapabilities(CLAUDE_HEADLESS_HELP.replace("--permission-mode", "")), /--permission-mode/);
});

// Fake Claude programs use synchronous test-only stdio because some restricted
// sandboxes lose buffered output from nested Node children despite a zero exit.
test("resolves a directly launchable Claude executable through Windows PATHEXT", { skip: process.platform !== "win32" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-auth-path-"));
    const claude = join(directory, "claude.cjs");
    await writeFile(claude, nodeFixtureSource(`
if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${VERIFIED_VERSIONS.claudeCode}\n`)});
else if (process.argv[2] === "auth") process.stdout.write(${JSON.stringify(ELIGIBLE_CLAUDE_AUTH_JSON)});
else process.stdout.write(${JSON.stringify(bracketedSystemPromptHelp)});
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
if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${VERIFIED_VERSIONS.claudeCode}\n`)});
else if (process.argv[2] === "auth") process.stdout.write(${JSON.stringify(ELIGIBLE_CLAUDE_AUTH_JSON)});
else process.stdout.write(${JSON.stringify(bracketedSystemPromptHelp)});
`), { mode: 0o700 });
    await chmod(claude, 0o700);
    const originalClaude = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = claude;
    try {
        const installation = await inspectClaudeInstallation();
        assert.equal(installation.executable, await realpath(claude));
        assert.equal(installation.version, VERIFIED_VERSIONS.claudeCode);
        assert.equal(installation.subscriptionType, "pro");
        await writeFile(claude, "#!/usr/bin/env node\n", { mode: 0o700 });
        await assert.rejects(inspectClaudeInstallation(), /determine the Claude Code version/);
    }
    finally {
        if (originalClaude === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH; else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = originalClaude;
        await rm(directory, { recursive: true, force: true });
    }
});
