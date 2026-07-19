import { JsonlParser } from "../../src/jsonl.ts";
import { terminateProcessGroup } from "../../src/process-utils.ts";

export function superviseLiveProcess(child, { timeoutMs, label }) {
  let timedOut = false;
  let terminationPromise;
  const terminate = () => {
    terminationPromise ??= terminateProcessGroup(child);
    return terminationPromise;
  };
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate().catch(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
  }, timeoutMs);

  return {
    terminate,
    async wait() {
      try {
        const outcome = await result;
        if (timedOut) throw new Error(`${label} exceeded ${timeoutMs}ms`);
        return outcome;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function closeLiveRpcProcess(child, supervisor, closed, graceMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    const result = await closed;
    return { result, graceful: result.code === 0 && result.signal === null };
  }

  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    await supervisor.terminate();
    return { result: await closed, graceful: false };
  }

  // RPC stdin EOF is Pi's cross-platform graceful-shutdown path. Keep a no-op
  // error listener until close so a concurrent child exit cannot surface EPIPE.
  const ignoreStdinError = () => {};
  stdin.on("error", ignoreStdinError);
  stdin.end();

  let timer;
  try {
    const outcome = await Promise.race([
      closed.then((result) => ({ result, graceful: true })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs);
      }),
    ]);
    if (outcome) return outcome;
    await supervisor.terminate();
    return { result: await closed, graceful: false };
  } finally {
    if (timer) clearTimeout(timer);
    stdin.removeListener("error", ignoreStdinError);
  }
}

export function consumeJsonl(stream, onValue, onError) {
  const parser = new JsonlParser(onValue);
  let failed = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    onError(error instanceof Error ? error : new Error(String(error)));
  };
  stream.on("data", (chunk) => {
    if (failed) return;
    try {
      parser.push(chunk);
    } catch (error) {
      fail(error);
    }
  });
  stream.on("end", () => {
    if (failed) return;
    try {
      parser.end();
    } catch (error) {
      fail(error);
    }
  });
}
