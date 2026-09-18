import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { stepContextArchiveSchema } from "@devproof/agent-runtime-protocol";

export function archiveStepContext(
  request: Record<string, unknown>,
  metrics: unknown,
) {
  // Archive the exact prepared messages (including images), tools and settings.
  // Transport credentials are never part of a model request body.
  const safe = redactContext(request);
  const bytes = Buffer.from(
    JSON.stringify({ request: safe.value, metrics, redactedPaths: safe.paths }),
  );
  return stepContextArchiveSchema.parse({
    version: 1,
    encoding: "gzip-base64",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    data: gzipSync(bytes).toString("base64"),
  });
}

export function withStepIntent(value: unknown) {
  const parameters = value as Record<string, unknown>;
  return {
    ...parameters,
    properties: {
      ...(parameters.properties as Record<string, unknown>),
      stepIntent: {
        type: "string",
        minLength: 1,
        maxLength: 600,
        description: "本次调用的简短行动计划（简体中文）。",
      },
    },
    required: [...((parameters.required as string[]) ?? []), "stepIntent"],
  };
}

/** Metadata is not forwarded into Browser Runtime commands or verdict schemas. */
export function withoutStepIntent(value: Record<string, unknown>) {
  const { stepIntent: _intent, ...argumentsValue } = value;
  return argumentsValue;
}

export function executionArguments(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? JSON.stringify(withoutStepIntent(parsed))
      : value;
  } catch {
    return value;
  }
}

/** Preserve all content/structure except credentials, with explicit redaction paths. */
export function redactContext(value: unknown) {
  const paths = new Set<string>();
  const secret =
    /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client[_-]?secret|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|api[_-]?key|private[_-]?key|leaseToken)$/iu;
  function visit(item: unknown, path: string): unknown {
    if (Array.isArray(item))
      return item.map((child, i) => visit(child, `${path}[${i}]`));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => {
          const childPath = `${path}.${key}`;
          if (secret.test(key) && typeof child === "string") {
            paths.add(childPath);
            return [key, "[REDACTED]"];
          }
          return [key, visit(child, childPath)];
        }),
      );
    if (typeof item !== "string" || item.startsWith("data:image/")) return item;
    if (/^\s*[\[{]/u.test(item)) {
      try {
        const count = paths.size;
        const parsed = visit(JSON.parse(item), path);
        return paths.size === count ? item : JSON.stringify(parsed);
      } catch {
        /* Plain DOM/prose. */
      }
    }
    const redacted = item
      .replace(
        /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu,
        "[REDACTED]",
      )
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, "$1 [REDACTED]")
      .replace(/\b(?:dvp_sk_|sk-)[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
      .replace(
        /\b(password|passwd|secret|(?:access[_-]?)?token|api[-_]?key)(\s*[=:]\s*|["']?\s*:\s*["'])([^\s,;&"'<>}]+)/giu,
        "$1$2[REDACTED]",
      )
      .replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => {
        try {
          const url = new URL(candidate);
          let changed = !!url.username || !!url.password;
          url.username = "";
          url.password = "";
          for (const key of url.searchParams.keys())
            if (secret.test(key)) {
              url.searchParams.set(key, "[REDACTED]");
              changed = true;
            }
          return changed ? url.toString() : candidate;
        } catch {
          return candidate;
        }
      });
    if (redacted !== item) paths.add(path);
    return redacted;
  }
  return { value: visit(value, "$"), paths: [...paths] };
}
