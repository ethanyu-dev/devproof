"use client";

import {
  Activity,
  Cable,
  Gauge,
  LogOut,
  Menu,
  UserRoundCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { requestWithTimeout } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Session {
  team: { id: string; name: string; slug: string };
  user: {
    avatarUrl: string | null;
    email: string | null;
    id: string;
    name: string | null;
  };
}

const adminSections = [
  {
    href: "/console/runs",
    icon: Activity,
    label: "任务执行",
    group: "工作区",
  },
  {
    href: "/console/profiles",
    icon: UserRoundCheck,
    label: "浏览器身份",
    group: "工作区",
  },
  {
    href: "/console/access",
    icon: Cable,
    label: "接入配置",
    group: "管理",
  },
  {
    href: "/console/observability",
    icon: Gauge,
    label: "系统监控",
    group: "管理",
  },
] as const;

export function ConsoleShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    let mounted = true;
    setSessionError(null);
    requestWithTimeout("/auth/me", { credentials: "include" })
      .then(async (response) => {
        if (response.status === 401) return null;
        if (!response.ok) throw new Error("公司登录状态检查失败。");
        return (await response.json()) as Session;
      })
      .then((body: Session | null) => {
        if (!mounted) return;
        if (!body) {
          window.location.href = "/login";
          return;
        }
        setSession(body);
      })
      .catch((error: Error) => {
        if (mounted) setSessionError(error.message);
      });
    return () => {
      mounted = false;
    };
  }, [sessionAttempt]);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [mobileNavOpen]);

  const current = useMemo(
    () =>
      adminSections.find((section) =>
        sectionIsActive(section.href, pathname),
      ) ?? adminSections[0],
    [pathname],
  );

  async function logout() {
    await requestWithTimeout("/auth/logout", {
      credentials: "include",
      method: "POST",
    }).catch(() => undefined);
    window.location.href = "/login";
  }

  if (!session) {
    if (sessionError) {
      return (
        <main className="grid min-h-svh place-items-center bg-muted/30 p-6">
          <div className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-sm">
            <div className="mb-5 grid size-10 place-items-center rounded-xl bg-destructive/10 text-destructive">
              <X className="size-5" />
            </div>
            <h1 className="text-lg font-semibold">无法连接 DevProof</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {sessionError}
            </p>
            <Button
              className="mt-5"
              onClick={() => setSessionAttempt((value) => value + 1)}
            >
              重新检查
            </Button>
          </div>
        </main>
      );
    }
    return (
      <main
        aria-live="polite"
        className="grid min-h-svh place-items-center bg-background"
        role="status"
      >
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-primary" />
          正在进入工作区…
        </div>
      </main>
    );
  }

  const name = session.user.name ?? session.user.email ?? "公司成员";
  const groupedSections = ["工作区", "管理"] as const;

  return (
    <div
      className="min-h-svh bg-muted/30 lg:grid lg:grid-cols-[232px_minmax(0,1fr)]"
      data-console-role="admin"
    >
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-[232px] flex-col border-r border-border/80 bg-sidebar lg:flex">
        <div className="flex h-14 items-center border-b border-sidebar-border px-4">
          <Link className="flex items-center gap-2.5" href="/console/runs">
            <span className="grid size-8 place-items-center rounded-lg bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
              DP
            </span>
            <span>
              <strong className="block text-sm font-semibold leading-none">
                DevProof
              </strong>
              <small className="mt-1 block text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Admin console
              </small>
            </span>
          </Link>
        </div>
        <nav
          className="flex-1 overflow-y-auto p-2.5"
          aria-label="管理员控制台导航"
        >
          {groupedSections.map((group) => (
            <div className="mb-4" key={group}>
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {group}
              </p>
              <div className="grid gap-1">
                {adminSections
                  .filter((section) => section.group === group)
                  .map((section) => (
                    <ConsoleNavLink
                      active={sectionIsActive(section.href, pathname)}
                      href={section.href}
                      icon={section.icon}
                      key={section.href}
                      label={section.label}
                    />
                  ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-3 rounded-xl px-2 py-2">
            {session.user.avatarUrl ? (
              <img
                alt=""
                className="size-9 rounded-full object-cover"
                src={session.user.avatarUrl}
              />
            ) : (
              <span className="grid size-9 place-items-center rounded-full bg-muted text-xs font-semibold">
                {name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-xs font-medium">
                {name}
              </strong>
              <small className="block truncate text-[10px] text-muted-foreground">
                {session.user.email ?? "飞书公司成员"}
              </small>
            </span>
            <Button
              aria-label="退出登录"
              onClick={logout}
              size="icon-sm"
              variant="ghost"
            >
              <LogOut />
            </Button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 lg:col-start-2">
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border/80 bg-background/95 px-4 backdrop-blur sm:px-5 lg:px-6">
          <div className="flex items-center gap-3">
            <Button
              aria-label={mobileNavOpen ? "关闭管理员导航" : "打开管理员导航"}
              className="lg:hidden"
              onClick={() => setMobileNavOpen((open) => !open)}
              size="icon"
              variant="ghost"
            >
              {mobileNavOpen ? <X /> : <Menu />}
            </Button>
            <div>
              <strong className="text-sm font-semibold">{current.label}</strong>
              <p className="hidden text-[11px] text-muted-foreground sm:block">
                {session.team.name}
              </p>
            </div>
          </div>
        </header>

        {mobileNavOpen ? (
          <div className="fixed inset-0 z-30 bg-foreground/20 backdrop-blur-sm lg:hidden">
            <button
              aria-label="关闭管理员导航"
              className="absolute inset-0"
              onClick={() => setMobileNavOpen(false)}
              type="button"
            />
            <nav className="absolute bottom-0 left-0 top-14 grid w-[min(84vw,280px)] auto-rows-max gap-1 overflow-y-auto border-r bg-sidebar p-3 shadow-xl">
              {adminSections.map((section) => (
                <ConsoleNavLink
                  active={sectionIsActive(section.href, pathname)}
                  href={section.href}
                  icon={section.icon}
                  key={section.href}
                  label={section.label}
                />
              ))}
            </nav>
          </div>
        ) : null}

        <main className="mx-auto w-full max-w-[1560px] px-4 py-4 sm:px-5 lg:px-6 lg:py-5">
          {children}
        </main>
        <div id="dp-console-workspace-overlay" />
      </div>
    </div>
  );
}

function ConsoleNavLink({
  active,
  href,
  icon: Icon,
  label,
}: {
  active: boolean;
  href: string;
  icon: typeof Activity;
  label: string;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs",
      )}
      href={href}
    >
      <Icon className={cn("size-4", active && "text-primary")} />
      {label}
    </Link>
  );
}

function sectionIsActive(href: string, pathname: string) {
  if (href === "/console/runs") {
    return (
      routeIsWithin(href, pathname) ||
      routeIsWithin("/console/executions", pathname)
    );
  }
  return routeIsWithin(href, pathname);
}

function routeIsWithin(basePath: string, pathname: string) {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}
