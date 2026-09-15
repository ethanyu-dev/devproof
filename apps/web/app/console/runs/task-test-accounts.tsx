"use client";
import { useRef, useState } from "react";
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
        <b>准备测试账号</b>
        <Badge
          tone={preparation.missingCount || incomplete ? "warning" : "success"}
        >
          {preparation.missingCount
            ? `待补充 ${preparation.missingCount} 个`
            : incomplete
              ? "准备已结束，账号未齐"
              : preparation.totalCount
                ? "已分配"
                : "无需测试账号"}
        </Badge>
      </div>
      <div className="dp-task-form">
        <p className="text-sm text-muted-foreground">
          本任务需要 {preparation.totalCount}{" "}
          个业务测试账号。平台按下方用途自动分配；无需账号的 Case
          可以先执行。等待账号期间不消耗 Case
          执行预算。账号不可用导致无法验证时，将记录为无法判定。
        </p>
        {preparation.cases.map((c) => (
          <div
            key={c.caseExecutionId}
            className="grid gap-3 rounded-md border p-4"
          >
            <b>
              {c.caseName} · {c.deployment.name} · {c.slots.length} 个账号
            </b>
            <p className="text-sm text-muted-foreground">
              {c.deployment.targetUrl}
            </p>
            {c.slots.map((s) => (
              <Field
                key={s.slotId}
                label={s.label}
                description={`${s.usage === "READ_EXISTING" ? "只读使用" : "用于创建或修改"}。${s.rationale} ${s.requiredTypes.length ? `业务类型：${s.requiredTypes.join("、")}。` : ""}${s.constraints.join("；")}`}
              >
                <Input
                  aria-label={`${c.caseName} ${s.label}`}
                  value={
                    s.account ?? values[key(c.caseExecutionId, s.slotId)] ?? ""
                  }
                  disabled={busy || c.started || Boolean(s.account)}
                  onChange={(e) =>
                    edit({
                      ...values,
                      [key(c.caseExecutionId, s.slotId)]: e.target.value,
                    })
                  }
                />
              </Field>
            ))}
          </div>
        ))}
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
        )}
      </div>
    </Card>
  );
}
