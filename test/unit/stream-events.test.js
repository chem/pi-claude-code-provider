import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ClaudeEventMapper as EventMapper, argumentPreviewDue } from "../../src/stream-events.ts";
import { createOutput } from "../../src/output.ts";
import { PROVIDER_INIT_FIELDS, initRecord as claudeInitRecord } from "../support/claude-fixture.js";

function makeMapper(stream, output, expectedTools, toolNames, onToolUse, onRateLimitNotice, onResponseAnnouncement) {
    return new EventMapper({ stream, output, expectedTools, toolNames, onToolUse, onRateLimitNotice, onResponseAnnouncement });
}

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

function initRecord(tools = [], mcpServers = []) {
    return claudeInitRecord(PROVIDER_INIT_FIELDS, { tools, mcp_servers: mcpServers });
}

test("maps text, thinking, tool arguments, usage, and tool termination", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    let toolUse = false;
    const mapper = makeMapper(stream, output, new Set(["mcp__pi__calculate"]), new Map([["mcp__pi__calculate", "calculate"]]), () => {
        toolUse = true;
        mapper.completeToolUse();
    });
    const events = [];
    const consume = (async () => {
        for await (const event of stream)
            events.push(event.type);
    })();
    mapper.accept(initRecord(["mcp__pi__calculate"], [{ name: "pi", status: "connected" }]));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__pi__calculate", input: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"value":' } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "42}" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 1 } });
    mapper.accept({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } } });
    await consume;
    assert.equal(toolUse, true);
    assert.equal(output.stopReason, "toolUse");
    assert.equal(output.responseModel, "claude-sonnet-5");
    assert.equal(output.usage.totalTokens, 17);
    const thinking = output.content[0];
    assert.equal(thinking?.type, "thinking");
    if (thinking?.type === "thinking")
        assert.equal(thinking.thinkingSignature, "sig");
    const tool = output.content[1];
    assert.equal(tool?.type, "toolCall");
    if (tool?.type === "toolCall")
        assert.deepEqual(tool.arguments, { value: 42 });
    assert.deepEqual(events, [
        "start",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "toolcall_start",
        "toolcall_delta",
        "toolcall_delta",
        "toolcall_end",
        "done",
    ]);
});
test("preserves mixed content and multiple tool calls by Pi content index", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    let toolUse = false;
    const mapper = makeMapper(
        stream,
        output,
        new Set(["mcp__pi__read", "mcp__pi__search"]),
        new Map([
            ["mcp__pi__read", "read"],
            ["mcp__pi__search", "search"],
        ]),
        () => { toolUse = true; },
    );
    const events = [];
    const consume = (async () => {
        for await (const event of stream)
            events.push({ type: event.type, contentIndex: event.contentIndex });
    })();
    mapper.accept(initRecord(["mcp__pi__read", "mcp__pi__search"], [{ name: "pi", status: "connected" }]));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_multi", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking both sources." } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_read", name: "mcp__pi__read", input: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"README' } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '.md"}' } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 1 } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_search", name: "mcp__pi__search", input: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query":"cache' } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ' behavior"}' } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 2 } });
    mapper.accept({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} } });
    mapper.accept({ type: "stream_event", event: { type: "message_stop" } });
    mapper.completeToolUse();
    await consume;
    assert.equal(toolUse, true);
    assert.deepEqual(output.content, [
        { type: "text", text: "Checking both sources." },
        { type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "README.md" } },
        { type: "toolCall", id: "toolu_search", name: "search", arguments: { query: "cache behavior" } },
    ]);
    assert.deepEqual(
        events.filter((event) => event.type.endsWith("_start") || event.type.endsWith("_end")),
        [
            { type: "text_start", contentIndex: 0 },
            { type: "text_end", contentIndex: 0 },
            { type: "toolcall_start", contentIndex: 1 },
            { type: "toolcall_end", contentIndex: 1 },
            { type: "toolcall_start", contentIndex: 2 },
            { type: "toolcall_end", contentIndex: 2 },
        ],
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
});
test("rejects unexpected initialization tools", () => {
    const stream = createAssistantMessageEventStream();
    const mapper = makeMapper(stream, createOutput(model), new Set(), new Map(), () => { });
    assert.throws(() => mapper.accept(initRecord(["Bash"])), /unexpected tool/);
});
function init(mapper) {
    mapper.accept(initRecord());
}
function retryRecord(attempt = 1) {
    return {
        type: "system",
        subtype: "api_retry",
        attempt,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: 529,
        error: "overloaded",
        uuid: `retry-${attempt}`,
        session_id: "session-1",
    };
}
function exactToolTerminationResult(overrides = {}) {
    return {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        stop_reason: "tool_use",
        terminal_reason: "aborted_streaming",
        usage: { input_tokens: 4, output_tokens: 2 },
        modelUsage: { sonnet: { contextWindow: 1000000, maxOutputTokens: 64000 } },
        ...overrides,
    };
}
function readyToolMapper(stopReason = "tool_use") {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(["mcp__pi__read"]), new Map([["mcp__pi__read", "read"]]), () => { });
    mapper.accept(initRecord(["mcp__pi__read"], [{ name: "pi", status: "connected" }]));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_tool_ack", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_ack", name: "mcp__pi__read", input: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"package.json"}' } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    mapper.accept({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stopReason }, usage: {} } });
    return { stream, output, mapper };
}
test("rejects duplicate initialization, unknown records, and invalid event ordering", () => {
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { });
    init(mapper);
    assert.throws(() => init(mapper), /duplicate initialization/);
    const unknown = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { });
    init(unknown);
    assert.throws(() => unknown.accept({ type: "future_protocol_record" }), /Unsupported Claude record/);
    const ordering = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { });
    init(ordering);
    assert.throws(() => ordering.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }), /before message_start/);
});
test("maps result-only fallback text, served limits, and cache details", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(), new Map(), () => { });
    const events = [];
    const consume = (async () => {
        for await (const event of stream)
            events.push(event.type);
    })();
    init(mapper);
    mapper.accept({ type: "result", is_error: false, result: "fallback", stop_reason: "max_tokens", usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 1 }, output_tokens_details: { thinking_tokens: 2 } }, modelUsage: { sonnet: { contextWindow: 200000, maxOutputTokens: 64000 } } });
    assert.equal(mapper.hasSuccessfulResult, true);
    assert.equal(mapper.isTerminal, false);
    mapper.completeResult();
    await consume;
    assert.equal(output.content[0].text, "fallback");
    assert.equal(output.usage.totalTokens, 14);
    assert.equal(output.usage.reasoning, 2);
    assert.equal(output.usage.cacheWrite1h, 1);
    assert.equal(mapper.contextWindow, 200000);
    assert.equal(mapper.maxOutputTokens, 64000);
    assert.equal(output.stopReason, "length");
    assert.deepEqual(events, ["start", "text_start", "text_delta", "text_end", "done"]);
});
test("maps an explicit Claude error result to one terminal error", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(), new Map(), () => { });
    const events = [];
    const consume = (async () => {
        for await (const event of stream)
            events.push(event.type);
    })();
    init(mapper);
    mapper.accept({ type: "result", is_error: true, api_error_status: 429, result: "subscription limit reached" });
    mapper.fail("late duplicate failure");
    await consume;
    assert.deepEqual(events, ["start", "error"]);
    assert.equal(output.stopReason, "error");
    assert.match(output.errorMessage ?? "", /429.*subscription limit reached/);
});
test("keeps assistant and loop diagnostics when the result text is empty", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(), new Map(), () => { });
    init(mapper);
    mapper.accept({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You're out of usage credits" }] } });
    mapper.accept({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "", errors: ["loop detail"] });
    const result = await stream.result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /429.*You're out of usage credits/);
});
test("stages the exact captured Claude tool-handoff acknowledgement", async () => {
    const { stream, output, mapper } = readyToolMapper();
    const events = [];
    const consume = (async () => {
        for await (const event of stream)
            events.push(event.type);
    })();
    mapper.accept(exactToolTerminationResult(), "tool_handoff");
    assert.equal(mapper.isTerminal, false);
    assert.equal(output.usage.totalTokens, 6);
    assert.equal(mapper.contextWindow, 1000000);
    assert.equal(mapper.maxOutputTokens, 64000);
    assert.equal(mapper.completeToolUse(), true);
    assert.equal(mapper.completeToolUse(), false);
    await consume;
    assert.deepEqual(events, ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
    assert.equal(events.filter((type) => type === "done" || type === "error").length, 1);
    assert.equal(output.stopReason, "toolUse");
});
test("fails closed on tool-handoff acknowledgement near misses", async () => {
    const cases = [
        { name: "wrong cause", cause: "none", record: exactToolTerminationResult() },
        { name: "wrong subtype", cause: "tool_handoff", record: exactToolTerminationResult({ subtype: "error" }) },
        { name: "null API status", cause: "tool_handoff", record: exactToolTerminationResult({ api_error_status: null }) },
        { name: "zero API status", cause: "tool_handoff", record: exactToolTerminationResult({ api_error_status: 0 }) },
        { name: "non-null API status", cause: "tool_handoff", record: exactToolTerminationResult({ api_error_status: 500 }) },
        { name: "wrong result stop", cause: "tool_handoff", record: exactToolTerminationResult({ stop_reason: "end_turn" }) },
        { name: "wrong terminal reason", cause: "tool_handoff", record: exactToolTerminationResult({ terminal_reason: "provider_error" }) },
        { name: "null result reason", cause: "tool_handoff", record: exactToolTerminationResult({ result: null }) },
        { name: "conflicting result reason", cause: "tool_handoff", record: exactToolTerminationResult({ result: "real_error" }) },
    ];
    for (const entry of cases) {
        const { stream, mapper } = readyToolMapper();
        mapper.accept(entry.record, entry.cause);
        const result = await stream.result();
        assert.equal(result.stopReason, "error", entry.name);
    }
    const wrongMappedStop = readyToolMapper("end_turn");
    wrongMappedStop.mapper.accept(exactToolTerminationResult(), "tool_handoff");
    assert.equal((await wrongMappedStop.stream.result()).stopReason, "error");
});
test("rejects duplicate records and records after a staged tool acknowledgement", () => {
    const { mapper } = readyToolMapper();
    mapper.accept(exactToolTerminationResult(), "tool_handoff");
    assert.throws(() => mapper.accept(exactToolTerminationResult(), "tool_handoff"), /after its result/);
    assert.throws(() => mapper.accept({ type: "system", subtype: "status" }, "tool_handoff"), /after its result/);
});
test("does not reinterpret a tool acknowledgement after caller abort", async () => {
    const { stream, mapper } = readyToolMapper();
    mapper.fail("Claude Code request was aborted", true);
    mapper.accept(exactToolTerminationResult(), "caller_abort");
    const result = await stream.result();
    assert.equal(result.stopReason, "aborted");
    assert.equal(mapper.completeToolUse(), false);
});
test("rejects a tool acknowledgement while arguments remain incomplete", () => {
    const stream = createAssistantMessageEventStream();
    const mapper = makeMapper(stream, createOutput(model), new Set(["mcp__pi__read"]), new Map([["mcp__pi__read", "read"]]), () => { });
    mapper.accept(initRecord(["mcp__pi__read"], [{ name: "pi", status: "connected" }]));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_open", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_open", name: "mcp__pi__read", input: {} } } });
    assert.throws(() => mapper.accept(exactToolTerminationResult(), "tool_handoff"), /unclosed content blocks/);
});
test("emits validated rate-limit notices and retains rejected diagnostics", () => {
    // Repeats are de-duplicated per session by the extension, not here; see
    // extension.test.js "reports a repeated rate-limit warning once per session".
    const notices = [];
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { }, (notice) => notices.push(notice));
    init(mapper);
    mapper.accept({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    mapper.accept({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.876 } });
    mapper.accept({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000 } });
    assert.deepEqual(notices, [
        { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.876 },
        { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000_000 },
    ]);
    assert.match(mapper.rateLimitFailure, /five_hour/);
    assert.match(mapper.rateLimitFailure, /2027-/);
});
test("does not double-convert epoch-millisecond reset timestamps", () => {
    const notices = [];
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { }, (notice) => notices.push(notice));
    init(mapper);
    mapper.accept({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000_000 } });
    assert.deepEqual(notices, [{ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000_000 }]);
});
test("ignores malformed optional rate-limit fields and notification failures", () => {
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { }, () => {
        throw new Error("UI unavailable");
    });
    init(mapper);
    assert.doesNotThrow(() => mapper.accept({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", rateLimitType: {}, utilization: 1.01, resetsAt: "later" },
    }));
    assert.doesNotThrow(() => mapper.accept({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Number.POSITIVE_INFINITY },
    }));
    assert.doesNotThrow(() => mapper.accept({ type: "rate_limit_event", rate_limit_info: null }));
    assert.doesNotThrow(() => mapper.accept({ type: "rate_limit_event", rate_limit_info: [] }));
    assert.doesNotThrow(() => mapper.accept({ type: "rate_limit_event" }));
    assert.match(mapper.rateLimitFailure, /five_hour/);
    assert.doesNotMatch(mapper.rateLimitFailure, /resets at/);
});
test("ignores a rejected overage while the plan window is healthy", () => {
    const notices = [];
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { }, (notice) => notices.push(notice));
    init(mapper);
    // A subscription without usage credits reports this on every event.
    mapper.accept({
        type: "rate_limit_event",
        rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.11,
            resetsAt: 1_800_000_000,
            overageStatus: "rejected",
            overageDisabledReason: "org_level_disabled",
            isUsingOverage: false,
        },
    });
    // The same steady state with no primary status field at all.
    mapper.accept({
        type: "rate_limit_event",
        rate_limit_info: { overageStatus: "rejected", overageDisabledReason: "org_level_disabled" },
    });
    assert.deepEqual(notices, []);
    assert.equal(mapper.rateLimitFailure, undefined);
});
test("keeps the plan window and utilization when overage is merely disabled", () => {
    const notices = [];
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { }, (notice) => notices.push(notice));
    init(mapper);
    mapper.accept({
        type: "rate_limit_event",
        rate_limit_info: {
            status: "allowed_warning",
            rateLimitType: "five_hour",
            utilization: 0.77,
            resetsAt: 1_800_000_000,
            overageStatus: "rejected",
            overageDisabledReason: "org_level_disabled",
            isUsingOverage: false,
        },
    });
    assert.deepEqual(notices, [{
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.77,
        resetsAt: 1_800_000_000_000,
    }]);
    assert.equal(mapper.rateLimitFailure, undefined);
});
test("retains overage context when the plan window is exhausted", () => {
    const notices = [];
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { }, (notice) => notices.push(notice));
    init(mapper);
    mapper.accept({
        type: "rate_limit_event",
        rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            utilization: 1,
            resetsAt: 1_800_000_000,
            overageStatus: "rejected",
            overageResetsAt: 1_800_000_100,
            overageDisabledReason: "out_of_credits",
        },
    });
    assert.deepEqual(notices, [{
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 1,
        resetsAt: 1_800_000_000_000,
        overageStatus: "rejected",
        overageResetsAt: 1_800_000_100_000,
        overageDisabledReason: "out_of_credits",
    }]);
    assert.match(mapper.rateLimitFailure, /five_hour.*out_of_credits/);
});
test("escalates a rejected overage while the account is drawing on overage", () => {
    const notices = [];
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { }, (notice) => notices.push(notice));
    init(mapper);
    mapper.accept({
        type: "rate_limit_event",
        rate_limit_info: {
            status: "allowed",
            rateLimitType: "five_hour",
            utilization: 0.9,
            overageStatus: "rejected",
            overageResetsAt: 1_800_000_100,
            overageDisabledReason: "out_of_credits",
            isUsingOverage: true,
        },
    });
    assert.deepEqual(notices, [{
        status: "rejected",
        rateLimitType: "overage",
        resetsAt: 1_800_000_100_000,
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
        isUsingOverage: true,
    }]);
    assert.match(mapper.rateLimitFailure, /overage.*out_of_credits/);
});
test("maps redacted thinking into Pi's opaque thinking representation", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(), new Map(), () => { });
    const events = [];
    const consume = (async () => {
        for await (const event of stream) events.push(event.type);
    })();
    init(mapper);
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque-encrypted-data" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    mapper.accept({ type: "result", is_error: false, result: "" });
    mapper.completeResult();
    await consume;
    assert.deepEqual(output.content[0], { type: "thinking", thinking: "", thinkingSignature: "opaque-encrypted-data", redacted: true });
    assert.deepEqual(events, ["start", "thinking_start", "thinking_end", "done"]);

    const malformed = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { });
    init(malformed);
    malformed.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg", model: "claude-sonnet-5", usage: {} } } });
    assert.throws(
        () => malformed.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } } }),
        /without opaque data/,
    );
});
test("rejects unsupported blocks, deltas, unclosed blocks, and events after stop", () => {
    const make = () => {
        const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { });
        init(mapper);
        mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg", model: "claude-sonnet-5", usage: {} } } });
        return mapper;
    };
    const block = make();
    assert.throws(() => block.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "future_block" } } }), /Unsupported Claude content block/);
    const delta = make();
    delta.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    assert.throws(() => delta.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "wrong" } } }), /did not match/);
    const unclosed = make();
    unclosed.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    assert.throws(() => unclosed.accept({ type: "result", is_error: false, result: "" }), /unclosed content blocks/);
    const stopped = make();
    stopped.accept({ type: "stream_event", event: { type: "message_stop" } });
    assert.throws(() => stopped.accept({ type: "stream_event", event: { type: "ping" } }), /after message_stop/);
});
test("rejects malformed results and accepts future stop reasons", () => {
    const make = () => {
        const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { });
        init(mapper);
        mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg", model: "claude-sonnet-5", usage: {} } } });
        return mapper;
    };
    assert.throws(() => make().accept({ type: "result", result: "missing flag" }), /boolean is_error/);
    assert.throws(
        () => make().accept({ type: "result", is_error: false, result: { forged: true } }),
        /non-string result field/,
    );
    for (const stopReason of ["future_reason", "model_context_window_exceeded", "pause_turn", "refusal"]) {
        assert.doesNotThrow(() => make().accept({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stopReason } } }));
    }
    const duplicate = make();
    duplicate.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    assert.throws(() => duplicate.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }), /Duplicate content block/);
    assert.throws(() => make().accept({ type: "stream_event", event: { type: "content_block_stop", index: 99 } }), /unknown content block/);
});
test("preserves result errors and accepts future result stop reasons", async () => {
    const successStream = createAssistantMessageEventStream();
    const successMapper = makeMapper(successStream, createOutput(model), new Set(), new Map(), () => { });
    init(successMapper);
    successMapper.accept({ type: "result", is_error: false, result: "declined", stop_reason: "refusal" });
    successMapper.completeResult();
    assert.equal((await successStream.result()).stopReason, "stop");

    const errorStream = createAssistantMessageEventStream();
    const errorMapper = makeMapper(errorStream, createOutput(model), new Set(), new Map(), () => { });
    init(errorMapper);
    errorMapper.accept({
        type: "result",
        is_error: true,
        api_error_status: 429,
        stop_reason: "model_context_window_exceeded",
        result: "actual API failure",
    });
    const error = await errorStream.result();
    assert.equal(error.stopReason, "error");
    assert.match(error.errorMessage ?? "", /429.*actual API failure/);
});
test("announces one validated response before publishing any content", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    assert.equal(output.stopReason, "pending");
    const observed = [];
    const mapper = makeMapper(stream, output, new Set(), new Map(), () => { }, () => { }, () => observed.push(`announced:${output.stopReason}`));
    const consume = (async () => {
        for await (const event of stream)
            observed.push(event.type);
    })();
    init(mapper);
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_announce", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    mapper.accept({ type: "result", is_error: false, result: "hi" });
    mapper.completeResult();
    await consume;
    // The announcement precedes start, and the partial it describes is still pending.
    assert.deepEqual(observed.slice(0, 2), ["announced:pending", "start"]);
    assert.equal(observed.filter((entry) => entry.startsWith("announced:")).length, 1);
    assert.equal(output.stopReason, "stop");
});
test("waits for an asynchronous response announcement before publishing start", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const observed = [];
    let releaseAnnouncement;
    const announcement = new Promise((resolve) => {
        releaseAnnouncement = resolve;
    });
    const mapper = makeMapper(
        stream,
        output,
        new Set(),
        new Map(),
        () => { },
        () => { },
        async () => {
            observed.push("announced");
            await announcement;
            observed.push("released");
        },
    );
    const consume = (async () => {
        for await (const event of stream)
            observed.push(event.type);
    })();
    init(mapper);
    assert.deepEqual(observed, ["announced"]);
    assert.throws(
        () => mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_pending", model: "claude-sonnet-5", usage: {} } } }),
        /before Pi response observers completed/,
    );
    releaseAnnouncement();
    await mapper.settleResponseAnnouncement();
    mapper.accept({ type: "result", is_error: false, result: "" });
    mapper.completeResult();
    await consume;
    assert.deepEqual(observed, ["announced", "released", "start", "done"]);
});
test("does not announce a response when initialization is rejected", () => {
    let announcements = 0;
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(["mcp__pi__calculate"]), new Map(), () => { }, () => { }, () => {
        announcements += 1;
    });
    assert.throws(() => mapper.accept(initRecord()));
    assert.equal(announcements, 0);
});
test("surfaces a throwing response announcement to the protocol caller", () => {
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { }, () => { }, () => {
        throw new Error("observer exploded");
    });
    assert.throws(() => init(mapper), /observer exploded/);
});
test("re-parses streamed tool-argument previews a bounded number of times", () => {
    let parsedLength = 0;
    let parses = 0;
    for (let received = 100; received <= 1_000_000; received += 100) {
        if (argumentPreviewDue(received, parsedLength)) {
            parses += 1;
            parsedLength = received;
        }
    }
    // Parsing on every delta would rescan a growing string 10,000 times.
    assert.ok(parses <= 60, `${parses} preview parses for 10,000 deltas`);
});
test("publishes a partial tool-argument preview before the call completes", () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(["mcp__pi__write"]), new Map([["mcp__pi__write", "write"]]), () => { });
    mapper.accept(initRecord(["mcp__pi__write"], [{ name: "pi", status: "connected" }]));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_preview", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_preview", name: "mcp__pi__write", input: {} } } });
    const content = "x".repeat(100);
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{"path":"notes.txt","content":"${content}` } } });
    assert.equal(output.content[0].arguments.path, "notes.txt");
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"}' } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    assert.deepEqual(output.content[0].arguments, { path: "notes.txt", content });
});
test("explains a cache-breakpoint limit rejection and names the escape hatch", async () => {
    const stream = createAssistantMessageEventStream();
    const mapper = makeMapper(stream, createOutput(model), new Set(), new Map(), () => { });
    init(mapper);
    mapper.accept({ type: "result", is_error: true, api_error_status: 400, result: "API Error: 400 A maximum of 4 blocks with cache_control may be provided. Found 5." });
    const result = await stream.result();
    assert.equal(mapper.cacheBreakpointLimit, true);
    assert.match(result.errorMessage ?? "", /A maximum of 4 blocks with cache_control.*PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off/);
    const unrelated = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { });
    init(unrelated);
    unrelated.accept({ type: "result", is_error: true, api_error_status: 429, result: "subscription limit reached" });
    assert.equal(unrelated.cacheBreakpointLimit, false);
});
test("discards an abandoned attempt after api_retry so the surviving stream can finish", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(), new Map(), () => { });
    const consume = (async () => {
        for await (const _event of stream) { /* drain */ }
    })();
    init(mapper);
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 10 } } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial that must not survive" } } });
    mapper.accept(retryRecord(1));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_2", model: "claude-sonnet-5", usage: { input_tokens: 10 } } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "surviving answer" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    mapper.accept({ type: "stream_event", event: { type: "message_stop" } });
    mapper.accept({ type: "result", is_error: false, result: "surviving answer" });
    assert.equal(mapper.hasSuccessfulResult, true);
    assert.equal(output.content.length, 1);
    assert.equal(output.content[0].text, "surviving answer");
    assert.equal(output.responseId, "msg_2");
    mapper.completeResult();
    await consume;
});
test("clears an unclosed tool_use block when Claude retries the stream", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(["mcp__pi__read"]), new Map([["mcp__pi__read", "read"]]), () => { });
    const consume = (async () => {
        for await (const _event of stream) { /* drain */ }
    })();
    mapper.accept(initRecord(["mcp__pi__read"], [{ name: "pi", status: "connected" }]));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_old", name: "mcp__pi__read", input: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pa' } } });
    mapper.accept(retryRecord(1));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_2", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answered without the tool" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    mapper.accept({ type: "stream_event", event: { type: "message_stop" } });
    mapper.accept({ type: "result", is_error: false, result: "answered without the tool" });
    assert.equal(mapper.hasSuccessfulResult, true);
    assert.equal(output.content.length, 1);
    assert.equal(output.content[0].type, "text");
    mapper.completeResult();
    await consume;
});
test("still rejects a duplicate message_start when Claude did not retry", () => {
    const mapper = makeMapper(createAssistantMessageEventStream(), createOutput(model), new Set(), new Map(), () => { });
    init(mapper);
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: {} } } });
    assert.throws(
        () => mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: {} } } }),
        /duplicate message_start/,
    );
});
test("accepts api_retry before any message_start", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(), new Map(), () => { });
    const consume = (async () => {
        for await (const _event of stream) { /* drain */ }
    })();
    init(mapper);
    mapper.accept(retryRecord(1));
    mapper.accept(retryRecord(2));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_3", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok after retries" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    mapper.accept({ type: "stream_event", event: { type: "message_stop" } });
    mapper.accept({ type: "result", is_error: false, result: "ok after retries" });
    assert.equal(mapper.hasSuccessfulResult, true);
    assert.equal(output.content[0].text, "ok after retries");
    mapper.completeResult();
    await consume;
});
test("keeps only the surviving attempt after consecutive api_retry records", async () => {
    const stream = createAssistantMessageEventStream();
    const output = createOutput(model);
    const mapper = makeMapper(stream, output, new Set(), new Map(), () => { });
    const consume = (async () => {
        for await (const _event of stream) { /* drain */ }
    })();
    init(mapper);
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_a", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "abandoned" } } });
    mapper.accept(retryRecord(1));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_b", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "also abandoned" } } });
    mapper.accept(retryRecord(2));
    mapper.accept({ type: "stream_event", event: { type: "message_start", message: { id: "msg_c", model: "claude-sonnet-5", usage: {} } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "kept" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "final answer" } } });
    mapper.accept({ type: "stream_event", event: { type: "content_block_stop", index: 1 } });
    mapper.accept({ type: "stream_event", event: { type: "message_stop" } });
    mapper.accept({ type: "result", is_error: false, result: "final answer" });
    assert.equal(mapper.hasSuccessfulResult, true);
    assert.equal(output.content.length, 2);
    assert.equal(output.content[0].thinking, "kept");
    assert.equal(output.content[1].text, "final answer");
    assert.equal(output.responseId, "msg_c");
    mapper.completeResult();
    await consume;
});
