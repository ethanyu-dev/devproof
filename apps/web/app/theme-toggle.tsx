"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import {
  normalizeTheme,
  resolveTheme,
  SYSTEM_THEME_QUERY,
  THEME_STORAGE_KEY,
  THEMES,
  type Theme,
} from "./theme";

function applyTheme(theme: Theme, systemPrefersDark: boolean): void {
  const resolvedTheme = resolveTheme(theme, systemPrefersDark);
  const root = document.documentElement;

  root.classList.toggle(THEMES.DARK, resolvedTheme === THEMES.DARK);
  root.dataset.theme = resolvedTheme;
}

function readStoredTheme(): Theme {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return THEMES.SYSTEM;
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable in hardened browser contexts. The selected
    // theme still applies for the current page session.
  }
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setThemeState] = useState<Theme | null>(null);

  useEffect(() => {
    setThemeState(readStoredTheme());
  }, []);

  useEffect(() => {
    if (theme !== THEMES.SYSTEM) {
      return;
    }

    const mediaQuery = window.matchMedia(SYSTEM_THEME_QUERY);
    const handleSystemThemeChange = (event: MediaQueryListEvent): void => {
      applyTheme(THEMES.SYSTEM, event.matches);
    };

    applyTheme(THEMES.SYSTEM, mediaQuery.matches);
    mediaQuery.addEventListener("change", handleSystemThemeChange);

    return () => {
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
    };
  }, [theme]);

  function setTheme(nextTheme: Theme): void {
    const systemPrefersDark = window.matchMedia(SYSTEM_THEME_QUERY).matches;
    applyTheme(nextTheme, systemPrefersDark);
    writeStoredTheme(nextTheme);
    setThemeState(nextTheme);
  }

  return (
    <div
      aria-label="主题"
      className={
        compact ? "dp-theme-toggle dp-theme-toggle-compact" : "dp-theme-toggle"
      }
      role="group"
    >
      <button
        aria-label="浅色主题"
        aria-pressed={theme === THEMES.LIGHT}
        className={theme === THEMES.LIGHT ? "active" : undefined}
        onClick={() => setTheme(THEMES.LIGHT)}
        title="浅色主题"
        type="button"
      >
        <Sun />
      </button>
      <button
        aria-label="深色主题"
        aria-pressed={theme === THEMES.DARK}
        className={theme === THEMES.DARK ? "active" : undefined}
        onClick={() => setTheme(THEMES.DARK)}
        title="深色主题"
        type="button"
      >
        <Moon />
      </button>
      <button
        aria-label="跟随系统主题"
        aria-pressed={theme === THEMES.SYSTEM}
        className={theme === THEMES.SYSTEM ? "active" : undefined}
        onClick={() => setTheme(THEMES.SYSTEM)}
        title="跟随系统主题"
        type="button"
      >
        <Monitor />
      </button>
    </div>
  );
}
