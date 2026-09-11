import { ArrowRight } from "lucide-react";

const errors: Record<string, string> = {
  tenant_denied: "该账号不属于当前团队，请切换飞书账号后重试。",
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
    <main className="grid min-h-svh place-items-center bg-background px-5 py-10">
      <section
        aria-labelledby="login-title"
        className="w-full max-w-sm rounded-lg border bg-card px-6 py-10 shadow-sm sm:px-8"
      >
        <div className="flex flex-col items-center text-center">
          <span
            aria-hidden="true"
            className="grid size-11 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
          >
            DP
          </span>
          <h1
            id="login-title"
            className="mt-5 text-2xl font-semibold tracking-tight"
          >
            DevProof
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            使用团队飞书账号继续
          </p>
        </div>
        {error ? (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-destructive/20 bg-muted px-4 py-3 text-sm leading-6 text-destructive"
          >
            {error}
          </div>
        ) : null}
        <a
          className="mt-8 flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm outline-none transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card"
          href="/auth/feishu/start"
        >
          飞书登录
          <ArrowRight aria-hidden="true" className="size-4" />
        </a>
      </section>
    </main>
  );
}
