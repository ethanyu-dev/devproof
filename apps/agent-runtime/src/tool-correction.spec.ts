import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  parseBrowserCommand,
  schemaCorrection,
  toolCorrection,
} from "./tool-correction.js";

function rejected(command: Record<string, unknown>) {
  const result = parseBrowserCommand(command);
  if (result.success) throw new Error("Expected invalid command");
  const serialized = JSON.stringify(result.correction);
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(2_048);
  expect(JSON.parse(serialized)).toMatchObject({
    accepted: false,
    retryable: true,
  });
  expect(result.correction.issues.length).toBeLessThanOrEqual(3);
  expect(result.correction.suggestions.length).toBeLessThanOrEqual(2);
  return result.correction;
}

describe("bounded model tool corrections", () => {
  it("suggests only relevant commands without the full union error", () => {
    const result = rejected({ commandType: "page.content", payload: {} });
    expect(result).toMatchObject({
      code: "UNKNOWN_COMMAND",
      suggestions: ["page.get_text", "page.dom"],
    });
    expect(result.nextAction).toContain("可见文本");
    expect(result.nextAction).toContain("HTML");
    expect(JSON.stringify(result)).not.toContain("network.arm");
  });

  it.each([undefined, null, 1, [], {}])(
    "requires a string commandType: %j",
    (commandType) => {
      expect(rejected({ commandType, payload: {} })).toMatchObject({
        code: "INVALID_ARGUMENTS",
        issues: [{ path: "commandType" }],
      });
    },
  );

  it("retains the complete recovery token and parsed command defaults", () => {
    expect(
      parseBrowserCommand({
        commandType: "page.wait",
        payload: { kind: "text", text: "完成" },
        timeoutSeconds: "30",
        locatorRecoveryToken: "call-ambiguous",
      }),
    ).toEqual({
      success: true,
      command: {
        commandType: "page.wait",
        payload: {
          kind: "text",
          text: "完成",
          exact: false,
          timeoutMs: 30_000,
        },
        timeoutSeconds: 30,
      },
      locatorRecoveryToken: "call-ambiguous",
    });
  });

  it.each(["", "x".repeat(241), null, 1])(
    "rejects invalid recovery tokens without echoing them",
    (locatorRecoveryToken) => {
      expect(
        rejected({
          commandType: "page.click",
          payload: { target: { ref: "f1e17" } },
          locatorRecoveryToken,
        }).issues,
      ).toEqual([expect.objectContaining({ path: "locatorRecoveryToken" })]);
    },
  );

  it("explains both click alternatives instead of unrelated command branches", () => {
    const result = rejected({ commandType: "page.click", payload: {} });
    expect(JSON.stringify(result.issues)).toContain("payload.target");
    expect(JSON.stringify(result.issues)).toContain("payload.point");
    expect(JSON.stringify(result.issues)).toContain("或");
    expect(JSON.stringify(result)).not.toContain("url");
  });

  it("reports a bad ref and the response-body filter constraint", () => {
    expect(
      rejected({
        commandType: "page.click",
        payload: { target: { ref: "bad-ref" } },
      }).issues,
    ).toContainEqual({
      path: "payload.target.ref",
      expected: expect.stringContaining("完整的 eN/fNeN"),
    });
    expect(
      rejected({
        commandType: "page.network",
        payload: { includeResponseBodies: true },
      }).issues,
    ).toContainEqual({
      path: "payload.urlIncludes",
      expected: expect.stringContaining("includeResponseBodies=true"),
    });
  });

  it("does not echo submitted credentials, arbitrary keys, or raw validation messages", () => {
    const secret = "sk-private-credential-123456789";
    const inputs = [
      { commandType: secret, payload: {} },
      {
        commandType: "page.navigate",
        payload: { url: `https://user:${secret}@example.com` },
      },
      {
        commandType: "page.fill",
        payload: { target: { ref: secret }, text: secret, [secret]: secret },
      },
    ];
    for (const input of inputs)
      expect(JSON.stringify(rejected(input))).not.toContain(secret);
    const parsed = z
      .object({ status: z.enum(["PASSED", "FAILED"]) })
      .safeParse({ status: secret });
    if (parsed.success) throw new Error("Expected validation error");
    expect(JSON.stringify(schemaCorrection(parsed.error))).not.toContain(
      secret,
    );
  });

  it("bounds multi-byte text and JSON escaping while preserving valid JSON", () => {
    const result = toolCorrection('错误\\\n"🧪'.repeat(1_000), {
      issues: Array.from({ length: 100 }, (_, index) => ({
        path: `payload.${index}`,
        expected: '格式错误\\\n"🧪'.repeat(500),
      })),
      suggestions: ["page.dom", "page.get_text", "session.close"],
      nextAction: "修正".repeat(500),
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      2_048,
    );
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      accepted: false,
      retryable: true,
    });
    expect(result.issues.length).toBeLessThanOrEqual(3);
    expect(result.suggestions).not.toContain("session.close");
  });
});
