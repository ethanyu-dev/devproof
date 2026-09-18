import { expect, it } from "vitest";
import {
  contextRetentionSchema,
  contextWindowBudget,
  modelContextLimitsSchema,
} from "./context-policy.js";

it("uses the smallest configured fallback allowance and reports unknown models", () => {
  const limits = modelContextLimitsSchema.parse({
    large: { contextWindowTokens: 1_000_000 },
    small: {
      contextWindowTokens: 131072,
      outputReserveTokens: 4096,
      imageTokensPerImage: 2048,
    },
  });
  expect(
    contextWindowBudget(["large", "small", "unknown"], limits, 2),
  ).toMatchObject({
    maxTextBytes: 131072 - 4096 - 4096 - 1024,
    unconfiguredModels: ["unknown"],
  });
  expect(contextWindowBudget(["unknown"], limits, 0).maxTextBytes).toBeNull();
});

it("rejects invalid retention and impossible output reserves", () => {
  expect(() => contextRetentionSchema.parse({ detailedTurns: 0 })).toThrow();
  expect(() => contextRetentionSchema.parse({ typo: 12 })).toThrow();
  expect(() =>
    modelContextLimitsSchema.parse({ small: { contextWindowTokens: 4096 } }),
  ).toThrow();
});
