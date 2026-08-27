import type { Metadata } from "next";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Bot,
  Cable,
  CircleCheck,
  FileSearch,
  MonitorUp,
  Pause,
  Play,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "平台指南" };

const setupSteps = [
  {
    description: "注册至少一个 Browser Runtime，并确认当前可调度容量。",
    href: "/console/access",
    icon: MonitorUp,
    label: "配置执行节点",
  },
  {
    description: "添加 Agent 模型，列表顺序会决定故障下沉优先级。",
    href: "/console/access",
    icon: Bot,
    label: "配置模型",
  },
  {
    description: "签发 MCP Token，让 Codex 或其他 Agent 提交任务。",
    href: "/console/access",
    icon: Cable,
    label: "连接任务入口",
  },
] as const;

const flow = [
  {
    copy: "接收 Issue、目标与验收标准",
    icon: FileSearch,
    label: "任务入口",
  },
  {
    copy: "分析上下文并生成可执行 Case",
    icon: Bot,
    label: "Agent Runtime",
  },
  {
    copy: "在隔离浏览器中执行并采集证据",
    icon: MonitorUp,
    label: "执行节点",
  },
  {
    copy: "聚合判定、截图与操作回放",
    icon: CircleCheck,
    label: "结果与证据",
  },
] as const;

const handoffSteps = [
  { copy: "保留浏览器会话与身份租约", icon: Pause, title: "任务暂停" },
  {
    copy: "敏感输入不进入提示词和制品",
    icon: UserRound,
    title: "成员接管",
  },
  {
    copy: "使用新的租约恢复同一次任务",
    icon: Play,
    title: "继续执行",
  },
] as const;

export default function ConsoleIndexPage() {
  return (
    <div>
      <PageHeader
        actions={
          <Button asChild>
            <Link href="/console/access">
              开始配置 <ArrowRight />
            </Link>
          </Button>
        }
        description="管理员快速了解 DevProof 的任务闭环，并完成首次接入。"
        title="平台指南"
      />

      <section className="grid gap-4 lg:grid-cols-4">
        {flow.map((item, index) => {
          const Icon = item.icon;
          return (
            <Card className="relative overflow-hidden" key={item.label}>
              <CardHeader>
                <div className="mb-3 flex items-center justify-between">
                  <span className="grid size-9 place-items-center rounded-lg bg-primary/8 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    0{index + 1}
                  </span>
                </div>
                <CardTitle className="text-sm">{item.label}</CardTitle>
                <CardDescription>{item.copy}</CardDescription>
              </CardHeader>
              {index < flow.length - 1 ? (
                <ArrowRight className="absolute -right-2 top-1/2 z-10 hidden size-4 -translate-y-1/2 text-muted-foreground lg:block" />
              ) : null}
            </Card>
          );
        })}
      </section>

      <section className="mt-8 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-4">
              <div>
                <CardTitle>首次配置</CardTitle>
                <CardDescription className="mt-1.5">
                  完成三项配置后即可从 Agent 或试验场提交真实任务。
                </CardDescription>
              </div>
              <Badge variant="secondary">3 个步骤</Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3">
            {setupSteps.map((step, index) => {
              const Icon = step.icon;
              return (
                <Link
                  className="group flex items-center gap-4 rounded-xl border border-border/80 p-4 transition-colors hover:bg-muted/60"
                  href={step.href}
                  key={step.label}
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground group-hover:bg-primary/8 group-hover:text-primary">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-sm font-medium">
                      {index + 1}. {step.label}
                    </strong>
                    <small className="mt-1 block text-sm leading-5 text-muted-foreground">
                      {step.description}
                    </small>
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              );
            })}
          </CardContent>
        </Card>

        <Card className="bg-primary text-primary-foreground">
          <CardHeader>
            <span className="mb-4 grid size-10 place-items-center rounded-xl bg-white/10">
              <ShieldCheck className="size-5" />
            </span>
            <CardTitle>人工接管不会创建新会话</CardTitle>
            <CardDescription className="text-primary-foreground/65">
              登录、验证码与 MFA 都在原任务的浏览器页面中完成，恢复后 Agent
              会从同一个检查点继续。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2">
              {handoffSteps.map(({ copy, icon: Icon, title }) => (
                <div
                  className="flex items-start gap-3 rounded-lg bg-white/[0.06] p-3"
                  key={title}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-indigo-200" />
                  <span>
                    <b className="block text-xs font-medium">{title}</b>
                    <small className="mt-0.5 block text-xs leading-5 text-primary-foreground/60">
                      {copy}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>

      <Card className="mt-5">
        <CardContent className="flex flex-col items-start justify-between gap-4 pt-0 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-emerald-50 text-emerald-700">
              <Activity className="size-4" />
            </span>
            <span>
              <strong className="block text-sm font-medium">
                准备验证配置？
              </strong>
              <small className="mt-0.5 block text-sm text-muted-foreground">
                在任务试验场提交一个最小任务，确认整条链路是否可用。
              </small>
            </span>
          </div>
          <Button asChild variant="outline">
            <Link href="/console/playground">打开任务试验场</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
