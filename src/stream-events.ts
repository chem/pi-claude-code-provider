import type { AssistantMessageEventStream, ToolCall } from "@earendil-works/pi-ai";
import { ClaudeCodeError } from "./errors.ts";
import type { MutableOutput } from "./types.ts";

interface StreamEventEnvelope {
  type?: string;
  subtype?: string;
  event?: Record<string, unknown>;
  result?: string | null;
  errors?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, Record<string, unknown>>;
  is_error?: boolean;
  api_error_status?: number | null;
  stop_reason?: string | null;
  terminal_reason?: string | null;
  tools?: unknown;
  mcp_servers?: unknown;
  model?: string;
  permissionMode?: string;
  slash_commands?: unknown;
  skills?: unknown;
  plugins?: unknown;
  apiKeySource?: string;
  rate_limit_info?: unknown;
}

export interface ClaudeInitializationExpectation {
  tools: ReadonlySet<string>;
  mcpServer: "none" | "pi";
}

export interface RateLimitNotice {
  status: "allowed_warning" | "rejected";
  rateLimitType: string;
  /** Raw Claude Code utilization is a fraction from 0 through 1, not a percentage. */
  utilization?: number;
  /** Reset values are normalized from raw Claude Code Unix seconds to JavaScript milliseconds. */
  resetsAt?: number;
  overageStatus?: "allowed_warning" | "rejected";
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export type RateLimitNoticeSink = (notice: RateLimitNotice) => void;

interface IndexedBlock {
  // The map key is Claude's source index; contentIndex identifies the matching
  // position in output.content so mixed responses update the correct Pi block.
  contentIndex: number;
  partialJson?: string;
}

const EPOCH_MILLISECONDS_THRESHOLD = 100_000_000_000;

export type ClaudeTerminationCause = "none" | "tool_handoff" | "caller_abort";

export class ClaudeEventMapper {
  private readonly blocks = new Map<number, IndexedBlock>();
  private initialized = false;
  private messageStarted = false;
  private messageStopped = false;
  private terminal = false;
  private resultReceived = false;
  private successfulResult: "stop" | "length" | undefined;
  private stopReason: string | undefined;
  private rejectedRateLimit: string | undefined;
  private servedContextWindow: number | undefined;
  private servedMaxOutputTokens: number | undefined;
  private readonly stream: AssistantMessageEventStream;
  private readonly output: MutableOutput;
  private readonly expectedTools: Set<string>;
  private readonly toolNames: Map<string, string>;
  private readonly onToolUse: () => void;
  private readonly onRateLimitNotice: RateLimitNoticeSink;
  private readonly emittedRateLimitNotices = new Set<string>();
  private assistantDiagnostic: string | undefined;

  constructor(
    stream: AssistantMessageEventStream,
    output: MutableOutput,
    expectedTools: Set<string>,
    toolNames: Map<string, string>,
    onToolUse: () => void,
    onRateLimitNotice: RateLimitNoticeSink = () => {},
  ) {
    this.stream = stream;
    this.output = output;
    this.expectedTools = expectedTools;
    this.toolNames = toolNames;
    this.onToolUse = onToolUse;
    this.onRateLimitNotice = onRateLimitNotice;
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  get hasSuccessfulResult(): boolean {
    return this.successfulResult !== undefined;
  }

  get contextWindow(): number | undefined {
    return this.servedContextWindow;
  }

  get maxOutputTokens(): number | undefined {
    return this.servedMaxOutputTokens;
  }

  get rateLimitFailure(): string | undefined {
    return this.rejectedRateLimit;
  }

  accept(value: unknown, terminationCause: ClaudeTerminationCause = "none"): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ClaudeCodeError("protocol_shape", "Invalid Claude event record");
    }
    const record = value as StreamEventEnvelope;
    if (record.type === "system" && record.subtype === "init") {
      this.validateInit(record);
      return;
    }
    if (!this.initialized) throw new ClaudeCodeError("protocol_order", "Claude emitted a record before initialization");
    if (this.resultReceived) throw new ClaudeCodeError("protocol_order", "Claude emitted a record after its result");
    if (record.type === "stream_event") {
      if (!record.event || typeof record.event !== "object") {
        throw new ClaudeCodeError("protocol_shape", "Claude stream_event did not contain an event");
      }
      this.acceptStreamEvent(record.event);
    } else if (record.type === "result") {
      this.acceptResult(record, terminationCause);
    } else if (record.type === "rate_limit_event") {
      this.acceptRateLimit(record.rate_limit_info);
    } else if (record.type === "assistant") {
      this.acceptAssistant(record);
    } else if (record.type === "user" || record.type === "system") {
      // Completed user echoes and non-init system status records are redundant
      // because include-partial-messages supplies the canonical stream events.
    } else {
      throw new ClaudeCodeError("protocol_record", `Unsupported Claude record type: ${String(record.type)}`);
    }
  }

  fail(message: string, aborted = false): void {
    if (this.terminal) return;
    this.terminal = true;
    this.output.stopReason = aborted ? "aborted" : "error";
    this.output.errorMessage = message;
    this.stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
    this.stream.end();
  }

  private validateInit(record: StreamEventEnvelope): void {
    if (this.initialized) throw new ClaudeCodeError("protocol_init", "Claude emitted duplicate initialization");
    this.output.responseModel = validateClaudeInitialization(record, {
      tools: this.expectedTools,
      mcpServer: this.expectedTools.size === 0 ? "none" : "pi",
    });
    this.initialized = true;
    this.stream.push({ type: "start", partial: this.output });
  }

  private acceptStreamEvent(event: Record<string, unknown>): void {
    const type = event.type;
    if (type === "message_start") {
      if (this.messageStarted) throw new ClaudeCodeError("protocol_message", "Claude emitted duplicate message_start");
      const message = object(event.message, "message_start.message");
      if (typeof message.model === "string") this.output.responseModel = message.model;
      if (typeof message.id === "string") this.output.responseId = message.id;
      this.applyUsage(message.usage);
      this.messageStarted = true;
      return;
    }
    if (this.messageStopped) throw new ClaudeCodeError("protocol_order", `${String(type)} arrived after message_stop`);
    if (type === "ping") return;
    if (!this.messageStarted) throw new ClaudeCodeError("protocol_order", `${String(type)} arrived before message_start`);
    if (type === "content_block_start") this.startBlock(event);
    else if (type === "content_block_delta") this.deltaBlock(event);
    else if (type === "content_block_stop") this.endBlock(event);
    else if (type === "message_delta") this.acceptMessageDelta(event);
    else if (type === "message_stop") {
      if (this.blocks.size > 0) throw new ClaudeCodeError("protocol_blocks", "Claude stopped with unclosed content blocks");
      this.messageStopped = true;
      if (this.stopReason === "tool_use") this.onToolUse();
    } else throw new ClaudeCodeError("protocol_event", `Unsupported Claude stream event: ${String(type)}`);
  }

  private acceptMessageDelta(event: Record<string, unknown>): void {
    const delta = object(event.delta, "message_delta.delta");
    if (delta.stop_reason !== null && delta.stop_reason !== undefined) {
      this.stopReason = stopReason(delta.stop_reason);
    }
    this.applyUsage(event.usage);
    if (this.stopReason === "tool_use") this.onToolUse();
  }

  private startBlock(event: Record<string, unknown>): void {
    const sourceIndex = index(event.index);
    if (this.blocks.has(sourceIndex)) throw new ClaudeCodeError("protocol_blocks", `Duplicate content block index ${sourceIndex}`);
    const source = object(event.content_block, "content_block_start.content_block");
    const contentIndex = this.output.content.length;
    this.blocks.set(sourceIndex, { contentIndex, partialJson: "" });
    if (source.type === "text") {
      this.output.content.push({ type: "text", text: typeof source.text === "string" ? source.text : "" });
      this.stream.push({ type: "text_start", contentIndex, partial: this.output });
    } else if (source.type === "thinking") {
      this.output.content.push({
        type: "thinking",
        thinking: typeof source.thinking === "string" ? source.thinking : "",
        thinkingSignature: typeof source.signature === "string" ? source.signature : undefined,
      });
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    } else if (source.type === "redacted_thinking") {
      if (typeof source.data !== "string" || source.data.length === 0) {
        this.blocks.delete(sourceIndex);
        throw new ClaudeCodeError("protocol_block", "Claude emitted redacted thinking without opaque data");
      }
      this.output.content.push({
        type: "thinking",
        thinking: "",
        thinkingSignature: source.data,
        redacted: true,
      });
      this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
    } else if (source.type === "tool_use") {
      const qualifiedName = typeof source.name === "string" ? source.name : "";
      const name = this.toolNames.get(qualifiedName);
      if (!name) throw new ClaudeCodeError("tool_unknown", `Claude proposed an unknown tool: ${qualifiedName}`);
      if (typeof source.id !== "string" || source.id.length === 0) throw new ClaudeCodeError("tool_id", "Claude emitted a tool without an ID");
      const initial = source.input && typeof source.input === "object" && !Array.isArray(source.input)
        ? source.input as Record<string, unknown>
        : {};
      this.output.content.push({ type: "toolCall", id: source.id, name, arguments: initial });
      this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
    } else {
      this.blocks.delete(sourceIndex);
      throw new ClaudeCodeError("protocol_block", `Unsupported Claude content block: ${String(source.type)}`);
    }
  }

  private deltaBlock(event: Record<string, unknown>): void {
    const sourceIndex = index(event.index);
    const indexed = this.blocks.get(sourceIndex);
    if (!indexed) throw new ClaudeCodeError("protocol_blocks", `Delta for unknown content block ${sourceIndex}`);
    const delta = object(event.delta, "content_block_delta.delta");
    const block = this.output.content[indexed.contentIndex];
    if (delta.type === "text_delta" && block?.type === "text" && typeof delta.text === "string") {
      block.text += delta.text;
      this.stream.push({ type: "text_delta", contentIndex: indexed.contentIndex, delta: delta.text, partial: this.output });
    } else if (delta.type === "thinking_delta" && block?.type === "thinking" && typeof delta.thinking === "string") {
      block.thinking += delta.thinking;
      this.stream.push({ type: "thinking_delta", contentIndex: indexed.contentIndex, delta: delta.thinking, partial: this.output });
    } else if (delta.type === "signature_delta" && block?.type === "thinking" && typeof delta.signature === "string") {
      block.thinkingSignature = `${block.thinkingSignature ?? ""}${delta.signature}`;
    } else if (delta.type === "input_json_delta" && block?.type === "toolCall" && typeof delta.partial_json === "string") {
      indexed.partialJson = `${indexed.partialJson ?? ""}${delta.partial_json}`;
      try {
        block.arguments = JSON.parse(indexed.partialJson) as Record<string, unknown>;
      } catch {
        // Partial JSON is expected until content_block_stop.
      }
      this.stream.push({ type: "toolcall_delta", contentIndex: indexed.contentIndex, delta: delta.partial_json, partial: this.output });
    } else {
      throw new ClaudeCodeError("protocol_delta", `Delta ${String(delta.type)} did not match its content block`);
    }
  }

  private endBlock(event: Record<string, unknown>): void {
    const sourceIndex = index(event.index);
    const indexed = this.blocks.get(sourceIndex);
    if (!indexed) throw new ClaudeCodeError("protocol_blocks", `Stop for unknown content block ${sourceIndex}`);
    const block = this.output.content[indexed.contentIndex];
    if (block?.type === "text") {
      this.stream.push({ type: "text_end", contentIndex: indexed.contentIndex, content: block.text, partial: this.output });
    } else if (block?.type === "thinking") {
      this.stream.push({ type: "thinking_end", contentIndex: indexed.contentIndex, content: block.thinking, partial: this.output });
    } else if (block?.type === "toolCall") {
      if (indexed.partialJson) {
        try {
          const parsed = JSON.parse(indexed.partialJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          block.arguments = parsed as Record<string, unknown>;
        } catch {
          throw new ClaudeCodeError("tool_arguments", `Claude emitted invalid arguments for tool ${block.name}`);
        }
      }
      this.stream.push({ type: "toolcall_end", contentIndex: indexed.contentIndex, toolCall: block as ToolCall, partial: this.output });
    } else throw new ClaudeCodeError("protocol_blocks", `Missing output block for source index ${sourceIndex}`);
    this.blocks.delete(sourceIndex);
  }

  private acceptResult(record: StreamEventEnvelope, terminationCause: ClaudeTerminationCause): void {
    if (this.terminal) return;
    if (this.blocks.size > 0) throw new ClaudeCodeError("protocol_blocks", "Claude result arrived with unclosed content blocks");
    // Stream envelopes are untrusted JSON despite the TypeScript interface.
    // Validate terminal fields before they can cross into Pi's typed output.
    if (typeof record.is_error !== "boolean") {
      throw new ClaudeCodeError("protocol_result", "Claude result omitted a boolean is_error field");
    }
    if (record.result !== undefined && record.result !== null && typeof record.result !== "string") {
      throw new ClaudeCodeError("protocol_result", "Claude result contained a non-string result field");
    }
    this.resultReceived = true;
    this.applyUsage(record.usage);
    this.applyModelUsage(record.modelUsage);
    if (record.is_error) {
      if (this.isExpectedToolTermination(record, terminationCause)) return;
      const status = typeof record.api_error_status === "number" && Number.isFinite(record.api_error_status)
        ? ` (${record.api_error_status})`
        : "";
      this.fail(`Claude Code request failed${status}: ${resultErrorDetail(record, this.assistantDiagnostic, this.rejectedRateLimit)}`);
      return;
    }
    if (record.stop_reason !== null && record.stop_reason !== undefined && this.stopReason === undefined) {
      this.stopReason = stopReason(record.stop_reason);
    }
    // Claude result envelopes make success explicit. Do not infer it from an
    // absent flag or subtype string, which could hide protocol drift.
    if (this.stopReason === "tool_use") throw new ClaudeCodeError("protocol_result", "Claude returned success after a tool-use stop");
    if (this.output.content.length === 0 && record.result) this.pushFallbackText(record.result);
    this.successfulResult = this.stopReason === "max_tokens" ? "length" : "stop";
    this.output.stopReason = this.successfulResult;
  }

  /** Publish a validated result only after the provider has settled and cleaned its process state. */
  completeResult(): boolean {
    if (this.terminal) return false;
    if (!this.successfulResult) throw new ClaudeCodeError("protocol_result", "Claude result was not ready for completion");
    this.terminal = true;
    this.stream.push({ type: "done", reason: this.successfulResult, message: this.output });
    this.stream.end();
    return true;
  }

  completeToolUse(): boolean {
    if (this.terminal) return false;
    if (this.blocks.size > 0) throw new ClaudeCodeError("protocol_blocks", "Tool use completed with unclosed content blocks");
    if (!this.output.content.some((block) => block.type === "toolCall")) {
      throw new ClaudeCodeError("protocol_tool", "Claude reported tool use without a tool call");
    }
    this.terminal = true;
    this.output.stopReason = "toolUse";
    this.stream.push({ type: "done", reason: "toolUse", message: this.output });
    this.stream.end();
    return true;
  }

  private isExpectedToolTermination(record: StreamEventEnvelope, terminationCause: ClaudeTerminationCause): boolean {
    return terminationCause === "tool_handoff" &&
      this.stopReason === "tool_use" &&
      this.output.content.some((block) => block.type === "toolCall") &&
      record.subtype === "error_during_execution" &&
      record.is_error === true &&
      record.api_error_status === undefined &&
      record.stop_reason === "tool_use" &&
      record.terminal_reason === "aborted_streaming" &&
      record.result === undefined;
  }

  private pushFallbackText(text: string): void {
    const contentIndex = this.output.content.length;
    this.output.content.push({ type: "text", text });
    this.stream.push({ type: "text_start", contentIndex, partial: this.output });
    this.stream.push({ type: "text_delta", contentIndex, delta: text, partial: this.output });
    this.stream.push({ type: "text_end", contentIndex, content: text, partial: this.output });
  }

  private acceptAssistant(record: StreamEventEnvelope): void {
    if (this.assistantDiagnostic !== undefined) return;
    const raw = record as Record<string, unknown>;
    const error = typeof raw.error === "string" ? raw.error.trim() : "";
    const message = raw.message && typeof raw.message === "object" && !Array.isArray(raw.message)
      ? raw.message as Record<string, unknown>
      : undefined;
    const content = message?.content;
    const text = typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
          .filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object" && !Array.isArray(block))
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => (block.text as string).trim())
          .filter(Boolean)
          .join(" ")
        : "";
    const diagnostic = [error, text].filter(Boolean).join(": ");
    if (diagnostic) this.assistantDiagnostic = diagnostic;
  }

  private acceptRateLimit(info: unknown): void {
    const notice = parseRateLimitNotice(info);
    if (!notice) return;
    const noticeKey = JSON.stringify(notice);
    if (!this.emittedRateLimitNotices.has(noticeKey)) {
      this.emittedRateLimitNotices.add(noticeKey);
      try {
        this.onRateLimitNotice(notice);
      } catch {
        // UI notifications are advisory and must never fail a provider request.
      }
    }
    if (notice.status === "rejected") {
      const reset = notice.resetsAt === undefined ? "" : `; resets at ${new Date(notice.resetsAt).toISOString()}`;
      const reason = notice.overageDisabledReason === undefined ? "" : `; ${notice.overageDisabledReason}`;
      this.rejectedRateLimit = `Claude rate limit rejected (${notice.rateLimitType})${reason}${reset}`;
    }
  }

  private applyModelUsage(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const entries = Object.values(value as Record<string, unknown>);
    for (const raw of entries) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const usage = raw as Record<string, unknown>;
      this.servedContextWindow ??= number(usage.contextWindow);
      this.servedMaxOutputTokens ??= number(usage.maxOutputTokens);
    }
  }

  private applyUsage(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const usage = value as Record<string, unknown>;
    const input = number(usage.input_tokens);
    const output = number(usage.output_tokens);
    const cacheRead = number(usage.cache_read_input_tokens);
    const cacheWrite = number(usage.cache_creation_input_tokens);
    if (input !== undefined) this.output.usage.input = input;
    if (output !== undefined) this.output.usage.output = output;
    if (cacheRead !== undefined) this.output.usage.cacheRead = cacheRead;
    if (cacheWrite !== undefined) this.output.usage.cacheWrite = cacheWrite;
    const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
    const reasoning = number(outputDetails?.thinking_tokens);
    if (reasoning !== undefined) this.output.usage.reasoning = reasoning;
    const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined;
    const cacheWrite1h = number(cacheCreation?.ephemeral_1h_input_tokens);
    if (cacheWrite1h !== undefined) this.output.usage.cacheWrite1h = cacheWrite1h;
    this.output.usage.totalTokens =
      this.output.usage.input + this.output.usage.output + this.output.usage.cacheRead + this.output.usage.cacheWrite;
  }
}

function validTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // The raw `claude -p` protocol follows the SDK contract's Unix timestamp
  // convention (seconds). Keep JavaScript-facing notices in milliseconds, but
  // avoid double-converting a plausible epoch-millisecond value from a future
  // CLI version or intermediary.
  const milliseconds = value >= EPOCH_MILLISECONDS_THRESHOLD ? value : value * 1000;
  return !Number.isSafeInteger(milliseconds) || Number.isNaN(new Date(milliseconds).getTime())
    ? undefined
    : milliseconds;
}

function validUtilization(value: unknown): number | undefined {
  // Keep the wire value fractional; convert it to a percentage only when rendering the notice.
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

export function parseRateLimitNotice(info: unknown): RateLimitNotice | undefined {
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    // Rate-limit events are advisory. Ignore a malformed payload so it cannot
    // turn an otherwise valid provider or web-search request into a failure.
    return undefined;
  }
  const rate = info as Record<string, unknown>;
  const primaryStatus = alertStatus(rate.status);
  const overageStatus = alertStatus(rate.overageStatus);
  if (!primaryStatus && !overageStatus) return undefined;
  const status = primaryStatus === "rejected" || overageStatus === "rejected" ? "rejected" : "allowed_warning";
  const hasPrimaryAlert = primaryStatus !== undefined;
  const rejectedOverage = overageStatus === "rejected" && primaryStatus !== "rejected";
  const rateLimitType = hasPrimaryAlert
    ? rejectedOverage
      ? "overage"
      : typeof rate.rateLimitType === "string" && rate.rateLimitType.trim() ? rate.rateLimitType.trim() : "unknown"
    : "overage";
  const overageReset = validTimestamp(rate.overageResetsAt);
  const resetsAt = validTimestamp(rejectedOverage
    ? rate.overageResetsAt
    : hasPrimaryAlert
      ? rate.resetsAt
      : rate.overageResetsAt);
  const utilization = validUtilization(rate.utilization);
  const reason = typeof rate.overageDisabledReason === "string" && rate.overageDisabledReason.trim()
    ? rate.overageDisabledReason.trim()
    : undefined;
  return {
    status,
    rateLimitType,
    ...(hasPrimaryAlert && !rejectedOverage && utilization !== undefined ? { utilization } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(overageStatus === undefined ? {} : { overageStatus }),
    ...(hasPrimaryAlert && overageReset !== undefined ? { overageResetsAt: overageReset } : {}),
    ...(reason === undefined ? {} : { overageDisabledReason: reason }),
    ...(typeof rate.isUsingOverage === "boolean" ? { isUsingOverage: rate.isUsingOverage } : {}),
  };
}

function alertStatus(value: unknown): RateLimitNotice["status"] | undefined {
  return value === "allowed_warning" || value === "rejected" ? value : undefined;
}

function stopReason(value: unknown): string {
  // Claude exposes this as a string rather than a closed enum. Pi only gives
  // special meaning to max_tokens and tool_use, so preserve future values as
  // ordinary stops instead of rejecting an otherwise valid response.
  if (typeof value !== "string" || value.length === 0) {
    throw new ClaudeCodeError("protocol_stop", `Invalid Claude stop reason: ${String(value)}`);
  }
  return value;
}

function resultErrorDetail(
  record: StreamEventEnvelope,
  assistantDiagnostic: string | undefined,
  rateLimitFailure: string | undefined,
): string {
  const result = typeof record.result === "string" && record.result.trim() ? record.result.trim() : undefined;
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((error): error is string => typeof error === "string" && Boolean(error.trim())).join("; ")
    : "";
  const terminal = typeof record.terminal_reason === "string" && record.terminal_reason.trim()
    ? record.terminal_reason.trim()
    : undefined;
  return result ?? assistantDiagnostic ?? (errors || undefined) ?? terminal ?? rateLimitFailure ?? "unknown error";
}

export function validateClaudeInitialization(
  value: unknown,
  expectation: ClaudeInitializationExpectation,
): string {
  const record = object(value, "Claude initialization");
  if (record.type !== "system" || record.subtype !== "init") {
    throw new ClaudeCodeError("protocol_init", "Claude initialization record was invalid");
  }
  if (!Array.isArray(record.tools)) throw new ClaudeCodeError("protocol_init", "Claude initialization omitted tools");
  const toolValues = record.tools;
  if (toolValues.some((tool) => typeof tool !== "string")) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization contained an invalid tool name");
  }
  const tools = new Set(toolValues as string[]);
  if (
    tools.size !== toolValues.length ||
    tools.size !== expectation.tools.size ||
    [...tools].some((tool) => !expectation.tools.has(tool))
  ) {
    throw new ClaudeCodeError(
      "isolation_tools",
      `Claude Code initialized with an unexpected tool set (expected: ${formatNames(expectation.tools)}; observed: ${formatNames(tools)})`,
    );
  }
  if (record.permissionMode !== "dontAsk") {
    throw new ClaudeCodeError("isolation_permissions", "Claude Code did not enter dontAsk permission mode");
  }
  if (!Array.isArray(record.slash_commands) || !Array.isArray(record.skills) || !Array.isArray(record.plugins)) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization omitted customization inventories");
  }
  if (record.slash_commands.length > 0 || record.skills.length > 0 || record.plugins.length > 0) {
    throw new ClaudeCodeError("isolation_customizations", "Claude Code loaded unexpected customizations");
  }
  if (record.apiKeySource !== "none") {
    throw new ClaudeCodeError("isolation_auth", "Claude Code did not confirm subscription-backed authentication");
  }
  if (!Array.isArray(record.mcp_servers)) throw new ClaudeCodeError("protocol_init", "Claude initialization omitted MCP inventory");
  const servers = record.mcp_servers as Array<{ name?: unknown; status?: unknown }>;
  if (expectation.mcpServer === "none") {
    if (servers.length > 0) throw new ClaudeCodeError("isolation_mcp", "Claude Code loaded an unexpected MCP server");
  } else if (servers.length !== 1 || servers[0]?.name !== "pi" || servers[0]?.status !== "connected") {
    throw new ClaudeCodeError("isolation_mcp", "The Pi proposal MCP server did not initialize correctly");
  }
  if (typeof record.model !== "string" || record.model.length === 0) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization omitted the resolved model");
  }
  return record.model;
}

function formatNames(names: ReadonlySet<string>): string {
  return [...names].sort().join(", ") || "none";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function index(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ClaudeCodeError("protocol_index", `Invalid Claude content index: ${String(value)}`);
  }
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeCodeError("protocol_shape", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
