export const THEME_STORAGE_KEY = "devproof-theme";
export const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

export const THEMES = {
  DARK: "dark",
  LIGHT: "light",
  SYSTEM: "system",
} as const;

export type Theme = (typeof THEMES)[keyof typeof THEMES];
export type ResolvedTheme = typeof THEMES.DARK | typeof THEMES.LIGHT;

export function normalizeTheme(theme: string | null): Theme {
  if (theme === THEMES.DARK || theme === THEMES.LIGHT) {
    return theme;
  }

  return THEMES.SYSTEM;
}

export function resolveTheme(
  theme: Theme,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (theme === THEMES.SYSTEM) {
    return systemPrefersDark ? THEMES.DARK : THEMES.LIGHT;
  }

  return theme;
}

// Runs before the first paint so a stored or system dark preference never
// flashes the default light palette while React hydrates.
export const THEME_INIT_SCRIPT = [
  "(function(){",
  `var theme="${THEMES.SYSTEM}";`,
  "try{",
  `var storedTheme=localStorage.getItem("${THEME_STORAGE_KEY}");`,
  `if(storedTheme==="${THEMES.DARK}"||storedTheme==="${THEMES.LIGHT}"){theme=storedTheme;}`,
  "}catch(error){}",
  'var canReadSystemTheme=typeof window.matchMedia==="function";',
  `var systemPrefersDark=theme==="${THEMES.SYSTEM}"&&canReadSystemTheme&&window.matchMedia("${SYSTEM_THEME_QUERY}").matches;`,
  `var isDark=theme==="${THEMES.DARK}"||systemPrefersDark;`,
  "var root=document.documentElement;",
  `root.classList.toggle("${THEMES.DARK}",isDark);`,
  `root.dataset.theme=isDark?"${THEMES.DARK}":"${THEMES.LIGHT}";`,
  "})();",
].join("");
