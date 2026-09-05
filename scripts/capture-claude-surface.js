// Capture Claude Code's help output verbatim so capability tests run against a
// document the CLI really produces. A hand-written fixture drifts silently and
// invents spellings the CLI has never emitted, which is how a load-bearing
// special case ended up in preflight.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claudeExecutable } from "../src/auth.ts";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = join(root, "test", "support", "captured");
const executable = claudeExecutable();

const [{ stdout: versionOutput }, { stdout: help }] = await Promise.all([
  execFileAsync(executable, ["--version"], { timeout: 10_000, maxBuffer: 1024 * 1024 }),
  execFileAsync(executable, ["--help"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }),
]);

// Take the version from the binary rather than an argument, so an artifact can
// never claim a version it was not produced by.
const version = versionOutput.trim().match(/\d+\.\d+\.\d+/)?.[0];
if (!version) throw new Error(`Could not determine the Claude Code version from: ${versionOutput.trim()}`);
if (!help.includes("--print")) throw new Error("Captured help does not look like Claude Code's help output");

await mkdir(directory, { recursive: true });
const path = join(directory, `claude-${version}-help.txt`);
await writeFile(path, help);
console.log(`Captured ${Buffer.byteLength(help)} bytes of ${executable} --help (${version}) to ${relative(root, path)}`);
console.log("Point CAPTURED_CLAUDE_VERSION in test/support/claude-fixture.js at this version to pin it.");
