export const PAID_CONFIRMATION = "USE PAID CLAUDE QUOTA";
export const PAID_CONFIRMATION_ENV = "PI_CLAUDE_CODE_PROVIDER_CONFIRM_PAID_TESTS";

export async function requirePaidConfirmation({ environment, interactive, ask }) {
  if (environment[PAID_CONFIRMATION_ENV] === "1") return "environment";
  if (!interactive) throw new Error(`Noninteractive paid tests require ${PAID_CONFIRMATION_ENV}=1`);
  const answer = await ask(PAID_CONFIRMATION);
  if (answer !== PAID_CONFIRMATION) {
    throw new Error("Paid-test confirmation was not exact; nothing was run");
  }
  return "typed";
}
