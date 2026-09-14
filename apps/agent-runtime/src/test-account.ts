import { businessTestAccountSchema } from "@devproof/agent-runtime-protocol";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
/** Only use explicitly labelled test subjects, never arbitrary numbers in a page. */
export function taskTestAccount(goal: string, policy: Record<string, unknown>) {
  if (object(object(policy.resume).context).usage === "READ_EXISTING")
    return undefined;
  const resume = object(object(policy.resume).response);
  const saved = object(policy.executionState);
  const explicit = businessTestAccountSchema.safeParse(
    resume.account ?? saved.account,
  );
  if (explicit.success) return explicit.data;
  if (!/(?:创建|新增|修改|编辑|删除|禁用|启用|POST|PUT)/u.test(goal))
    return undefined;
  const match = goal.match(
    /(?:目标用户账号|测试账号|用户账号|账号)[：:]?\s*[`「"']?([a-z\d][a-z\d._@+:-]{0,199})/iu,
  );
  const parsed = businessTestAccountSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : undefined;
}
