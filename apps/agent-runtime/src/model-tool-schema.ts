import { z } from "zod";

/**
 * Gateways accept different subsets of string formats. Keep their validation
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
  return stripValidationFormats(parameters);
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
