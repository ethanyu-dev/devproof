import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  archiveStepContext,
  executionArguments,
  withStepIntent,
  withoutStepIntent,
  redactContext,
} from "./step-context.js";

describe("step context capture", () => {
  it("retains the complete request including long DOM, all tools and images", () => {
    const request = {
      model: "test",
      messages: [
        { role: "user", content: "DOM尾部".repeat(20000) },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abcd" },
            },
          ],
        },
      ],
      tools: Array.from({ length: 40 }, (_, i) => ({
        name: `tool-${i}`,
        description: "原文".repeat(500),
      })),
    };
    const archive = archiveStepContext(request, { retainedTurns: 4 });
    const bytes = gunzipSync(Buffer.from(archive.data, "base64"));
    expect(bytes.length).toBe(archive.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      archive.sha256,
    );
    expect(JSON.parse(bytes.toString()).request).toEqual(request);
  });
  it("advertises an intent without forwarding it or counting rewrites as progress", () => {
    const parameters = {
      type: "object",
      properties: { commandType: { type: "string" } },
      required: ["commandType"],
    };
    expect(withStepIntent(parameters).required).toEqual([
      "commandType",
      "stepIntent",
    ]);
    const input = {
      commandType: "page.snapshot",
      payload: {},
      stepIntent: "核对列表筛选区域",
    };
    expect(withoutStepIntent(input)).toEqual({
      commandType: "page.snapshot",
      payload: {},
    });
    expect(executionArguments(JSON.stringify(input))).toEqual(
      executionArguments(
        JSON.stringify({ ...input, stepIntent: "换一种说法" }),
      ),
    );
    expect(parameters.required).toEqual(["commandType"]);
  });
  it("redacts credentials inside nested JSON while preserving long text and images", () => {
    const text = "完整页面尾部".repeat(10000);
    const value = {
      tools: [{ parameters: { properties: { apiKey: { type: "string" } } } }],
      messages: [
        {
          content: JSON.stringify({
            text,
            apiKey: "tool-secret-value",
            nested: JSON.stringify({ authorization: "Bearer private-value" }),
          }),
        },
      ],
      url: "https://site.test/?token=query-secret-value",
      image: "data:image/png;base64,abcd",
    };
    const safe = redactContext(value);
    const serialized = JSON.stringify(safe.value);
    expect(serialized).not.toMatch(
      /tool-secret-value|private-value|query-secret-value/,
    );
    expect(serialized).toContain(text);
    expect(serialized).toContain("data:image/png;base64,abcd");
    expect(safe.paths.length).toBeGreaterThanOrEqual(3);
    expect((safe.value as typeof value).tools).toEqual(value.tools);
  });
});
