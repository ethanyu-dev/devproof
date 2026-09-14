/** Bounded JSON business payloads only; authentication and form uploads are omitted. */
export function observedRequestBody(
  url: string,
  contentType: string,
  raw: string | null,
  redactValue: (value: unknown) => unknown,
) {
  if (!raw || raw.length > 16_384 || !/\bjson\b/iu.test(contentType))
    return undefined;
  if (
    /(?:^|\/)(?:oauth|auth|login|signin|sign-in|token|refresh|session|password)(?:\/|$)/iu.test(
      new URL(url).pathname,
    )
  )
    return undefined;
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
