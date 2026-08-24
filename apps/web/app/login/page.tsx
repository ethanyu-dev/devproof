import { ArrowRight, Building2, ShieldCheck } from "lucide-react";

import { ThemeToggle } from "../theme-toggle";

const errors: Record<string, string> = {
  tenant_denied: "该飞书账号不属于管理员配置的租户，无法进入 DevProof。",
  invalid_state: "登录状态已失效，请重新发起登录。",
  sso_failed: "飞书登录暂时失败，请稍后重试。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const query = await searchParams;
  const error = query.error ? errors[query.error] : undefined;

  return (
    <main className="dp-login">
      <section className="dp-login-panel">
        <div className="dp-login-header">
          <div className="dp-wordmark" aria-label="DevProof">
            <span>DevProof</span>
            <i />
          </div>
          <ThemeToggle />
        </div>
        <div className="dp-login-copy">
          <p>AI 测试执行与验证</p>
          <h1>让每一次交付，都有可复现的证明。</h1>
          <span>统一连接 Agent Runtime、执行环境、验证证据与人工检查点。</span>
        </div>
        <div className="dp-login-facts">
          <div>
            <Building2 />
            <span>
              <strong>面向所有 Agent</strong>
              <small>通过 HTTP / MCP 统一提交验证目标</small>
            </span>
          </div>
          <div>
            <ShieldCheck />
            <span>
              <strong>可审计证据闭环</strong>
              <small>执行节点、HITL 与制品全程可追溯</small>
            </span>
          </div>
        </div>
      </section>
      <section className="dp-login-action">
        <div>
          <p>团队控制台</p>
          <h2>使用飞书继续</h2>
          <span>DevProof 不提供密码、邮箱或其他第三方登录方式。</span>
          {error ? <div className="dp-error">{error}</div> : null}
          <a className="dp-feishu-button" href="/auth/feishu/start">
            <span className="dp-feishu-mark">飞</span>
            使用飞书登录
            <ArrowRight />
          </a>
          <small>继续即表示将通过租户标识校验当前实例的访问权限。</small>
        </div>
      </section>
    </main>
  );
}
