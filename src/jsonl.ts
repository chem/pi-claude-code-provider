import { StringDecoder } from "node:string_decoder";
import { ClaudeCodeError } from "./errors.ts";

export const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

/** Strict JSONL framing: LF only, with one optional CR before LF. */
export class JsonlParser {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private readonly onValue: (value: unknown) => void;
  private readonly maxRecordBytes: number;

  constructor(onValue: (value: unknown) => void, maxRecordBytes = DEFAULT_MAX_RECORD_BYTES) {
    this.onValue = onValue;
    this.maxRecordBytes = maxRecordBytes;
  }

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    this.drain(false);
  }

  end(): void {
    this.buffer += this.decoder.end();
    this.drain(true);
  }

  private drain(final: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.parse(line);
    }
    if (Buffer.byteLength(this.buffer) > this.maxRecordBytes) {
      throw new ClaudeCodeError("protocol_record_too_large", "Claude Code emitted an oversized JSONL record");
    }
    if (final && this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      this.parse(line);
    }
  }

  private parse(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > this.maxRecordBytes) {
      throw new ClaudeCodeError("protocol_record_too_large", "Claude Code emitted an oversized JSONL record");
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new ClaudeCodeError("protocol_invalid_json", "Claude Code emitted malformed JSONL");
    }
    this.onValue(value);
  }
}
