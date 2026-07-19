import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PAID_CONFIRMATION,
  PAID_CONFIRMATION_ENV,
  requirePaidConfirmation,
} from "../../scripts/lib/paid-confirmation.js";
import { claimPaidTestLaunch, PAID_LAUNCH_BUDGET_ENV } from "../../src/paid-launch-budget.ts";

test("paid confirmation accepts only the exact typed phrase or explicit CI environment flag", async () => {
  await assert.rejects(
    requirePaidConfirmation({ environment: {}, interactive: false, ask: async () => PAID_CONFIRMATION }),
    new RegExp(`${PAID_CONFIRMATION_ENV}=1`),
  );
  await assert.rejects(
    requirePaidConfirmation({ environment: {}, interactive: true, ask: async () => PAID_CONFIRMATION.toLowerCase() }),
    /was not exact/,
  );
  assert.equal(
    await requirePaidConfirmation({ environment: {}, interactive: true, ask: async () => PAID_CONFIRMATION }),
    "typed",
  );
  assert.equal(
    await requirePaidConfirmation({ environment: { [PAID_CONFIRMATION_ENV]: "1" }, interactive: false, ask: async () => "" }),
    "environment",
  );
});

test("paid launch budgets fail closed before an extra Claude spawn", async () => {
  await assert.doesNotReject(claimPaidTestLaunch({}));
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-budget-"));
  const stageDirectory = join(directory, "stage");
  const aggregateDirectory = join(directory, "aggregate");
  await mkdir(stageDirectory);
  await mkdir(aggregateDirectory);
  const environment = {
    [PAID_LAUNCH_BUDGET_ENV.child]: "1",
    [PAID_LAUNCH_BUDGET_ENV.stageDirectory]: stageDirectory,
    [PAID_LAUNCH_BUDGET_ENV.stageCap]: "1",
    [PAID_LAUNCH_BUDGET_ENV.aggregateDirectory]: aggregateDirectory,
    [PAID_LAUNCH_BUDGET_ENV.aggregateCap]: "2",
  };
  try {
    await claimPaidTestLaunch(environment);
    assert.equal((await readdir(stageDirectory)).length, 1);
    assert.equal((await readdir(aggregateDirectory)).length, 1);
    await assert.rejects(claimPaidTestLaunch(environment), /stage cap of 1.*refusing to start Claude/);
    assert.equal((await readdir(aggregateDirectory)).length, 1);
    await assert.rejects(
      claimPaidTestLaunch({ [PAID_LAUNCH_BUDGET_ENV.child]: "1" }),
      /stage launch budget is missing or invalid/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
