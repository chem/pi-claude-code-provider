import assert from "node:assert/strict";
import { access, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupStaleRuntimeDirectories,
  createRuntimeDirectory,
  recordRuntimeChild,
} from "../../src/runtime-directories.ts";

const HOUR = 60 * 60_000;

test("creates private marked runtime directories and records the child process", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-directory-test-"));
  const createdAt = Date.now() - 2 * HOUR;
  try {
    const directory = await createRuntimeDirectory("provider_request", {
      temporaryRoot: root,
      ownerPid: 101,
      now: createdAt,
    });
    assert.match(directory, /pi-claude-code-provider-request-/);
    if (process.platform !== "win32") assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    const markerName = (await readdir(directory)).find((name) => name.startsWith(".pi-claude-code-provider-runtime"));
    assert.ok(markerName);
    const markerPath = join(directory, markerName);
    if (process.platform !== "win32") assert.equal((await lstat(markerPath)).mode & 0o777, 0o600);
    await recordRuntimeChild(directory, 202);
    assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
      schema: "pi-claude-code-provider-runtime-v1",
      kind: "provider_request",
      ownerPid: 101,
      childPid: 202,
      createdAt: new Date(createdAt).toISOString(),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes only old runtime directories whose recorded processes are gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-cleanup-test-"));
  const now = Date.now();
  try {
    const stale = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 301, now: now - 2 * HOUR });
    // The web_search_output prefix nests inside the web_search_request prefix,
    // so this directory is only reclaimed when its kind is resolved by the
    // longest matching prefix rather than the first one.
    const staleOutput = await createRuntimeDirectory("web_search_output", { temporaryRoot: root, ownerPid: 306, now: now - 2 * HOUR });
    const activeOwner = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 302, now: now - 2 * HOUR });
    const activeChild = await createRuntimeDirectory("web_search_request", { temporaryRoot: root, ownerPid: 303, now: now - 2 * HOUR });
    await recordRuntimeChild(activeChild, 304);
    const young = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 305, now });
    const removed = await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid: (await lstat(root)).uid,
      now,
      processAlive: (pid) => pid === 302 || pid === 304,
    });
    assert.deepEqual(removed, { removed: 2, failures: 0 });
    await assert.rejects(access(stale));
    await assert.rejects(access(staleOutput));
    await Promise.all([activeOwner, activeChild, young].map((directory) => access(directory)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves unowned, unmarked, diagnostic, symlinked, and out-of-budget candidates untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-cleanup-safety-test-"));
  const now = Date.now();
  try {
    const valid = await createRuntimeDirectory("provider_request", { temporaryRoot: root, ownerPid: 401, now: now - 2 * HOUR });
    const unmarked = await mkdtemp(join(root, "pi-claude-code-provider-request-"));
    const malformed = await mkdtemp(join(root, "pi-claude-code-provider-request-"));
    await writeFile(join(malformed, ".pi-claude-code-provider-runtime.json"), "not json\n", { mode: 0o600 });
    const diagnostic = await mkdtemp(join(root, "pi-claude-code-provider-diagnostics-"));
    const outside = await mkdtemp(join(root, "outside-"));
    const linked = join(root, "pi-claude-code-provider-request-linked");
    await symlink(outside, linked, process.platform === "win32" ? "junction" : undefined);
    const currentUid = (await lstat(root)).uid;
    assert.deepEqual(await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid: currentUid + 1,
      now,
      processAlive: () => false,
    }), { removed: 0, failures: 0 });
    assert.deepEqual(await cleanupStaleRuntimeDirectories({
      temporaryRoot: root,
      currentUid,
      now,
      maxCandidates: 0,
      processAlive: () => false,
    }), { removed: 0, failures: 0 });
    await Promise.all([valid, unmarked, malformed, diagnostic, outside, linked].map((directory) => access(directory)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a content-free aggregate when the temporary root cannot be scanned", async () => {
  const missing = join(tmpdir(), `pi-runtime-missing-${process.pid}-${Date.now()}`);
  assert.deepEqual(await cleanupStaleRuntimeDirectories({
    temporaryRoot: missing,
    currentUid: 0,
  }), { removed: 0, failures: 1 });
});
