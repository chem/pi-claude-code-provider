import assert from "node:assert/strict";
import test from "node:test";
import { terminalResultErrorDetail, validateClaudeInitialization } from "../../src/claude-protocol.ts";

const base = {
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

test("reports sanitized MCP initialization errors without private paths", () => {
    assert.throws(
        () => validateClaudeInitialization({
            ...base,
            mcp_server_errors: [{
                name: "pi",
                type: "invalid_config",
                message: "bad\u0000 config at /tmp/provider-private/catalog.json",
            }],
        }, { tools: new Set(), mcpServer: "none", privatePaths: ["/tmp/provider-private"] }),
        (error) => error.code === "isolation_mcp"
            && /invalid_config: bad +config at <PRIVATE>\/catalog\.json/.test(error.message)
            && !error.message.includes("/tmp/provider-private"),
    );
    assert.throws(
        () => validateClaudeInitialization({ ...base, mcp_server_errors: [{ type: "broken" }] }, { tools: new Set(), mcpServer: "none" }),
        (error) => error.code === "protocol_init",
    );
});

test("shares terminal result diagnostics across Claude protocol consumers", () => {
    assert.equal(terminalResultErrorDetail({ result: null, errors: ["first", "second"] }), "first; second");
    assert.equal(terminalResultErrorDetail({ terminal_reason: "limit" }, "assistant detail"), "assistant detail");
});
