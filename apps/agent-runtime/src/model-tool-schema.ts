import { z } from "zod";

/**
 * Gateways accept different subsets of string formats and regex syntax. Keep validation
 * in the canonical Zod parser while omitting validation-only annotations from
 * model tools. Tools remain non-strict because the protocol has optional and
 * defaulted fields; do not turn those fields into required properties.
 */
export function openAiFunctionSchema(schema: z.ZodType): unknown {
  const parameters = z.toJSONSchema(schema);
  // Zod emits object unions as a bare anyOf. Kimi also requires the explicit
  // root type; retain every branch so command-specific constraints stay intact.
  if (
    parameters.type === undefined &&
    parameters.anyOf?.length &&
    parameters.anyOf.every((branch) => branch.type === "object")
  ) {
    parameters.type = "object";
  }
  return stripUnsupportedValidation(parameters);
}

function stripUnsupportedValidation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnsupportedValidation);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "format" ||
      // JSON Schema cannot carry the JS Unicode flag required by property escapes.
      // Keep these checks in Zod; provider regex validators may reject them.
      (key === "pattern" &&
        typeof child === "string" &&
        /\\[pP]\{/u.test(child))
        ? []
        : [[key, stripUnsupportedValidation(child)]],
    ),
  );
}

export function isInvalidModelToolSchema(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid schema for function|invalid.*tool.*schema|is not a valid format/iu.test(
    message,
  );
}
