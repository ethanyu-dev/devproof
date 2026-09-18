import { isHostAllowlisted } from "./ip-rules.js";

export function isAuthenticationUrl(url: string) {
  try {
    return /(?:^|\/)(?:oauth|auth|login|signin|sign-in|token|refresh|session|password)(?:\/|$)/iu.test(
      new URL(url).pathname,
    );
  } catch {
    return true;
  }
}

/** Cross-origin business APIs must be explicitly covered by the node allowlist. */
export function networkBodyOmission(
  url: string,
  pageUrl: string,
  resourceType: string,
  allowlist: ReadonlySet<string>,
): string | undefined {
  if (!["fetch", "xhr"].includes(resourceType)) return "not_fetch_xhr";
  if (isAuthenticationUrl(url)) return "authentication";
  try {
    const target = new URL(url),
      page = new URL(pageUrl);
    if (!["http:", "https:"].includes(target.protocol)) return "protocol";
    if (
      target.origin !== page.origin &&
      !isHostAllowlisted(target.hostname, allowlist)
    )
      return "origin_not_allowlisted";
    return undefined;
  } catch {
    return "invalid_url";
  }
}

/** Bounded JSON business payloads only; authentication and form uploads are omitted. */
export function observedRequestBody(
  url: string,
  contentType: string,
  raw: string | null,
  redactValue: (value: unknown) => unknown,
) {
  if (!raw || raw.length > 16_384 || !/\bjson\b/iu.test(contentType))
    return undefined;
  if (isAuthenticationUrl(url)) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return undefined;
    const redacted = redactValue(value);
    return Buffer.byteLength(JSON.stringify(redacted)) <= 4000
      ? redacted
      : undefined;
  } catch {
    return undefined;
  }
}
