import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  CircleAlert,
  CircleHelp,
  Eye,
  FileCheck2,
  KeyRound,
  MonitorUp,
  Pause,
  Play,
  Route,
  Send,
  Settings2,
  ShieldCheck,
  UserRound,
} from "lucide-react";

import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "使用指南" };

const configSteps = [
  {
    detail: "运行一次性配对命令，让执行节点上线。",
    icon: MonitorUp,
    link: "/console/access#runtime",
    linkLabel: "注册执行节点",
    title: "接入执行节点",
  },
  {
    detail: "设置域名路由、不可用策略和人工接管开关。",
    icon: Settings2,
    link: "/console/access#runtime",
    linkLabel: "配置策略",
    title: "设置执行策略",
  },
  {
    detail: "分别创建 Agent Token 与 runtime:lease Token。",
    icon: KeyRound,
    link: "/console/access#mcp",
    linkLabel: "生成 Token",
    title: "创建两类 Token",
  },
];

export default function ConsoleIndexPage() {
  return (
    <div className="dp-guide">
      <PageHeader
        actions={
          <Link className="dp-guide-primary-action" href="/console/access">
            开始配置
            <ArrowRight />
          </Link>
        }
        title="使用指南"
      />

      <section className="dp-guide-section" id="framework">
        <h2 className="dp-console-section-title">运行架构</h2>

        <div className="dp-guide-architecture">
          <article className="dp-guide-architecture-node is-producer">
            <header>
              <span>
                <Send />
              </span>
              <div>
                <small>01 / 任务入口</small>
                <h3>Task Producer</h3>
              </div>
            </header>
            <p>提交目标与验收标准，并读取任务生命周期和最终结果。</p>
            <div className="dp-guide-chips">
              <span>Codex</span>
              <span>Playground</span>
              <span>自定义集成</span>
            </div>
            <ul>
              <li>创建 Task</li>
              <li>查询状态与结果</li>
              <li>取消或触发重试</li>
            </ul>
          </article>

          <div className="dp-guide-architecture-link is-producer-link">
            <span>TEAM TOKEN</span>
            <ArrowRight />
            <b>MCP / TASK HTTP</b>
          </div>

          <article className="dp-guide-architecture-node is-devproof">
            <header>
              <span>DP</span>
              <div>
                <small>02 / 唯一控制面</small>
                <h3>DevProof</h3>
              </div>
            </header>
            <p>持有 Task、Run、重试、租约、人工接管与证据的唯一业务状态。</p>
            <div className="dp-guide-core-grid">
              <span>
                <FileCheck2 />
                <b>任务编排</b>
                <small>Stage + Attempt</small>
              </span>
              <span>
                <Route />
                <b>租约与路由</b>
                <small>分配执行环境</small>
              </span>
              <span>
                <Eye />
                <b>证据</b>
                <small>截图 + 事件轨迹</small>
              </span>
              <span>
                <Pause />
                <b>人工接管检查点</b>
                <small>暂停 + 通知 + 恢复</small>
              </span>
            </div>
          </article>

          <div className="dp-guide-architecture-link is-row-break">
            <span>RUNTIME LEASE</span>
            <ArrowRight />
            <b>CLAIM / OUTCOME</b>
          </div>

          <article className="dp-guide-architecture-node is-agent">
            <header>
              <span>
                <Bot />
              </span>
              <div>
                <small>03 / 模型循环</small>
                <h3>Agent Runtime</h3>
              </div>
            </header>
            <p>领取具体 Run，在无业务状态的 Worker 中执行模型与工具循环。</p>
            <div className="dp-guide-chips">
              <span>Model</span>
              <span>Browser Executor</span>
            </div>
            <ul>
              <li>模型推理与工具调用</li>
              <li>Heartbeat 与恢复</li>
              <li>回传结构化 Outcome</li>
            </ul>
          </article>

          <div className="dp-guide-architecture-link is-runner-link">
            <span>控制面路由</span>
            <ArrowRight />
            <b>RUNNER PROTOCOL</b>
          </div>

          <article className="dp-guide-architecture-node is-runner">
            <header>
              <span>
                <MonitorUp />
              </span>
              <div>
                <small>04 / 执行环境</small>
                <h3>执行节点</h3>
              </div>
            </header>
            <p>执行具体环境动作，并把制品和运行事件交回控制面。</p>
            <div className="dp-guide-runner-window">
              <i />
              <i />
              <i />
              <strong>Playwright / 浏览器会话</strong>
            </div>
            <ul>
              <li>页面导航与检查</li>
              <li>持久化浏览器身份</li>
              <li>截图证据</li>
            </ul>
          </article>
        </div>

        <div className="dp-guide-hitl">
          <article className="dp-guide-hitl-state">
            <header>
              <CircleHelp />
              <span>
                <small>DEVPROOF 人工接管</small>
                <h3>暂停、接管、恢复同一个 Run</h3>
              </span>
            </header>
            <p>
              Agent 调用 request_human_input 后，DevProof 创建一次性检查点，将
              Run 置为
              WAITING_HUMAN，并保留原浏览器会话、执行槽位与浏览器身份租约。
            </p>
            <div className="dp-guide-state-line">
              <span>
                <Pause />
                <b>暂停 Run</b>
                <small>检查点 + 通知</small>
              </span>
              <ArrowRight />
              <span className="active">
                <UserRound />
                <b>人工接管</b>
                <small>原页面 · 单控制者</small>
              </span>
              <ArrowRight />
              <span>
                <Play />
                <b>恢复 Attempt</b>
                <small>响应 + 新租约</small>
              </span>
            </div>
          </article>

          <article className="dp-guide-hitl-cases">
            <div>
              <UserRound />
              <span>
                <b>身份与安全校验</b>
                <small>登录、MFA、CAPTCHA 或验证码；敏感输入不留存。</small>
              </span>
            </div>
            <div>
              <ShieldCheck />
              <span>
                <b>审批与业务判断</b>
                <small>授权、审批或必须由负责人确认的业务分支。</small>
              </span>
            </div>
            <div>
              <CircleAlert />
              <span>
                <b>不用于执行故障</b>
                <small>
                  执行节点离线、页面异常或证据不足应等待、重试、失败或标记不确定。
                </small>
              </span>
            </div>
          </article>
        </div>
      </section>

      <section className="dp-guide-section" id="configuration">
        <h2 className="dp-console-section-title">配置步骤</h2>

        <div className="dp-guide-config-flow">
          {configSteps.map((step, index) => {
            const Icon = step.icon;
            return (
              <article key={step.title}>
                <div className="dp-guide-config-number">
                  <span>0{index + 1}</span>
                  {index < configSteps.length - 1 ? <i /> : null}
                </div>
                <div className="dp-guide-config-card">
                  <header>
                    <Icon />
                    <h3>{step.title}</h3>
                  </header>
                  <p>{step.detail}</p>
                  <Link href={step.link}>
                    {step.linkLabel}
                    <ArrowRight />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
