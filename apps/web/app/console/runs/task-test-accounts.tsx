"use client";
import { useRef, useState } from "react";
import { CheckCircle2, ChevronRight } from "lucide-react";
import type {
  TaskTestAccountsInput,
  TestAccountRequirement,
} from "@devproof/contracts";
import { taskTestAccountsInputSchema } from "@devproof/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import styles from "./task-test-accounts.module.css";

export interface TaskAccountPreparation {
  revision: string;
  missingCount: number;
  totalCount: number;
  cases: Array<{
    caseExecutionId: string;
    caseName: string;
    started: boolean;
    deployment: { name: string; targetUrl: string };
    slots: Array<
      TestAccountRequirement & { slotId: string; account: string | null }
    >;
  }>;
}
export function TaskTestAccountsCard({
  preparation,
  busy,
  onSubmit,
}: {
  preparation: TaskAccountPreparation;
  busy: boolean;
  onSubmit: (input: TaskTestAccountsInput) => Promise<unknown>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const submissionId = useRef<string | null>(null);
  const incomplete = preparation.cases.some((c) =>
    c.slots.some((s) => !s.account),
  );
  const accountCases = preparation.cases.filter((c) => c.slots.length > 0);
  const accountFreeCases = preparation.cases.filter((c) => !c.slots.length);
  const assignedCount = preparation.cases.reduce(
    (count, c) => count + c.slots.filter((s) => s.account).length,
    0,
  );
  const pending = preparation.cases.flatMap((c) =>
    c.started
      ? []
      : c.slots
          .filter((s) => !s.account)
          .map((s) => ({ ...s, caseExecutionId: c.caseExecutionId })),
  );
  const key = (id: string, slot: string) => `${id}/${slot}`;
  const edit = (next: Record<string, string>) => {
    submissionId.current = null;
    setValues(next);
  };
  async function submit() {
    submissionId.current ??= crypto.randomUUID();
    const input = taskTestAccountsInputSchema.safeParse({
      submissionId: submissionId.current,
      expectedRevision: preparation.revision,
      assignments: pending
        .filter((s) => values[key(s.caseExecutionId, s.slotId)]?.trim())
        .map((s) => ({
          caseExecutionId: s.caseExecutionId,
          slotId: s.slotId,
          account: values[key(s.caseExecutionId, s.slotId)]!.trim(),
        })),
    });
    if (!input.success) {
      setError("请填写有效账号标识，操作说明不要填入账号字段。");
      return;
    }
    setError(null);
    try {
      await onSubmit(input.data);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Card className="dp-task-input-card">
      <div className="dp-section-head">
        <b>{pending.length ? "准备测试账号" : "测试账号"}</b>
        <Badge
          tone={preparation.missingCount || incomplete ? "warning" : "success"}
        >
          {preparation.missingCount
            ? `待补充 ${preparation.missingCount} 个`
            : incomplete
              ? "准备已结束，账号未齐"
              : preparation.totalCount
                ? `已分配 ${assignedCount}/${preparation.totalCount}`
                : "无需测试账号"}
        </Badge>
      </div>
      <div className={styles.body}>
        {preparation.totalCount > 0 && (
          <p className={styles.overview}>
            {accountCases.length} 个用例需要 {preparation.totalCount}{" "}
            个业务测试账号
            {pending.length > 0
              ? "，填写后将按下方用途分配。"
              : incomplete
                ? `，已分配 ${assignedCount} 个。`
                : "，已全部分配。"}
          </p>
        )}
        {accountCases.map((c) => (
          <section key={c.caseExecutionId} className={styles.case}>
            <div className={styles.caseHeading}>
              <h3>{c.caseName}</h3>
              <span>{c.slots.length} 个账号</span>
            </div>
            <p className={styles.environment}>
              <span>
                {c.deployment.name === "Default"
                  ? "默认环境"
                  : c.deployment.name}
              </span>
              <span>{c.deployment.targetUrl}</span>
            </p>
            {c.slots.map((s) => (
              <div key={s.slotId} className={styles.slot}>
                {s.account ? (
                  <div className={styles.assignment}>
                    <div>
                      <span className={styles.label}>{s.label}</span>
                      <code className={styles.account}>{s.account}</code>
                    </div>
                    <span className={styles.assigned}>
                      <CheckCircle2 size={14} aria-hidden="true" /> 已分配
                    </span>
                  </div>
                ) : (
                  <Field label={s.label}>
                    <Input
                      aria-label={`${c.caseName} ${s.label}`}
                      placeholder="填写手机号、邮箱或用户 ID"
                      value={values[key(c.caseExecutionId, s.slotId)] ?? ""}
                      disabled={busy || c.started}
                      onChange={(e) =>
                        edit({
                          ...values,
                          [key(c.caseExecutionId, s.slotId)]: e.target.value,
                        })
                      }
                    />
                  </Field>
                )}
                <details className={styles.details} open={!s.account}>
                  <summary>
                    <ChevronRight size={14} aria-hidden="true" />
                    使用条件
                    <span>
                      {s.usage === "READ_EXISTING" ? "只读使用" : "创建或修改"}
                    </span>
                  </summary>
                  <dl className={styles.requirements}>
                    <div>
                      <dt>账号用途</dt>
                      <dd>{s.rationale}</dd>
                    </div>
                    {s.requiredTypes.length > 0 && (
                      <div>
                        <dt>业务类型</dt>
                        <dd className={styles.types}>
                          {s.requiredTypes.map((type, i) => (
                            <code key={`${type}/${i}`}>{type}</code>
                          ))}
                        </dd>
                      </div>
                    )}
                    {s.constraints.length > 0 && (
                      <div>
                        <dt>前置条件</dt>
                        <dd>
                          <ul>
                            {s.constraints.map((constraint, i) => (
                              <li key={i}>{constraint}</li>
                            ))}
                          </ul>
                        </dd>
                      </div>
                    )}
                  </dl>
                </details>
              </div>
            ))}
          </section>
        ))}
        {accountFreeCases.length > 0 && (
          <details className={`${styles.details} ${styles.accountFree}`}>
            <summary>
              <ChevronRight size={14} aria-hidden="true" />
              {accountFreeCases.length} 个用例无需业务测试账号
            </summary>
            <ul>
              {accountFreeCases.map((c) => (
                <li key={c.caseExecutionId}>
                  {c.caseName}
                  <span>
                    {c.deployment.name === "Default"
                      ? "默认环境"
                      : c.deployment.name}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {pending.length > 1 && (
          <Field
            label="批量填入（每行一个账号）"
            description="按上方待填用途顺序填入，请核对分配后提交。不同环境或前置条件的账号请分别检查。"
          >
            <Textarea
              aria-label="批量填入测试账号"
              disabled={busy}
              onChange={(e) => {
                const lines = e.target.value
                  .split(/\r?\n/u)
                  .map((s) => s.trim())
                  .filter(Boolean);
                edit(
                  Object.fromEntries(
                    pending.map((s, i) => [
                      key(s.caseExecutionId, s.slotId),
                      lines[i] ?? "",
                    ]),
                  ),
                );
                setError(
                  lines.length > pending.length
                    ? `只需要补充 ${pending.length} 个账号，多余账号未使用。`
                    : null,
                );
              }}
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {pending.length > 0 && (
          <div className={styles.actions}>
            <p>
              等待账号期间暂停对应用例的执行预算，其他用例可先执行。
              账号不满足条件时，受影响的验收项将记录为无法判定。
            </p>
            <Button
              disabled={
                busy ||
                !pending.some((s) =>
                  values[key(s.caseExecutionId, s.slotId)]?.trim(),
                )
              }
              onClick={() => void submit()}
            >
              提交账号并继续执行
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
