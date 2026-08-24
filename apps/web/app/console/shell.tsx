"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  Activity,
  BookOpen,
  Cable,
  ChevronRight,
  FlaskConical,
  LogOut,
  Menu,
  Gauge,
  UserRoundCheck,
  X,
} from "lucide-react";

import { requestWithTimeout } from "@/lib/api";
import { ThemeToggle } from "../theme-toggle";

interface Session {
  team: { id: string; name: string; slug: string };
  user: {
    avatarUrl: string | null;
    email: string | null;
    id: string;
    name: string | null;
  };
}

const sections = [
  { href: "/console", icon: BookOpen, label: "使用指南" },
  { href: "/console/playground", icon: FlaskConical, label: "集成试验场" },
  { href: "/console/access", icon: Cable, label: "接入配置" },
  { href: "/console/runs", icon: Activity, label: "任务执行" },
  { href: "/console/profiles", icon: UserRoundCheck, label: "浏览器身份" },
  { href: "/console/observability", icon: Gauge, label: "系统监控" },
];

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
        if (!mounted) {
          return;
        }
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

  async function logout() {
    await requestWithTimeout("/auth/logout", {
      credentials: "include",
      method: "POST",
    }).catch(() => undefined);
    window.location.href = "/login";
  }

  if (!session) {
    return sessionError ? (
      <div className="dp-session-error" role="alert">
        <strong>无法连接 DevProof</strong>
        <span>{sessionError}</span>
        <button
          onClick={() => setSessionAttempt((value) => value + 1)}
          type="button"
        >
          重新检查
        </button>
      </div>
    ) : (
      <div aria-live="polite" className="dp-session-loading" role="status">
        正在检查公司登录状态…
      </div>
    );
  }

  const current =
    sections.find((section) => sectionIsActive(section.href, pathname)) ??
    sections[0];
  const name = session.user.name ?? session.user.email ?? "公司成员";

  return (
    <div className="dp-console">
      <aside className="dp-side">
        <div className="dp-side-head">
          <Link className="dp-wordmark" href="/console">
            <span>DevProof</span>
            <i />
          </Link>
        </div>
        <nav className="dp-side-nav" aria-label="控制台导航">
          {sections.map((section) => {
            const Icon = section.icon;
            const active = sectionIsActive(section.href, pathname);
            return (
              <Link
                className={active ? "active" : undefined}
                href={section.href}
                key={section.href}
              >
                <Icon />
                {section.label}
                {active ? <ChevronRight className="tail" /> : null}
              </Link>
            );
          })}
        </nav>
        <div className="dp-side-foot">
          {session.user.avatarUrl ? (
            <img alt="" src={session.user.avatarUrl} />
          ) : (
            <b>{name.slice(0, 1).toUpperCase()}</b>
          )}
          <span>
            <strong>{name}</strong>
            <small>{session.user.email ?? "飞书公司成员"}</small>
          </span>
          <button aria-label="退出登录" onClick={logout} type="button">
            <LogOut />
          </button>
        </div>
      </aside>
      <main className="dp-console-main">
        <header className="dp-topbar">
          <button
            aria-controls="dp-mobile-navigation"
            aria-expanded={mobileNavOpen}
            aria-label={mobileNavOpen ? "关闭控制台导航" : "打开控制台导航"}
            className="dp-mobile-menu-button"
            onClick={() => setMobileNavOpen((open) => !open)}
            type="button"
          >
            {mobileNavOpen ? <X /> : <Menu />}
            <span>DP</span>
          </button>
          <strong>{current?.label}</strong>
          <ThemeToggle compact />
        </header>
        <div
          aria-hidden={!mobileNavOpen}
          className={`dp-mobile-navigation ${mobileNavOpen ? "is-open" : ""}`}
          id="dp-mobile-navigation"
        >
          <button
            aria-label="关闭控制台导航"
            className="dp-mobile-navigation-backdrop"
            onClick={() => setMobileNavOpen(false)}
            type="button"
          />
          <nav aria-label="移动端控制台导航">
            <strong>{session.team.name}</strong>
            {sections.map((section) => {
              const Icon = section.icon;
              const active = sectionIsActive(section.href, pathname);
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={active ? "active" : undefined}
                  href={section.href}
                  key={section.href}
                >
                  <Icon />
                  {section.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div id="dp-console-workspace-overlay" />
        <div className="dp-console-content">
          <div className="dp-console-inner">{children}</div>
        </div>
      </main>
    </div>
  );
}

function sectionIsActive(href: string, pathname: string) {
  if (href === "/console") return pathname === href;
  if (href === "/console/runs") {
    return (
      pathname.startsWith(href) || pathname.startsWith("/console/executions")
    );
  }
  return pathname.startsWith(href);
}
