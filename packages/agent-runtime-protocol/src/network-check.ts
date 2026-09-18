import { z } from "zod";
export const TYPED_CHECKS_CAPABILITY = "typed-checks-v1";
const scalar = z.union([
  z.string().max(2000),
  z.boolean(),
  z.number(),
  z.null(),
]);
const field = z.string().trim().min(1).max(300);
const part = z.enum(["QUERY", "REQUEST_BODY", "RESPONSE_BODY"]);
/** Display labels never participate in a structured request assertion. */
export const networkCheckSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().startsWith("/").max(2000),
    part,
    field,
    equals: scalar,
    encoding: z.enum(["NATIVE", "JSON_STRING"]).default("NATIVE"),
    where: z
      .array(z.object({ part, field, equals: scalar }).strict())
      .max(10)
      .default([]),
  })
  .strict();
export type NetworkCheck = z.infer<typeof networkCheckSchema>;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function fieldValue(
  request: Record<string, unknown>,
  part: NetworkCheck["part"],
  field: string,
): unknown {
  if (part === "QUERY") {
    try {
      const params = new URL(String(request.url)).searchParams;
      return params.getAll(field).length === 1 ? params.get(field) : undefined;
    } catch {
      return undefined;
    }
  }
  const key = part === "REQUEST_BODY" ? "requestBody" : "responseBody";
  if (
    request[`${key}Truncated`] === true ||
    request[`${key}Omitted`] !== undefined ||
    (part === "RESPONSE_BODY" && request.bodyPending === true)
  )
    return undefined;
  return field
    .split(".")
    .reduce<unknown>(
      (v, k) => (object(v) && Object.hasOwn(v, k) ? v[k] : undefined),
      request[key],
    );
}
function canonical(v: unknown): string {
  return JSON.stringify(
    Array.isArray(v)
      ? v.map((x) => JSON.parse(canonical(x)))
      : object(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, JSON.parse(canonical(v[k]))]),
          )
        : v,
  );
}
export function structuredNetworkMatches(
  quote: string,
  check: NetworkCheck,
): boolean {
  try {
    const request: unknown = JSON.parse(quote);
    if (
      !object(request) ||
      request.method !== check.method ||
      new URL(String(request.url)).pathname !== check.path
    )
      return false;
    if (
      !check.where.every(
        (w) => fieldValue(request, w.part, w.field) === w.equals,
      )
    )
      return false;
    const actual = fieldValue(request, check.part, check.field);
    if (check.encoding === "JSON_STRING") {
      // An object is not evidence of a JSON-encoded string field.
      return (
        typeof actual === "string" &&
        typeof check.equals === "string" &&
        canonical(JSON.parse(actual)) === canonical(JSON.parse(check.equals))
      );
    }
    return actual !== undefined && actual === check.equals;
  } catch {
    return false;
  }
}
