import type { AssistantMessage, Context, Tool } from "@earendil-works/pi-ai";

export type ClaudeSubscriptionType = "pro" | "max" | "team" | "enterprise";

export interface ClaudeInstallation {
  executable: string;
  version: string;
  subscriptionType: ClaudeSubscriptionType;
}

export interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
}

export interface PreparedRequest {
  directory: string;
  transcriptBlocks: string[];
  attachmentPaths: string[];
  systemPromptPath: string;
  catalogPath?: string;
  violationPath?: string;
  readyPath?: string;
  bunConfigPath?: string;
  toolNames: Map<string, string>;
  transcriptBytes: number;
  catalogBytes: number;
  imageBytes: number;
}

export interface RequestMetrics {
  schemaVersion: 4;
  timestamp: string;
  platform: NodeJS.Platform;
  architecture: string;
  nodeVersion: string;
  claudeVersion: string;
  requestedModel: string;
  resolvedModel?: string;
  effort: string;
  messageCount: number;
  toolCount: number;
  imageCount: number;
  transcriptBytes: number;
  catalogBytes: number;
  imageBytes: number;
  estimatedInputTokens: number;
  servedContextWindow?: number;
  servedMaxOutputTokens?: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitPercent?: number;
  inputTokens: number;
  outputTokens: number;
  durationMs?: number;
  lastPhase: string;
  cleanupComplete: boolean;
  stopReason?: string;
  errorCategory?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  terminationExpected: boolean;
}

export interface SearchMetrics {
  schemaVersion: 1;
  timestamp: string;
  platform: NodeJS.Platform;
  architecture: string;
  nodeVersion: string;
  claudeVersion: string;
  requestBytes: number;
  capturedBytes: number;
  resultBytes: number;
  durationMs: number;
  lastPhase: string;
  initialized: boolean;
  cleanupComplete: boolean;
  errorCategory?: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
}

export interface LogicalProviderPayload {
  systemPrompt?: string;
  messages: Context["messages"];
  tools?: Tool[];
}

export interface MutableOutput extends AssistantMessage {
  content: AssistantMessage["content"];
}
