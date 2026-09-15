import { businessTestAccountSchema } from "@devproof/agent-runtime-protocol";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** Missing data can use HITL once; an unusable supplied account is a test outcome. */
export function hasProvidedTestAccount(policy: Record<string, unknown>) {
  const saved = object(policy.executionState);
  const response = object(object(policy.resume).response);
  const bindings = [policy.testAccounts, saved.accounts].flatMap((values) =>
    Array.isArray(values)
      ? values.map((binding) => object(binding).account)
      : [],
  );
  return [
    saved.account,
    response.account,
    ...Object.values(object(response.accounts)),
    ...bindings,
  ].some((value) => businessTestAccountSchema.safeParse(value).success);
}
/** Only use explicitly labelled test subjects, never arbitrary numbers in a page. */
export function taskTestAccount(goal: string, policy: Record<string, unknown>) {
  if (object(object(policy.resume).context).usage === "READ_EXISTING")
    return undefined;
  const resume = object(object(policy.resume).response);
  const saved = object(policy.executionState);
  if (Array.isArray(policy.testAccounts) && policy.testAccounts.length)
    return undefined;
  const explicit = businessTestAccountSchema.safeParse(
    resume.account ?? saved.account,
  );
  if (explicit.success) return explicit.data;
  return undefined;
}
