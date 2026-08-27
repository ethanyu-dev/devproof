import { ArrowRight, Check, ShieldCheck } from "lucide-react";

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
    <main className="grid min-h-svh bg-background lg:grid-cols-[1.15fr_0.85fr]">
      <section className="relative hidden overflow-hidden border-r bg-zinc-950 px-12 py-10 text-white lg:flex lg:flex-col lg:justify-between xl:px-20 xl:py-14">
        <div className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(circle_at_20%_10%,rgba(99,102,241,.32),transparent_32%),radial-gradient(circle_at_90%_90%,rgba(14,165,233,.18),transparent_38%)]" />
        <div className="relative flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-white text-sm font-bold text-zinc-950">
            DP
          </span>
          <span className="text-sm font-semibold tracking-tight">DevProof</span>
        </div>
        <div className="relative max-w-xl">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-indigo-300">
            AI 测试执行与验证
          </p>
          <h1 className="text-4xl font-semibold leading-tight tracking-[-0.035em] xl:text-5xl">
            让每一次交付，
            <br />
            都有可以复现的证明。
          </h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-zinc-400">
            从任务目标到浏览器执行、人工操作与最终证据，所有状态汇聚在同一个工作区。
          </p>
          <div className="mt-10 grid gap-3 text-sm text-zinc-300">
            {[
              "统一查看团队任务",
              "保留操作截图与视频",
              "在原浏览器会话中安全接管",
            ].map((item) => (
              <span className="flex items-center gap-3" key={item}>
                <i className="grid size-5 place-items-center rounded-full bg-white/10 text-indigo-300">
                  <Check className="size-3" />
                </i>
                {item}
              </span>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-zinc-500">
          DevProof · Reproducible delivery evidence
        </p>
      </section>

      <section className="grid place-items-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-xs font-bold text-primary-foreground">
              DP
            </span>
            <strong className="text-sm">DevProof</strong>
          </div>
          <div className="mb-8 grid size-11 place-items-center rounded-xl bg-primary/8 text-primary">
            <ShieldCheck className="size-5" />
          </div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            团队工作区
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">
            使用飞书继续
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            登录后可以查看团队的全部任务执行记录，以及需要你处理的浏览器登录请求。
          </p>
          {error ? (
            <div className="mt-5 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <a
            className="mt-7 flex h-11 w-full items-center justify-center gap-3 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            href="/auth/feishu/start"
          >
            <span className="grid size-6 place-items-center rounded-md bg-white/12 text-xs font-semibold">
              飞
            </span>
            使用飞书登录
            <ArrowRight className="ml-auto size-4" />
          </a>
          <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
            DevProof 不保存密码，并会校验当前账号所属的飞书租户。
          </p>
        </div>
      </section>
    </main>
  );
}
