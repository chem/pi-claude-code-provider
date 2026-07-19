import { open } from "node:fs/promises";
import { join } from "node:path";

export const PAID_LAUNCH_BUDGET_ENV = Object.freeze({
  child: "PI_CLAUDE_CODE_PROVIDER_PAID_TEST_CHILD",
  stageDirectory: "PI_CLAUDE_CODE_PROVIDER_PAID_STAGE_BUDGET_DIRECTORY",
  stageCap: "PI_CLAUDE_CODE_PROVIDER_PAID_STAGE_LAUNCH_CAP",
  aggregateDirectory: "PI_CLAUDE_CODE_PROVIDER_PAID_AGGREGATE_BUDGET_DIRECTORY",
  aggregateCap: "PI_CLAUDE_CODE_PROVIDER_PAID_AGGREGATE_LAUNCH_CAP",
});

interface LaunchBudget {
  directory: string;
  cap: number;
  label: string;
}

/**
 * Claim test-harness budget before starting a paid Claude process.
 * Production requests are unaffected because only the guarded paid runner sets
 * the child marker and private budget directories.
 */
export async function claimPaidTestLaunch(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (environment[PAID_LAUNCH_BUDGET_ENV.child] !== "1") return;

  const stage = budgetFromEnvironment(
    environment,
    PAID_LAUNCH_BUDGET_ENV.stageDirectory,
    PAID_LAUNCH_BUDGET_ENV.stageCap,
    "stage",
  );
  const aggregate = budgetFromEnvironment(
    environment,
    PAID_LAUNCH_BUDGET_ENV.aggregateDirectory,
    PAID_LAUNCH_BUDGET_ENV.aggregateCap,
    "aggregate",
  );

  // Atomic exclusive files make concurrent Pi processes compete for distinct
  // slots. Claiming the narrower stage first can only undercount availability
  // if the aggregate claim fails; it can never permit an extra paid launch.
  await claimSlot(stage);
  await claimSlot(aggregate);
}

function budgetFromEnvironment(
  environment: NodeJS.ProcessEnv,
  directoryName: string,
  capName: string,
  label: string,
): LaunchBudget {
  const directory = environment[directoryName]?.trim();
  const rawCap = environment[capName]?.trim();
  const cap = rawCap && /^\d+$/.test(rawCap) ? Number(rawCap) : Number.NaN;
  if (!directory || !Number.isSafeInteger(cap) || cap < 1 || cap > 1_000) {
    throw new Error(`Paid-test ${label} launch budget is missing or invalid`);
  }
  return { directory, cap, label };
}

async function claimSlot(budget: LaunchBudget): Promise<void> {
  for (let slot = 1; slot <= budget.cap; slot += 1) {
    const path = join(budget.directory, `${String(slot).padStart(4, "0")}.claim`);
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.chmod(0o600);
      } finally {
        await file.close();
      }
      return;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Paid-test ${budget.label} cap of ${budget.cap} launches is exhausted; refusing to start Claude`);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
