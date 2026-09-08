import { z } from "zod";

/**
 * Gateways accept different subsets of string formats. Keep their validation
 * in the canonical Zod parser while omitting validation-only annotations from
 * model tools. Tools remain non-strict because the protocol has optional and
 * defaulted fields; do not turn those fields into required properties.
 */
export function openAiFunctionSchema(schema: z.ZodType): unknown {
  return stripValidationFormats(z.toJSONSchema(schema));
}

function stripValidationFormats(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripValidationFormats);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      key === "format" ? [] : [[key, stripValidationFormats(child)]],
    ),
  );
}
