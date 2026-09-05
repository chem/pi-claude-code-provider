import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_PATH, baseClaudeArgs, providerArgs } from "../../src/claude-args.ts";
import { NEUTRAL_BUN_CONFIG, needsBunConfig, scriptLaunch } from "../../src/host-runtime.ts";
test("uses only generated attachment references and replacement prompt", () => {
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"protocol":"test"}', '{"content":"\\u0040/etc/passwd"}'],
        attachmentPaths: ["/tmp/private/image.png"],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        catalogPath: undefined,
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageBytes: 1,
    };
    const { args, prompt } = providerArgs(prepared, "sonnet", "medium");
    const promptText = prompt.map((block) => block.text).join("\n");
    const joined = args.join("\n");
    assert.equal(prompt.length, 3);
    assert.match(promptText, /@\.\/image.png/);
    assert.doesNotMatch(promptText, /\/tmp\/private/);
    assert.doesNotMatch(promptText, /request\.json/);
    assert.doesNotMatch(promptText, /@\/etc\/passwd/);
    assert.match(promptText, /\\u0040\/etc\/passwd/);
    assert.ok(args.includes("--system-prompt-file"));
    assert.ok(args.includes(prepared.systemPromptPath));
    assert.doesNotMatch(joined, /exact system @not-an-attachment/);
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(args.includes("dontAsk"));
    assert.ok(args.includes(""));
    assert.deepEqual(prompt.map((block) => block.text), [
        ...prepared.transcriptBlocks,
        "Generated image attachments for image_attachment blocks: @./image.png.",
    ]);
});

test("every advertised alias is passed to Claude verbatim", () => {
    const prepared = { transcriptBlocks: [], attachmentPaths: [], systemPromptPath: "/tmp/system.txt" };
    for (const model of ["sonnet", "opus", "haiku", "fable"]) {
        const { args } = providerArgs(prepared, model, "low");
        assert.equal(args[args.indexOf("--model") + 1], model);
    }
});

test("pins cache-stable Claude settings and omits fixed outer guidance", () => {
    const args = baseClaudeArgs();
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    assert.deepEqual(settings, {
        disableAllHooks: true,
        autoMemoryEnabled: false,
        totalTokensReminder: "off",
    });
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"protocol":"test"}'],
        attachmentPaths: [],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageBytes: 0,
    };
    const generated = providerArgs(prepared, "sonnet", "low");
    assert.deepEqual(generated.prompt, [{ type: "text", text: prepared.transcriptBlocks[0] }]);
});

test("proposal MCP server launches the bridge through the hosting runtime", () => {
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"protocol":"test"}'],
        attachmentPaths: [],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        catalogPath: "/tmp/private/catalog.json",
        violationPath: "/tmp/private/violation",
        readyPath: "/tmp/private/ready",
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 1,
        imageBytes: 0,
    };
    const { args } = providerArgs(prepared, "sonnet", "medium");
    const server = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.pi;
    const expected = scriptLaunch(BRIDGE_PATH);
    assert.equal(server.command, expected.command);
    assert.deepEqual(server.args, expected.args);
    assert.equal(server.env.PI_CLAUDE_TOOL_CATALOG, prepared.catalogPath);
    assert.equal(server.env.PI_CLAUDE_TOOL_VIOLATION, prepared.violationPath);
    assert.equal(server.env.PI_CLAUDE_TOOL_READY, prepared.readyPath);
    // A compiled standalone Pi is its own entry point, so handing it the bridge
    // path without BUN_BE_BUN silently starts a chat instead of the MCP server.
    assert.equal(server.env.BUN_BE_BUN, process.versions.bun ? "1" : undefined);
});

test("script launch adapts to the npm and standalone Pi distributions", () => {
    assert.deepEqual(scriptLaunch("/pkg/bridge.js", [], undefined, "/usr/bin/node", undefined), {
        command: "/usr/bin/node",
        args: ["/pkg/bridge.js"],
        env: {},
    });
    assert.deepEqual(scriptLaunch("/pkg/bridge.js", ["--flag"], undefined, "/opt/pi/pi", "1.3.14"), {
        command: "/opt/pi/pi",
        args: ["/pkg/bridge.js", "--flag"],
        env: { BUN_BE_BUN: "1" },
    });
    // Node ignores a bunfig entirely, so the neutral config is Bun-only.
    assert.deepEqual(scriptLaunch("/pkg/bridge.js", [], "/priv/bunfig.toml", "/usr/bin/node", undefined).args, ["/pkg/bridge.js"]);
});

test("the standalone bridge cannot be preloaded from its working directory", () => {
    // Pi's --no-compile-autoload-bunfig is a property of its own compiled entry
    // point and does not survive BUN_BE_BUN, so the launch must pin the config.
    const launch = scriptLaunch("/pkg/bridge.js", [], "/priv/bunfig.toml", "/opt/pi/pi", "1.3.14");
    assert.deepEqual(launch.args, ["--config=/priv/bunfig.toml", "/pkg/bridge.js"]);
    // Bun ignores a space-separated --config and then swallows the script path,
    // so the joined form is load-bearing rather than stylistic.
    assert.ok(launch.args.every((argument) => argument !== "--config"));
    assert.ok(needsBunConfig("1.3.14"));
    assert.ok(!needsBunConfig(undefined));
    // Every line must be inert: a bunfig this package writes may never itself
    // carry a directive, only comments.
    assert.ok(NEUTRAL_BUN_CONFIG.split("\n").filter(Boolean).every((line) => line.startsWith("#")));
});
