import { ClaudeCodeError } from "./errors.ts";

export interface ClaudeInitializationExpectation {
  tools: ReadonlySet<string>;
  mcpServer: "none" | "pi";
  privatePaths?: readonly string[];
}

export interface RateLimitNotice {
  status: "allowed_warning" | "rejected";
  rateLimitType: string;
  utilization?: number;
  resetsAt?: number;
  overageStatus?: "allowed_warning" | "rejected";
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export type RateLimitNoticeSink = (notice: RateLimitNotice) => void;

const EPOCH_MILLISECONDS_THRESHOLD = 100_000_000_000;

export function parseRateLimitNotice(info: unknown): RateLimitNotice | undefined {
  if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
  const rate = info as Record<string, unknown>;
  const primaryStatus = alertStatus(rate.status);
  const overageStatus = alertStatus(rate.overageStatus);
  const usingOverage = rate.isUsingOverage === true;
  const overageBlocking = overageStatus === "rejected" && (primaryStatus === "rejected" || usingOverage);
  if (!primaryStatus && !overageBlocking) return undefined;
  const status = primaryStatus === "rejected" || overageBlocking ? "rejected" : "allowed_warning";
  const hasPrimaryAlert = primaryStatus !== undefined;
  const overageRelevant = overageStatus !== undefined && (primaryStatus === "rejected" || usingOverage);
  const rateLimitType = hasPrimaryAlert
    ? typeof rate.rateLimitType === "string" && rate.rateLimitType.trim() ? rate.rateLimitType.trim() : "unknown"
    : "overage";
  const overageReset = validTimestamp(rate.overageResetsAt);
  const resetsAt = validTimestamp(hasPrimaryAlert ? rate.resetsAt : rate.overageResetsAt);
  const utilization = validUtilization(rate.utilization);
  const reason = typeof rate.overageDisabledReason === "string" && rate.overageDisabledReason.trim()
    ? rate.overageDisabledReason.trim()
    : undefined;
  return {
    status,
    rateLimitType,
    ...(hasPrimaryAlert && utilization !== undefined ? { utilization } : {}),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(overageRelevant ? { overageStatus } : {}),
    ...(overageRelevant && hasPrimaryAlert && overageReset !== undefined ? { overageResetsAt: overageReset } : {}),
    ...(overageRelevant && reason !== undefined ? { overageDisabledReason: reason } : {}),
    ...(usingOverage ? { isUsingOverage: true } : {}),
  };
}

export function terminalResultErrorDetail(
  record: Record<string, unknown>,
  assistantDiagnostic?: string,
  rateLimitFailure?: string,
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

export function validateClaudeInitialization(value: unknown, expectation: ClaudeInitializationExpectation): string {
  const record = object(value, "Claude initialization");
  if (record.type !== "system" || record.subtype !== "init") {
    throw new ClaudeCodeError("protocol_init", "Claude initialization record was invalid");
  }
  if (!Array.isArray(record.tools)) throw new ClaudeCodeError("protocol_init", "Claude initialization omitted tools");
  if (record.tools.some((tool) => typeof tool !== "string")) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization contained an invalid tool name");
  }
  const tools = new Set(record.tools as string[]);
  if (tools.size !== record.tools.length || tools.size !== expectation.tools.size || [...tools].some((tool) => !expectation.tools.has(tool))) {
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
  if (record.mcp_server_errors !== undefined) {
    if (!Array.isArray(record.mcp_server_errors)) {
      throw new ClaudeCodeError("protocol_init", "Claude initialization contained invalid MCP server errors");
    }
    const details = record.mcp_server_errors.map((value) => mcpErrorDetail(value, expectation.privatePaths ?? []));
    if (details.length > 0) {
      throw new ClaudeCodeError("isolation_mcp", `Claude Code reported MCP initialization errors: ${details.join("; ")}`);
    }
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

function mcpErrorDetail(value: unknown, privatePaths: readonly string[]): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization contained an invalid MCP server error");
  }
  const error = value as Record<string, unknown>;
  if (typeof error.type !== "string" || !error.type.trim() || typeof error.message !== "string" || !error.message.trim()) {
    throw new ClaudeCodeError("protocol_init", "Claude initialization contained an invalid MCP server error");
  }
  return `${safeDiagnostic(error.type, privatePaths, 64)}: ${safeDiagnostic(error.message, privatePaths, 512)}`;
}

function safeDiagnostic(value: string, privatePaths: readonly string[], limit: number): string {
  let safe = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  for (const path of [...privatePaths].sort((left, right) => right.length - left.length)) {
    if (path) safe = safe.split(path).join("<PRIVATE>");
  }
  return safe.slice(0, limit);
}

function validTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const milliseconds = value >= EPOCH_MILLISECONDS_THRESHOLD ? value : value * 1000;
  return !Number.isSafeInteger(milliseconds) || Number.isNaN(new Date(milliseconds).getTime()) ? undefined : milliseconds;
}

function validUtilization(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function alertStatus(value: unknown): RateLimitNotice["status"] | undefined {
  return value === "allowed_warning" || value === "rejected" ? value : undefined;
}

function formatNames(names: ReadonlySet<string>): string {
  return [...names].sort().join(", ") || "none";
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeCodeError("protocol_shape", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
