import { z } from "zod";

/**
 * Gateways accept different subsets of string formats and regex syntax. Keep validation
 * in the canonical Zod parser while omitting validation-only annotations from
 * model tools. Tools remain non-strict because the protocol has optional and
 * defaulted fields; do not turn those fields into required properties.
 */
export function openAiFunctionSchema(schema: z.ZodType): unknown {
  const parameters = z.toJSONSchema(schema);
  // Function parameters must be a root object. Project object unions into
  // properties; keep each field's alternatives and enforce cross-field rules
  // with the canonical Zod parser when the tool is executed.
  if (parameters.anyOf?.length) {
    const branches = parameters.anyOf;
    if (!branches.every((branch) => branch.type === "object"))
      throw new Error("Model function parameters must be objects.");
    const names = [
      ...new Set(
        branches.flatMap((branch) => Object.keys(branch.properties ?? {})),
      ),
    ];
    parameters.properties = Object.fromEntries(
      names.map((name) => {
        const alternatives = [
          ...new Map(
            branches.flatMap((branch) => {
              const field = branch.properties?.[name];
              if (field === undefined) return [];
              const object: z.core.JSONSchema.JSONSchema =
                typeof field === "boolean" ? (field ? {} : { not: {} }) : field;
              return [[JSON.stringify(object), object] as const];
            }),
          ).values(),
        ];
        const literals = alternatives.every(
          (field) => field.const !== undefined,
        );
        return [
          name,
          alternatives.length === 1
            ? alternatives[0]!
            : literals
              ? {
                  ...(alternatives[0]!.type &&
                  alternatives.every(
                    (field) => field.type === alternatives[0]!.type,
                  )
                    ? { type: alternatives[0]!.type }
                    : {}),
                  enum: alternatives.map((field) => field.const!),
                }
              : { anyOf: alternatives },
        ];
      }),
    );
    parameters.required = names.filter((name) =>
      branches.every((branch) => branch.required?.includes(name)),
    );
    parameters.additionalProperties = branches.every(
      (branch) => branch.additionalProperties === false,
    )
      ? false
      : true;
    parameters.type = "object";
    delete parameters.anyOf;
  }
  if (
    parameters.type !== "object" ||
    ["oneOf", "allOf", "enum", "const", "not"].some((key) => key in parameters)
  )
    throw new Error(
      "Model function parameters require an object without root combinators.",
    );
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
