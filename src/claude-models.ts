import { open, stat } from "node:fs/promises";
import type { ClaudeInstallation } from "./types.ts";

/**
 * Report which concrete model each picker alias would be served, by reading the
 * alias table embedded in the Claude Code executable.
 *
 * This is an undocumented internal, and a deliberate, scoped exception to this
 * project's rule of consuming only published interfaces. It is the only
 * zero-cost source that can report all four aliases: `system/init` resolves them
 * but is unreachable without a billed turn, and a model that is never served is
 * never observed, so Fable could not be reported on a Pro account at all.
 *
 * It is diagnostic only. Nothing outside the doctor may read this, and it must
 * never influence routing: the serving path stays alias-only, which is what
 * makes a wrong answer here harmless. Every failure mode degrades to
 * "unavailable" rather than reporting a version it is not sure of.
 */
export const MODEL_ALIASES = ["sonnet", "fable", "opus", "haiku"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];
export type ModelAliasVersions = Partial<Record<ModelAlias, string>>;

// Only `default:` can apply here. src/auth.ts rejects anything that is not
// firstParty, so reading a per-provider override would report a model this
// extension can never serve.
const ALIAS_PATTERN = /\b(sonnet|opus|haiku|fable):\{default:"([A-Za-z0-9._-]{1,64})"/g;
const CHUNK_BYTES = 1024 * 1024;
// A match cannot span more than this, so carrying it between chunks is enough.
const OVERLAP_BYTES = 128;
const SCAN_TIMEOUT_MS = 10_000;

let cache: { key: string; versions: ModelAliasVersions } | undefined;

export async function readClaudeModelAliases(
  installation: ClaudeInstallation,
  timeoutMs = SCAN_TIMEOUT_MS,
): Promise<ModelAliasVersions> {
  const path = installation.executable;
  let key: string;
  try {
    const info = await stat(path);
    key = `${path}:${info.size}:${info.mtimeMs}`;
  } catch {
    return {};
  }
  if (cache?.key === key) return cache.versions;
  const versions = await scan(path, timeoutMs);
  cache = { key, versions };
  return versions;
}

async function scan(path: string, timeoutMs: number): Promise<ModelAliasVersions> {
  const deadline = Date.now() + timeoutMs;
  const found = new Map<string, Set<string>>();
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return {};
  }
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let tail = "";
    for (;;) {
      if (Date.now() > deadline) return {};
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      // latin1 maps every byte to one character, so offsets stay meaningful in
      // a binary and no byte sequence can decode into a spurious match.
      const text = tail + buffer.subarray(0, bytesRead).toString("latin1");
      for (const match of text.matchAll(ALIAS_PATTERN)) {
        const alias = match[1];
        const model = match[2];
        if (alias === undefined || model === undefined) continue;
        const values = found.get(alias) ?? new Set<string>();
        values.add(model);
        found.set(alias, values);
      }
      tail = text.slice(-OVERLAP_BYTES);
    }
  } catch {
    return {};
  } finally {
    await handle.close().catch(() => undefined);
  }
  const versions: ModelAliasVersions = {};
  for (const alias of MODEL_ALIASES) {
    const values = found.get(alias);
    // Every version tested yielded exactly one value per alias. More than one
    // means the shape changed, and guessing would report a wrong version
    // confidently, which is worse than reporting nothing.
    if (values?.size === 1) versions[alias] = [...values][0];
  }
  return versions;
}

/** Reset the scan cache. Exported for tests, which reuse one executable path. */
export function clearModelAliasCache(): void {
  cache = undefined;
}
