/** Opt-in display equivalence. Never apply this to input values, JSON or source quotations. */
export function normalizeDisplayText(value: string): string {
  return value
    .replace(/(?<=\p{Script=Han})[ \t\u00a0]+(?=\p{Script=Han})/gu, "")
    .replace(
      /(\b\d{2}:\d{2})[ \t\u00a0]*([–—-])[ \t\u00a0]*(?=\d{2}:\d{2}\b)/gu,
      "$1$2",
    )
    .replace(/[ \t\u00a0]+/gu, " ")
    .trim();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Text stays exact. JSON expectations compare parsed values, never stripped string contents. */
export function observedValueMatches(
  quote: string,
  expected: string,
  matchMode: "EXACT" | "DISPLAY_TEXT" = "EXACT",
) {
  if (quote.includes(expected)) return true;
  if (matchMode === "DISPLAY_TEXT" && !/^[\[{]/u.test(expected.trim()))
    return normalizeDisplayText(quote).includes(normalizeDisplayText(expected));
  let target: unknown;
  try {
    target = JSON.parse(expected);
  } catch {
    return false;
  }
  if (!target || typeof target !== "object") return false;
  const wanted = canonical(target);
  const matches = (value: unknown): boolean => {
    if (typeof value === "string") {
      try {
        return matches(JSON.parse(value));
      } catch {
        return false;
      }
    }
    return (
      canonical(value) === wanted ||
      (Boolean(value) &&
        typeof value === "object" &&
        Object.values(value as object).some(matches))
    );
  };
  try {
    if (matches(JSON.parse(quote))) return true;
  } catch {
    /* DOM quotes may surround JSON. */
  }
  // Bounded observations can contain JSON surrounded by node labels.
  for (let start = 0; start < quote.length; start++) {
    if (quote[start] !== "{" && quote[start] !== "[") continue;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let end = start; end < Math.min(quote.length, start + 8000); end++) {
      const char = quote[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        if (--depth === 0) {
          try {
            if (matches(JSON.parse(quote.slice(start, end + 1)))) return true;
          } catch {}
          break;
        }
      }
    }
  }
  return false;
}
