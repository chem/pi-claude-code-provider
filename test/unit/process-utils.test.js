import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { superviseProcess, terminateProcessGroup } from "../../src/process-utils.ts";

async function assertProcessGone(pid) {
    await assert.rejects(async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                process.kill(pid, 0);
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            catch {
                throw new Error("gone");
            }
        }
    }, /gone/);
}

test("supervisor terminates a process that exceeds its total deadline", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let failure;
    const supervisor = superviseProcess(child, { idleTimeoutMs: 1000, totalTimeoutMs: 30, onFailure(error) { failure = error; } });
    const result = await supervisor.wait();
    supervisor.dispose();
    assert.match(failure?.message, /exceeded 30ms/);
    if (process.platform === "win32") assert.deepEqual(result, { code: 1, signal: null });
    else assert.notEqual(result.signal, null);
});
test("supervisor terminates a process that exceeds its idle deadline", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let failure;
    const supervisor = superviseProcess(child, { idleTimeoutMs: 30, totalTimeoutMs: 1000, onFailure(error) { failure = error; } });
    await supervisor.wait();
    supervisor.dispose();
    assert.match(failure?.message, /no protocol activity for 30ms/);
});
test("supervisor reports only the first pipe failure", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const failures = [];
    const supervisor = superviseProcess(child, { idleTimeoutMs: 1000, totalTimeoutMs: 1000, onFailure(error) { failures.push(error.message); } });
    child.stdin.emit("error", new Error("EPIPE"));
    child.stdout.emit("error", new Error("secondary"));
    await supervisor.wait();
    supervisor.dispose();
    assert.deepEqual(failures, ["Claude Code stdin failed: EPIPE"]);
});
test("Windows termination removes only the exact owned process tree", { skip: process.platform !== "win32" }, async () => {
    const body = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(String(child.pid)+"\\n"); setInterval(()=>{},1000);`;
    const target = spawn(process.execPath, ["-e", body], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    try {
        const descendantPid = await new Promise((resolve) => target.stdout.once("data", (chunk) => resolve(Number(chunk.toString().trim()))));
        await terminateProcessGroup(target);
        await assertProcessGone(descendantPid);
        assert.deepEqual({ code: target.exitCode, signal: target.signalCode }, { code: 1, signal: null });
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    }
    finally {
        await terminateProcessGroup(target);
        await terminateProcessGroup(unrelated);
    }
});
test("process-group termination removes a descendant", { skip: process.platform === "win32" }, async () => {
    const body = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); process.stdout.write(String(child.pid)+"\\n"); setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["-e", body], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const pid = await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(Number(chunk.toString().trim()))));
    await terminateProcessGroup(parent);
    await assertProcessGone(pid);
});
test("process-group termination removes a descendant after its leader exits", { skip: process.platform === "win32" }, async () => {
    const body = `const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); child.unref(); process.stdout.write(String(child.pid)+"\\n");`;
    const parent = spawn(process.execPath, ["-e", body], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const pid = await new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(Number(chunk.toString().trim()))));
    await new Promise((resolve) => parent.once("close", resolve));
    await terminateProcessGroup(parent);
    await assertProcessGone(pid);
});
test("supervisor termination is idempotent", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const supervisor = superviseProcess(child, { idleTimeoutMs: 1000, totalTimeoutMs: 1000, onFailure() { } });
    const first = supervisor.terminate();
    assert.equal(supervisor.terminate(), first);
    await first;
    await supervisor.wait();
    supervisor.dispose();
});
