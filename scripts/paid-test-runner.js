import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { inspectClaudeInstallation } from "../src/auth.ts";
import { PAID_LAUNCH_BUDGET_ENV } from "../src/paid-launch-budget.ts";
import { PI_BIN_ENV, describePiLaunch, piBinOverride } from "./lib/pi-installation.js";
import {
  PAID_CONFIRMATION,
  PAID_CONFIRMATION_ENV,
  requirePaidConfirmation,
} from "./lib/paid-confirmation.js";

const root = fileURLToPath(new URL("..", import.meta.url));

const stages = {
  smoke: { label: "smoke", cap: 1, script: "live-test.js", args: [] },
  // Pi ships as an npm package and as a compiled standalone binary, and the
  // proposal bridge is spawned differently on each. Both lanes are required.
  bridge: { label: "npm bridge", cap: 1, script: "live-test.js", args: ["--bridge"] },
  "bridge-standalone": {
    label: "standalone bridge",
    cap: 1,
    script: "live-test.js",
    args: ["--bridge"],
    requiresPiBin: true,
  },
  full: { label: "full live", cap: 28, script: "live-test.js", args: ["--full"] },
  "post-tools": { label: "post-tool live", cap: 6, script: "live-test.js", args: ["--post-tools"] },
  cache: { label: "cache", cap: 3, script: "live-test.js", args: ["--cache"] },
  // Fable 5 availability and included quota vary by subscription tier, so its
  // one-launch case is opt-in and excluded from the blocking gate.
  fable: { label: "fable model", cap: 1, script: "model-matrix.js", args: ["--case", "fable:medium"] },
  opus: { label: "opus model", cap: 1, script: "model-matrix.js", args: ["--case", "opus:medium"] },
  matrix: { label: "model matrix", cap: 20, script: "model-matrix.js", args: [] },
};

const selected = process.argv[2];
const releaseOrder = ["full", "cache", "bridge", "bridge-standalone", "matrix"];
const selectedStages = selected === "release" ? releaseOrder : [selected];
if (!selected || selectedStages.some((name) => !(name in stages))) {
  throw new Error(`Usage: node scripts/paid-test-runner.js <${[...Object.keys(stages), "release"].join("|")}>`);
}

const planned = selectedStages.map((name) => stages[name]);
const missingPiBin = planned.filter((stage) => stage.requiresPiBin && !piBinOverride());
if (missingPiBin.length) {
  throw new Error(
    `The ${missingPiBin.map((stage) => stage.label).join(" and ")} stage runs against a standalone Pi, so ` +
    `${PI_BIN_ENV} must point at an extracted tar.gz pi executable (for example ${PI_BIN_ENV}=~/pi-0.84.2/pi).`,
  );
}
const totalCap = planned.reduce((total, stage) => total + stage.cap, 0);
const installation = await inspectClaudeInstallation();

console.error("This command uses the live Claude Code subscription authenticated on this machine.");
console.error(`Detected subscription class: ${installation.subscriptionType}.`);
console.error(`Stages: ${planned.map((stage) => `${stage.label} (up to ${stage.cap})`).join(", ")}.`);
console.error(`Default Pi distribution: ${describePiLaunch()}.`);
console.error(`Aggregate maximum: ${totalCap} Claude launches. No automatic retries are performed.`);
console.error("An atomic budget slot is claimed before every provider or web-search Claude launch.");
console.error("These launches consume PAID account quota. If usage credits are enabled, they may incur additional spend.");

let readline;
const confirmationMode = await requirePaidConfirmation({
  environment: process.env,
  interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  async ask(phrase) {
    readline = createInterface({ input: process.stdin, output: process.stderr });
    return readline.question(`Type ${phrase} to continue: `);
  },
}).finally(() => readline?.close());
if (confirmationMode === "environment") {
  console.error(`Proceeding because ${PAID_CONFIRMATION_ENV}=1.`);
} else {
  console.error(`Accepted exact confirmation: ${PAID_CONFIRMATION}.`);
}

const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-paid-"));
const metricsLog = join(directory, "metrics.jsonl");
const aggregateBudgetDirectory = join(directory, "aggregate-budget");
await mkdir(aggregateBudgetDirectory);
let observed = 0;

try {
  for (const [stageIndex, stage] of planned.entries()) {
    const stageBudgetDirectory = join(directory, `stage-${stageIndex + 1}-budget`);
    await mkdir(stageBudgetDirectory);
    const before = await metricCount(metricsLog);
    await run(stage.script, stage.args, {
      ...process.env,
      // Lanes are explicit: an ambient override must not silently redirect the
      // npm lane, and the standalone lane must not fall back to the npm entry.
      ...(stage.requiresPiBin ? {} : { [PI_BIN_ENV]: "" }),
      [PAID_LAUNCH_BUDGET_ENV.child]: "1",
      [PAID_LAUNCH_BUDGET_ENV.stageDirectory]: stageBudgetDirectory,
      [PAID_LAUNCH_BUDGET_ENV.stageCap]: String(stage.cap),
      [PAID_LAUNCH_BUDGET_ENV.aggregateDirectory]: aggregateBudgetDirectory,
      [PAID_LAUNCH_BUDGET_ENV.aggregateCap]: String(totalCap),
      PI_CLAUDE_CODE_PROVIDER_METRICS_LOG: metricsLog,
    });
    const after = await metricCount(metricsLog);
    const stageObserved = after - before;
    const stageClaimed = await claimCount(stageBudgetDirectory);
    const aggregateClaimed = await claimCount(aggregateBudgetDirectory);
    observed += stageObserved;
    if (stageClaimed > stage.cap || aggregateClaimed > totalCap) {
      throw new Error("Paid launch budget invariant failed after a stage completed");
    }
    if (stageObserved !== stageClaimed || observed !== aggregateClaimed) {
      throw new Error(
        `${stage.label} launch accounting mismatch: ${stageClaimed} claimed, ${stageObserved} metrics; ` +
        `${aggregateClaimed} aggregate claims, ${observed} metrics`,
      );
    }
    console.error(`Paid usage: ${stage.label} recorded ${stageObserved}/${stage.cap}; aggregate ${observed}/${totalCap}.`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function claimCount(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith(".claim")).length;
}

async function metricCount(path) {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts", script), ...args], {
      cwd: root,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`${script} exited with code ${String(code)}, signal ${String(signal)}`));
    });
  });
}
