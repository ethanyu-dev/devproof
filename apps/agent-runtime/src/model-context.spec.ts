import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ContextBudgetExceeded,
  ModelContext,
  jsonBytes,
} from "./model-context.js";

const initial = [
  { role: "system", content: "Use observed evidence." },
  { role: "user", content: "Verify every declared criterion exactly." },
];
const base = {
  model: "test",
  tools: [
    {
      type: "function",
      name: "browser_command",
      parameters: z.toJSONSchema(runtimeActionCommandInputSchema),
    },
  ],
};

function turn(context: ModelContext, index: number, content = "observed") {
  const calls = [0, 1].map((call) => ({
    type: "function_call",
    call_id: `${index}-${call}`,
    name: "browser_command",
    arguments: "{}",
  }));
  context.completeTurn(
    [
      {
        type: "reasoning",
        id: `reasoning-${index}`,
        encrypted_content: `opaque-${index}`,
        summary: [],
      },
      ...calls,
    ],
    calls.map((call) => ({
      type: "function_call_output",
      call_id: call.call_id,
      output: content,
    })),
  );
}

describe("bounded model context", () => {
  it("compacts whole response groups and keeps exact requirements and accepted state", () => {
    const context = new ModelContext(initial);
    for (let index = 0; index < 9; index += 1) turn(context, index);
    const state = {
      acceptedCriteria: [
        {
          criterionId: "first",
          summary: "准确值：订单 0042",
          evidenceRefs: ["artifact://proof"],
        },
      ],
      unresolvedCriterionIds: ["second"],
      locatorRecovery: { recoveryToken: "call-1" },
    };
    const view = context.build(base, state);
    expect(view.input.slice(0, 2)).toEqual(initial);
    expect(view.input[2]).toEqual({
      role: "user",
      content: JSON.stringify({ kind: "browser_working_state", data: state }),
    });
    expect(view.metrics).toMatchObject({ retainedTurns: 4, compactedTurns: 5 });
    const history = view.input.slice(3) as Array<Record<string, unknown>>;
    expect(history).toHaveLength(20);
    for (let index = 5; index < 9; index += 1) {
      expect(history).toContainEqual({
        type: "reasoning",
        id: `reasoning-${index}`,
        encrypted_content: `opaque-${index}`,
        summary: [],
      });
      for (const call of [0, 1]) {
        expect(
          history
            .filter((item) => item.call_id === `${index}-${call}`)
            .map((item) => item.type),
        ).toEqual(["function_call", "function_call_output"]);
      }
    }
    expect(JSON.stringify(history)).not.toContain("opaque-4");
  });

  it.each([
    [],
    [{ type: "function_call_output", call_id: "orphan", output: "{}" }],
    [0, 1].map(() => ({
      type: "function_call_output",
      call_id: "call",
      output: "{}",
    })),
  ])(
    "rejects incomplete, orphaned, and duplicate replies (%#)",
    (...results) => {
      const context = new ModelContext(initial);
      expect(() =>
        context.completeTurn(
          [{ type: "function_call", call_id: "call" }],
          results as Array<Record<string, unknown>>,
        ),
      ).toThrow("incomplete");
    },
  );

  it("counts tools and JSON escaping, removing older turns to meet the request budget", () => {
    const context = new ModelContext(initial, { maxBytes: 16_000 });
    const request = {
      model: "test",
      tools: [{ description: "工具".repeat(500) }],
    };
    for (let index = 0; index < 4; index += 1)
      turn(context, index, '\n"\\'.repeat(1_000));
    const view = context.build(request, {});
    expect(view.metrics.requestBytes).toBe(
      jsonBytes({ ...request, input: view.input }),
    );
    expect(view.metrics.requestBytes).toBeLessThanOrEqual(16_000);
    expect(view.metrics.toolSchemaBytes).toBe(jsonBytes(request.tools));
    expect(view.metrics.retainedTurns).toBe(1);
  });

  it("keeps request views and source objects independent across builds", () => {
    const source = structuredClone(initial);
    const context = new ModelContext(source);
    turn(context, 0);
    const first = context.build(base, { accepted: [] });
    const saved = structuredClone(first);
    source[1]!.content = "mutated";
    for (let index = 1; index < 8; index += 1) turn(context, index);
    const second = context.build(base, { accepted: ["first"] });
    expect(first).toEqual(saved);
    (first.input[0] as Record<string, unknown>).content = "provider mutation";
    expect(second.input.slice(0, 2)).toEqual(initial);
    expect(context.build(base, {}).input.slice(0, 2)).toEqual(initial);
  });

  it("fails explicitly when requirements, state, or the newest atomic group cannot fit", () => {
    for (const part of ["task", "state", "turn"]) {
      const context = new ModelContext(
        part === "task"
          ? [{ role: "user", content: "x".repeat(5_000) }]
          : initial,
        { maxBytes: 1_000 },
      );
      if (part === "turn") turn(context, 0, "x".repeat(5_000));
      expect(() =>
        context.build(
          {},
          part === "state" ? { accepted: "x".repeat(5_000) } : {},
        ),
      ).toThrow(ContextBudgetExceeded);
    }
  });

  it("supports a full-history rollback without adding state or enforcing the new budget", () => {
    const context = new ModelContext(initial, { mode: "LEGACY", maxBytes: 1 });
    for (let index = 0; index < 12; index += 1) turn(context, index);
    const view = context.build(base, { ignored: true });
    expect(view.metrics).toMatchObject({
      retainedTurns: 12,
      compactedTurns: 0,
    });
    expect(view.input).toHaveLength(initial.length + 12 * 5);
    expect(JSON.stringify(view.input)).not.toContain("browser_working_state");
  });

  it("reduces cumulative request bytes by at least half for an identical 30-turn fixture", () => {
    const bounded = new ModelContext(initial);
    const legacy = new ModelContext(initial, { mode: "LEGACY" });
    let boundedBytes = 0;
    let legacyBytes = 0;
    const tailSizes: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const content = JSON.stringify({
        content: 'Observed "value"\n'.repeat(600),
      });
      turn(bounded, index, content);
      turn(legacy, index, content);
      const view = bounded.build(base, {
        acceptedCriteria: [
          {
            criterionId: "first",
            status: "PASSED",
            evidenceRefs: ["artifact://proof"],
          },
        ],
      });
      boundedBytes += view.metrics.requestBytes;
      legacyBytes += legacy.build(base, {}).metrics.requestBytes;
      if (index >= 10) tailSizes.push(view.metrics.requestBytes);
      expect(view.metrics.requestBytes).toBeLessThanOrEqual(96 * 1_024);
    }
    expect(boundedBytes / legacyBytes).toBeLessThan(0.5);
    expect(Math.max(...tailSizes) - Math.min(...tailSizes)).toBeLessThan(100);
    console.info("Context byte fixture", {
      boundedBytes,
      legacyBytes,
      reduction: 1 - boundedBytes / legacyBytes,
    });
  });
});
