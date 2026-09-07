"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import {
  runtimeRecoveryClosureStateSchema,
  runtimeRecoveryWriteOutcomeStateSchema,
  type RuntimeRecoveryPage,
  type RuntimeRecoverySummary,
} from "@devproof/contracts";
import { PageHeader } from "@/components/page-header";
import { EmptyState, LoadingState } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/native-select";
import { consoleApi } from "@/lib/api";
import { useRecoveryResource } from "./use-recovery-resource";
import {
  RecoveryBadges,
  RecoveryCard,
  RecoveryFeedback,
  recoveryDate,
  recoveryPath,
  runtimeRecoveryPath,
  useRecoveryAction,
} from "./recovery-ui";
import {
  recoveryClosureLabel,
  recoveryWriteLabel,
} from "./runtime-recovery-display";

type RuntimeOption = { id: string; name: string; drainState: string };

export function RuntimeRecoveryList() {
  const search = useSearchParams();
  const router = useRouter();
  const [sessionId, setSessionId] = useState("");
  const action = useRecoveryAction();
  const view = search.get("view") === "all" ? "all" : "pending";
  const state = search.get("state") ?? "";
  const writeState = search.get("writeState") ?? "";
  const runtimeId = search.get("runtimeId") ?? "";
  const cursor = search.get("cursor") ?? "";
  const previous = search.getAll("previous");
  const query = new URLSearchParams({ limit: "10", view });
  for (const [key, value] of Object.entries({
    state,
    writeState,
    runtimeId,
    cursor,
  }))
    if (value) query.set(key, value);
  const records = useRecoveryResource<RuntimeRecoveryPage>(
    `/runtime-recoveries?${query}`,
    action.busy,
  );
  const runtimes = useRecoveryResource<RuntimeOption[]>(
    "/browser-runtimes",
    action.busy,
  );

  function filter(key: string, value: string) {
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("cursor");
    next.delete("previous");
    router.replace(`${recoveryPath}?${next}`);
  }
  function paginate(forward: boolean) {
    const next = new URLSearchParams(search.toString());
    if (forward && records.data?.nextCursor) {
      next.append("previous", cursor);
      next.set("cursor", records.data.nextCursor);
    } else {
      const trail = [...previous];
      const prior = trail.pop();
      next.delete("previous");
      trail.forEach((id) => next.append("previous", id));
      if (prior) next.set("cursor", prior);
      else next.delete("cursor");
    }
    router.push(`${recoveryPath}?${next}`);
  }
  return (
    <div className="grid min-w-0 gap-4">
      <PageHeader
        title="会话恢复"
        description="分别跟踪浏览器关闭和业务写入结果，处理阻塞后续执行的异常会话。"
        actions={
          <>
            <Button asChild variant="secondary">
              <Link href="/console/access">
                <ArrowLeft />
                返回节点配置
              </Link>
            </Button>
            <Button
              variant="secondary"
              disabled={records.loading || action.busy}
              onClick={() => {
                void records.refresh();
                void runtimes.refresh();
              }}
            >
              <RefreshCw />
              刷新状态
            </Button>
          </>
        }
      />
      <RecoveryFeedback
        error={records.error ?? runtimes.error ?? action.error}
        notice={action.notice}
      />
      <RecoveryCard title="恢复记录">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="记录范围">
            <Select
              value={view}
              onChange={(event) => filter("view", event.target.value)}
            >
              <option value="pending">待处理</option>
              <option value="all">全部记录</option>
            </Select>
          </Field>
          <Field label="执行节点">
            <Select
              value={runtimeId}
              onChange={(event) => filter("runtimeId", event.target.value)}
            >
              <option value="">全部节点</option>
              {runtimes.data?.map((runtime) => (
                <option key={runtime.id} value={runtime.id}>
                  {runtime.name}
                </option>
              ))}
              {runtimeId &&
              !runtimes.data?.some((runtime) => runtime.id === runtimeId) ? (
                <option value={runtimeId}>
                  指定节点 {runtimeId.slice(0, 8)}
                </option>
              ) : null}
            </Select>
          </Field>
          <Field label="关闭进度">
            <Select
              value={state}
              onChange={(event) => filter("state", event.target.value)}
            >
              <option value="">全部关闭状态</option>
              {runtimeRecoveryClosureStateSchema.options.map((value) => (
                <option key={value} value={value}>
                  {recoveryClosureLabel(value)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="业务结果">
            <Select
              value={writeState}
              onChange={(event) => filter("writeState", event.target.value)}
            >
              <option value="">全部业务结果</option>
              {runtimeRecoveryWriteOutcomeStateSchema.options.map((value) => (
                <option key={value} value={value}>
                  {recoveryWriteLabel(value)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <p>
            {records.data
              ? `共 ${records.data.total} 条 · 每页 10 条`
              : "正在读取记录…"}
            {records.loading && records.data ? " · 更新中" : ""}
          </p>
          {runtimeId ? (
            <Button asChild variant="secondary">
              <Link href={runtimeRecoveryPath(runtimeId)}>
                查看节点排空与恢复
                <ArrowRight />
              </Link>
            </Button>
          ) : null}
        </div>
        {view === "pending" ? (
          <p className="text-xs text-muted-foreground">
            待处理包含关闭异常和关闭后仍待核实的业务结果；正常运行中的会话请在“全部记录”查看。
          </p>
        ) : null}
        {!records.data && records.loading ? <LoadingState /> : null}
        {records.data && !records.data.items.length ? (
          <EmptyState
            title="当前筛选下没有恢复记录"
            description={
              cursor
                ? "记录可能已处理完成，可以返回上一页或调整筛选。"
                : "可调整筛选，或在全部记录中查看历史处理结果。"
            }
          />
        ) : null}
        {records.data?.items.length ? (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-xs">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="p-3 font-medium">关联执行 / 会话</th>
                  <th className="p-3 font-medium">节点</th>
                  <th className="p-3 font-medium">恢复状态</th>
                  <th className="p-3 font-medium">最近变化</th>
                  <th className="p-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {records.data.items.map((item) => (
                  <tr className="border-b last:border-0" key={item.id}>
                    <td className="max-w-64 p-3">
                      <div
                        className="truncate font-medium"
                        title={item.sourceRunGoal ?? undefined}
                      >
                        {item.sourceRunId ? (
                          <Link
                            className="hover:underline"
                            href={`/console/executions/${item.sourceRunId}`}
                          >
                            {item.sourceRunGoal || "查看关联执行"}
                          </Link>
                        ) : (
                          "未关联执行记录"
                        )}
                      </div>
                      <code className="mt-1 block text-[10px] text-muted-foreground">
                        会话 {item.sessionId.slice(0, 8)}
                      </code>
                    </td>
                    <td className="max-w-44 p-3">
                      <Link
                        className="block truncate hover:underline"
                        href={runtimeRecoveryPath(item.runtimeId)}
                      >
                        {item.runtimeName ||
                          `节点 ${item.runtimeId.slice(0, 8)}`}
                      </Link>
                    </td>
                    <td className="p-3">
                      <RecoveryBadges item={item} />
                    </td>
                    <td className="whitespace-nowrap p-3 text-muted-foreground">
                      {recoveryDate(item.updatedAt)}
                    </td>
                    <td className="p-3">
                      <Button asChild variant="secondary">
                        <Link
                          href={`${recoveryPath}/${item.id}?list=${encodeURIComponent(search.toString())}`}
                        >
                          查看详情
                          <ArrowRight />
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            disabled={!cursor || records.loading}
            onClick={() => paginate(false)}
          >
            上一页
          </Button>
          <Button
            variant="secondary"
            disabled={!records.data?.nextCursor || records.loading}
            onClick={() => paginate(true)}
          >
            下一页
          </Button>
        </div>
      </RecoveryCard>
      <details className="rounded-lg border bg-card p-4 text-xs">
        <summary className="cursor-pointer font-medium">
          高级操作：按会话 ID 请求恢复
        </summary>
        <form
          className="mt-4 grid max-w-xl gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.act(async () => {
              const item = await consoleApi<RuntimeRecoverySummary>(
                `/runtime-sessions/${encodeURIComponent(sessionId.trim())}/recovery`,
                { method: "POST", body: "{}" },
              );
              router.push(`${recoveryPath}/${item.id}`);
            });
          }}
        >
          <Field
            label="完整会话 ID"
            description="请求恢复会记录并检查会话状态，不会终止仍合法运行的执行。"
          >
            <Input
              required
              pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
              maxLength={36}
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder="粘贴完整会话 UUID"
            />
          </Field>
          <div>
            <Button disabled={action.busy || !sessionId.trim()} type="submit">
              请求安全恢复
            </Button>
          </div>
        </form>
      </details>
    </div>
  );
}
