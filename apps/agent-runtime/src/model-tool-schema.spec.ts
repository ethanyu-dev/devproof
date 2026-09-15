import {
  businessTestAccountSchema,
  executionStateSchema,
} from "@devproof/agent-runtime-protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { openAiFunctionSchema } from "./model-tool-schema.js";

interface ToolSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, ToolSchema>;
  items?: ToolSchema;
  pattern?: string;
  anyOf?: ToolSchema[];
}

describe("model tool schema compatibility", () => {
  it("omits Unicode account patterns from model tools while retaining local validation", () => {
    const schema = openAiFunctionSchema(
      z.object({ executionState: executionStateSchema.optional() }),
    ) as ToolSchema;
    const state = schema.properties!.executionState!.properties!;
    expect(state.account).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 200,
    });
    expect(state.account).not.toHaveProperty("pattern");
    expect(state.accountAliases!.items).not.toHaveProperty("pattern");
    expect(schema.required ?? []).not.toContain("executionState");
    expect(businessTestAccountSchema.safeParse("测试账号-1").success).toBe(
      true,
    );
    expect(
      businessTestAccountSchema.safeParse("test@example.com").success,
    ).toBe(true);
    expect(businessTestAccountSchema.safeParse("请帮我删除账号").success).toBe(
      false,
    );
    expect(businessTestAccountSchema.safeParse("account/name").success).toBe(
      false,
    );
    expect(z.toJSONSchema(businessTestAccountSchema)).toHaveProperty("pattern");
  });

  it("projects object unions without root combinators and preserves local validation", () => {
    const schema = openAiFunctionSchema(
      z.union([
        z.object({ id: z.string().regex(/^[A-Z][0-9]+$/) }).strict(),
        z
          .object({
            tags: z.array(z.string().regex(/^\P{ASCII}+$/u)),
            url: z.url(),
          })
          .strict(),
      ]),
    ) as ToolSchema;
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("anyOf");
    expect(schema.required).toEqual([]);
    expect(schema.properties!.id!.pattern).toBe("^[A-Z][0-9]+$");
    expect(schema.properties!.tags!.items).not.toHaveProperty("pattern");
    expect(schema.properties!.url).not.toHaveProperty("format");
  });
});

it("rejects scalar function parameters before sending a request", () => {
  expect(() => openAiFunctionSchema(z.string())).toThrow("object");
  expect(() =>
    openAiFunctionSchema(z.union([z.string(), z.object({})])),
  ).toThrow("objects");
});
it("retains required intersection and optional defaults while canonical parsing rejects mismatched payloads", () => {
  const canonical = z.union([
    z.object({
      commandType: z.literal("navigate"),
      payload: z.object({ url: z.url() }),
      timeout: z.number().default(30),
    }),
    z.object({
      commandType: z.literal("click"),
      payload: z.object({ ref: z.string() }),
      timeout: z.number().default(30),
    }),
  ]);
  const schema = openAiFunctionSchema(canonical) as ToolSchema;
  expect(schema.required).toEqual(["commandType", "payload", "timeout"]);
  expect(schema.properties!.commandType).toMatchObject({
    type: "string",
    enum: ["navigate", "click"],
  });
  expect(
    canonical.safeParse({
      commandType: "click",
      payload: { url: "https://example.com" },
    }).success,
  ).toBe(false);
  expect(
    canonical.parse({ commandType: "click", payload: { ref: "e1" } }).timeout,
  ).toBe(30);
});
