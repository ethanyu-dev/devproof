import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Braces, Terminal, Webhook } from "lucide-react";
import styles from "./docs.module.css";

export const metadata: Metadata = {
  title: "开发者接入指南",
  description:
    "通过 HTTP API 或 MCP 派发 DevProof 测试任务，查询执行进度与验收结果。",
};
const createExample = `curl "$DEVPROOF_API_URL/v2/tasks" \\
  -H "Authorization: Bearer $DEVPROOF_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "kind": "SPEC_TASK",
    "idempotencyKey": "ci-build-123-attempt-1",
    "externalReference": {"source": "ci", "externalId": "build-123"},
    "goal": "检查首页加载、主要导航和控制台错误。",
    "targetUrl": "https://preview.example.com",
    "profilePolicy": {"strategy": "EPHEMERAL"}
  }'`;
export default function DocsPage() {
  return (
    <main className={styles.guide}>
      <section className={styles.hero}>
        <p className={styles.eyebrow}>DEVPROOF / DEVELOPERS</p>
        <h1>把测试执行接入你的工作流</h1>
        <p className={styles.lead}>
          提交测试目标，DevProof
          分析用例、调度浏览器执行，并返回可追溯的结果。为后端服务、CI/CD 和 AI
          助手提供统一的任务入口。
        </p>
        <div className={styles.actions}>
          <Link className={styles.primary} href="/docs/api">
            浏览 API 与在线调试 <ArrowRight size={17} />
          </Link>
          <a className={styles.secondary} href="/v2/openapi.json">
            下载 OpenAPI JSON
          </a>
        </div>
        <p className={styles.note}>
          文档可直接查看。调用接口时需要你自己的 DevProof Token。
        </p>
      </section>
      <div className={styles.choices}>
        <article>
          <Braces size={22} />
          <h2>HTTP API</h2>
          <p>
            适合后端服务与 CI/CD。通过普通 HTTP
            请求创建、查询、补充输入和取消任务。
          </p>
          <code>/v2/tasks</code>
        </article>
        <article>
          <Terminal size={22} />
          <h2>MCP</h2>
          <p>
            适合已支持 MCP 的 AI 助手。使用同一枚
            Token，通过工具发现和结构化参数调用。
          </p>
          <code>API 服务地址 + /mcp</code>
        </article>
        <article>
          <Webhook size={22} />
          <h2>事件回调</h2>
          <p>
            订阅任务完成或需要人工输入的事件。支持签名、补发、去重和失败重试。
          </p>
          <code>/v2/tasks/&#123;id&#125;/webhooks</code>
        </article>
      </div>
      <div className={styles.content}>
        <aside className={styles.toc}>
          <p>快速接入</p>
          <a href="#token">01 · 准备 Token</a>
          <a href="#create">02 · 创建任务</a>
          <a href="#result">03 · 获取结果</a>
          <a href="#webhook">配置回调</a>
          <a href="#identity">复用登录身份</a>
          <a href="#mcp">使用 MCP</a>
        </aside>
        <div className={styles.sections}>
          <section id="token">
            <span className={styles.step}>01 / AUTHENTICATION</span>
            <h2>准备访问 Token</h2>
            <p>
              登录控制台，在「接入配置 → 访问 Token」中创建服务专用
              Token。派发任务需要 <code>run:write</code>，查询需要{" "}
              <code>run:read</code>，取消需要 <code>run:cancel</code>。
            </p>
            <p>
              将 <code>DEVPROOF_API_URL</code> 设置为 DevProof API
              服务地址（本地默认 <code>http://localhost:4433</code>），将 Token
              保存在调用服务的环境变量 <code>DEVPROOF_TOKEN</code> 中。HTTP v2
              接口也可以通过当前 Web 域名调用。
            </p>
            <pre>
              <code>Authorization: Bearer &lt;DevProof Token&gt;</code>
            </pre>
            <p>
              这是 DevProof 的访问凭证。在线调试需手动填写
              Token，不会自动使用控制台登录身份，也不会持久保存 Token。
            </p>
          </section>
          <section id="create">
            <span className={styles.step}>02 / CREATE A TASK</span>
            <h2>提交测试目标</h2>
            <p>
              提供测试说明、Issue 或 GitHub
              PR，至少填写一项。下面的示例使用临时浏览器会话；也支持多个测试环境。
            </p>
            <pre>
              <code>{createExample}</code>
            </pre>
            <p>
              接口返回 <code>202</code> 和任务 <code>id</code>{" "}
              后，执行在后台继续。网络重试时复用同一 <code>idempotencyKey</code>{" "}
              和相同参数；主动再测一轮则使用新键。
            </p>
          </section>
          <section id="result">
            <span className={styles.step}>03 / FOLLOW THE RESULT</span>
            <h2>查询进度与验收结果</h2>
            <pre>
              <code>{`GET /v2/tasks/{id}
GET /v2/tasks/{id}/events?after=123
GET /v2/tasks/{id}/acceptance-report
GET /v2/tasks?page=1&pageSize=20&source=ci&externalId=build-123`}</code>
            </pre>
            <p>
              <code>lifecycle</code> 表示执行状态，<code>verdict</code>{" "}
              表示测试结论。<code>COMPLETED</code> 只代表任务结束，应同时查看{" "}
              <code>verdict</code> 和验收报告。遇到 <code>WAITING_INPUT</code>{" "}
              或 <code>WAITING_HUMAN</code>，读取 <code>waitingReason</code>{" "}
              与详情中的待补充信息。
            </p>
            <p>
              列表建议显式传 <code>page=1</code>，返回分页对象。
              <code>externalReference</code>{" "}
              用于关联业务单号；它允许关联多轮任务，不是幂等键。
            </p>
          </section>
          <section id="webhook">
            <h2>订阅任务回调</h2>
            <p>
              创建任务后，调用{" "}
              <code>POST /v2/tasks/&#123;id&#125;/webhooks</code>。回调默认允许
              HTTP/HTTPS，包括本地与内网地址，目标需要从 API 服务所在网络可达。
            </p>
            <pre>
              <code>
                {JSON.stringify(
                  {
                    url: "https://ci.example.com/devproof/events",
                    events: [
                      "task.completed",
                      "task.timed_out",
                      "task.waiting_input",
                    ],
                  },
                  null,
                  2,
                )}
              </code>
            </pre>
            <p>
              保存返回的 <code>signingSecret</code>，使用 HMAC-SHA256 校验{" "}
              <code>时间戳 + "." + 原始请求体</code>，与{" "}
              <code>X-DevProof-Signature</code> 的 <code>sha256=</code>{" "}
              后缀值进行常量时间比较，并校验 <code>X-DevProof-Timestamp</code>{" "}
              的时间偏差。
            </p>
            <p>
              匹配的历史事件会补发。投递可能重复或乱序，按事件 <code>id</code>{" "}
              去重，收到回调后查询最新详情。接收方返回 2xx
              即视为成功；失败会自动重试，最多 8 次。
            </p>
          </section>
          <section id="identity">
            <h2>使用已有的浏览器登录状态</h2>
            <p>
              身份所有者在 Token
              卡片展开「授权使用我的浏览器身份」并勾选身份。服务再调用{" "}
              <code>GET /v2/tasks/authorized-profiles</code> 获取可用身份
              ID，在创建参数中设置：
            </p>
            <pre>
              <code>
                {JSON.stringify(
                  {
                    profilePolicy: {
                      strategy: "EXPLICIT_PROFILE",
                      profileId: "<已授权身份 UUID>",
                      onUnavailable: "WAIT_FOR_PROFILE",
                    },
                  },
                  null,
                  2,
                )}
              </code>
            </pre>
            <p>
              身份的站点与入口授权仍需有效。撤销 Token
              的身份授权阻止新任务；已有任务需要单独取消。
            </p>
          </section>
          <section id="mcp">
            <h2>通过 MCP 调用</h2>
            <p>
              连接 API 服务的 <code>/mcp</code>，使用相同 Bearer
              Token。派发工具为 <code>create_task</code>，将上方创建请求放入{" "}
              <code>request</code> 字段；随后用 <code>get_task</code> 查询进度。
            </p>
            <pre>
              <code>
                {JSON.stringify(
                  {
                    request: {
                      kind: "SPEC_TASK",
                      idempotencyKey: "mcp-homepage-check-001",
                      goal: "检查首页是否正常加载。",
                      targetUrl: "https://preview.example.com",
                    },
                  },
                  null,
                  2,
                )}
              </code>
            </pre>
            <p>
              工具列表按 Token
              权限开放。支持任务列表、事件查询、重跑、补充输入、验收报告与证据读取；回调订阅通过
              HTTP 管理。
            </p>
          </section>
          <section>
            <h2>处理常见错误</h2>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>HTTP 状态</th>
                    <th>下一步</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>400</td>
                    <td>检查字段、枚举与格式；校验错误会返回 issues。</td>
                  </tr>
                  <tr>
                    <td>401 / 403</td>
                    <td>检查 Token 是否有效、所需 scope 和身份授权。</td>
                  </tr>
                  <tr>
                    <td>404</td>
                    <td>确认资源属于当前团队，回调订阅属于当前 Token。</td>
                  </tr>
                  <tr>
                    <td>409</td>
                    <td>重新查询状态，检查幂等键和输入修订号。</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <Link className={styles.next} href="/docs/api">
              查看完整参数、响应与在线调试 <ArrowRight size={17} />
            </Link>
          </section>
        </div>
      </div>
    </main>
  );
}
