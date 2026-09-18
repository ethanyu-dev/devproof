import { describe, expect, it } from "vitest";
import {
  compactValue,
  OperationMemory,
  summarizeTurn,
} from "./operation-summary.js";

describe("operation facts", () => {
  it("retains per-record rejection reasons when the surrounding checkpoint is large", () => {
    const memory = new OperationMemory();
    memory.record([
      {
        tool: "record_progress",
        arguments: {},
        outcome: "FAILED",
        result: {
          accepted: false,
          error: "部分记录更新失败",
          recordUpdates: [
            {
              recordRef: "record:one",
              accepted: false,
              error: "INITIAL_STATE_FORMAT: use observedRecords",
            },
          ],
          executionState: {
            records: Array.from({ length: 100 }, () => ({
              note: "x".repeat(2000),
            })),
          },
        },
      },
    ]);
    expect(JSON.stringify(memory.state())).toContain("INITIAL_STATE_FORMAT");
    expect(JSON.stringify(memory.state())).toContain("record:one");
  });
  it("enforces the byte cap even for deeply nested diagnostics with many priority fields", () => {
    let value: unknown = { error: '😀"\\'.repeat(5_000), code: "TOO_LARGE" };
    for (let index = 0; index < 4; index++)
      value = {
        error: value,
        result: value,
        locatorRecovery: value,
        nextAction: value,
      };
    for (const limit of [128, 256, 768, 1536, 4096])
      expect(
        Buffer.byteLength(JSON.stringify(compactValue(value, limit))),
      ).toBeLessThanOrEqual(limit);
  });
  it("records the actual failure and exact recovery action instead of the assistant's success claim", () => {
    const nextAction = {
      tool: "read_observation",
      arguments: { observationId: "snapshot-id", cursor: 10804 },
    };
    const facts = summarizeTurn(
      {
        role: "assistant",
        content: "保存已经成功，所有验收通过。",
        reasoning_content: "private thinking",
        tool_calls: [
          {
            type: "function",
            id: "save",
            function: {
              name: "browser_command",
              arguments: JSON.stringify({
                commandType: "page.click",
                payload: { target: { ref: "e1" } },
              }),
            },
          },
        ],
      },
      [
        {
          role: "tool",
          tool_call_id: "save",
          content: JSON.stringify({
            accepted: false,
            code: "OBSERVATION_NOT_READ",
            error: "未读",
            nextAction,
          }),
        },
      ],
    );
    expect(facts[0]).toMatchObject({
      callId: "save",
      outcome: "FAILED",
      result: { code: "OBSERVATION_NOT_READ", nextAction },
    });
    expect(JSON.stringify(facts)).not.toContain("所有验收通过");
    expect(JSON.stringify(facts)).not.toContain("private thinking");
    const memory = new OperationMemory();
    memory.record(facts);
    memory.record(facts);
    for (let i = 0; i < 8; i++)
      memory.record([
        {
          tool: "read_observation",
          arguments: { cursor: i },
          outcome: "RETURNED",
          result: {},
        },
      ]);
    expect(memory.state().recentFailures[0]).toMatchObject({
      count: 2,
      operation: { result: { nextAction } },
    });
    expect(memory.state().lastBrowserAction?.outcome).toBe("FAILED");
    memory.record([{ ...facts[0]!, outcome: "SUCCEEDED" }]);
    expect(memory.state().recentFailures).toEqual([]);
  });

  it("bounds verbose output explicitly and keeps successful clicks distinct from a business verdict", () => {
    const large = {
      status: "SUCCEEDED",
      result: {
        inputCompleted: true,
        pending: true,
        requests: Array.from({ length: 80 }, () => ({
          body: "内容".repeat(2000),
        })),
      },
    };
    expect(
      Buffer.byteLength(JSON.stringify(compactValue(large, 4096))),
    ).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(compactValue(large, 4096))).toContain("truncated");
    expect(compactValue(large, 4096)).toMatchObject({
      status: "SUCCEEDED",
      result: { pending: true },
    });
  });
});
