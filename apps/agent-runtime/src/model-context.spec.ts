import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import type { ModelMessage } from "./model-types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ContextBudgetExceeded,
  ModelContext,
  jsonBytes,
} from "./model-context.js";

const initial: ModelMessage[] = [
  { role: "system", content: "Use observed evidence." },
  { role: "user", content: "Verify every declared criterion exactly." },
];
const base = {
  model: "test",
  tools: [
    {
      type: "function",
      function: {
        name: "browser_command",
        parameters: z.toJSONSchema(runtimeActionCommandInputSchema),
      },
    },
  ],
};

function turn(context: ModelContext, index: number, content = "observed") {
  const calls = [0, 1].map((call) => ({
    type: "function" as const,
    id: `${index}-${call}`,
    function: { name: "browser_command", arguments: "{}" },
  }));
  context.completeTurn(
    {
      role: "assistant",
      content: null,
      reasoning_content: `opaque-${index}`,
      tool_calls: calls,
    },
    calls.map((call) => ({
      role: "tool",
      tool_call_id: call.id,
      content,
    })),
  );
}

describe("bounded model context", () => {
  it("selects complete DOM at the exact request budget and paginates when it no longer fits", () => {
    const complete = { snapshot: { content: '"中文😀"\\\n'.repeat(1500) } };
    const paged = { snapshot: { content: "First page", nextCursor: 10 } };
    const request = { tools: [{ description: '"tool"\\\n'.repeat(500) }] };
    const state = {
      acceptedCriteria: [{ id: "preserved", summary: "已验证" }],
    };
    const probe = new ModelContext(initial);
    for (let i = 0; i < 4; i++) turn(probe, i);
    const exactBytes = probe.build(request, state, undefined, complete).metrics
      .textRequestBytes;

    for (const maxBytes of [exactBytes, exactBytes - 1]) {
      const context = new ModelContext(initial, { maxBytes });
      for (let i = 0; i < 4; i++) turn(context, i);
      const view = context.build(request, state, undefined, complete, paged);
      expect(view.currentPage).toBe(maxBytes === exactBytes ? complete : paged);
      expect(view.metrics).toMatchObject({
        usedPageFallback: maxBytes !== exactBytes,
        retainedTurns: 4,
        compactedTurns: 0,
      });
      expect(view.metrics.textRequestBytes).toBe(
        jsonBytes({ ...request, messages: view.messages }),
      );
      expect(view.metrics.textRequestBytes).toBeLessThanOrEqual(maxBytes);
      expect(JSON.stringify(view.messages)).toContain("preserved");
    }
  });

  it("still rejects an over-budget fallback instead of silently dropping required state", () => {
    const context = new ModelContext(initial, { maxBytes: 1_000 });
    expect(() =>
      context.build(
        {},
        { required: "x".repeat(2000) },
        undefined,
        { snapshot: { content: "x".repeat(20_000) } },
        { snapshot: { content: "First page" } },
      ),
    ).toThrow(ContextBudgetExceeded);
  });

  it("only points a summary at content present in that request and demotes old refs", () => {
    const context = new ModelContext(initial);
    const page = {
      observationId: "old",
      cursor: 12,
      refState: "CURRENT",
      content: "Only in requested tail [ref=e2]",
    };
    context.completeTurn(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            type: "function",
            id: "read",
            function: { name: "read_observation", arguments: "{}" },
          },
        ],
      },
      [
        {
          role: "tool",
          tool_call_id: "read",
          content: JSON.stringify({ result: page }),
        },
      ],
    );
    const summaries = (currentPage: unknown) =>
      JSON.parse(
        String(
          context.build({}, {}, undefined, currentPage).messages[3]!.content,
        ),
      );
    expect(summaries({ snapshot: page }).turns[0][0].result.result).toEqual({
      observationId: "old",
      cursor: 12,
      refState: "CURRENT",
      contentInCurrentPage: true,
    });
    const after = summaries({
      snapshot: { observationId: "new", cursor: 0, content: "New page" },
    }).turns[0][0].result.result;
    expect(after).toMatchObject({
      refState: "HISTORICAL",
      content: page.content,
    });
    expect(after).not.toHaveProperty("contentInCurrentPage");
    expect(
      summaries({ snapshot: { ...page, cursor: 0, content: "Head" } })
        .turns[0][0].result.result.content,
    ).toBe(page.content);
  });

  it("sends one typed image outside the text budget, replacing it without retaining pixels in history", () => {
    const context = new ModelContext(initial, { maxBytes: 4_096 });
    const image = {
      artifactId: "3a6cbe48-f36c-4b48-bae1-d8d5e50f4ce0",
      observationId: "6730b25a-d1d3-4a10-a0c1-69fd4d74643a",
      capturedAt: new Date().toISOString(),
      viewport: { width: 1280, height: 720 },
      contentType: "image/jpeg" as const,
      dataBase64: Buffer.alloc(512_000, 42).toString("base64"),
    };
    const first = context.build({ model: "vision" }, {}, image);
    expect(first.metrics).toMatchObject({ imageCount: 1, imageBytes: 512_000 });
    expect(first.metrics.textRequestBytes).toBeLessThan(4_096);
    expect(first.metrics.requestBytes).toBeGreaterThan(512_000);
    expect(first.messages.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "text" },
        {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${image.dataBase64}`,
            detail: "high",
          },
        },
      ],
    });
    turn(context, 1);
    const nextImage = {
      ...image,
      dataBase64: Buffer.from("next image").toString("base64"),
    };
    const next = context.build({ model: "vision" }, {}, nextImage);
    expect(JSON.stringify(next.messages)).not.toContain(image.dataBase64);
    expect(
      JSON.stringify(next.messages).match(/"type":"image_url"/gu),
    ).toHaveLength(1);
    expect(JSON.stringify(context.build({}, {}).messages)).not.toContain(
      "image_url",
    );
  });

  it("summarizes four complete turns and keeps exact requirements and accepted state", () => {
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
    expect(view.messages.slice(0, 2)).toEqual(initial);
    expect(JSON.parse(String(view.messages[2]!.content))).toMatchObject({
      kind: "browser_working_state",
      data: state,
    });
    expect(view.metrics).toMatchObject({
      retainedTurns: 4,
      compactedTurns: 5,
      historyMode: "OPERATION_SUMMARIES",
    });
    const history = JSON.parse(String(view.messages[3]!.content));
    expect(history.kind).toBe("recent_operations");
    expect(history.turns).toHaveLength(4);
    expect(
      history.turns
        .flat()
        .map((operation: { callId: string }) => operation.callId),
    ).toEqual([5, 6, 7, 8].flatMap((index) => [`${index}-0`, `${index}-1`]));
    expect(history.turns[0][0]).toMatchObject({
      tool: "browser_command",
      outcome: "RETURNED",
      result: "observed",
    });
    expect(
      view.messages.some(
        (message) => message.role === "assistant" || message.role === "tool",
      ),
    ).toBe(false);
    expect(JSON.stringify(view.messages)).not.toContain("opaque-");
  });

  it.each([
    [],
    [{ role: "tool", tool_call_id: "orphan", content: "{}" }],
    [0, 1].map(() => ({
      role: "tool",
      tool_call_id: "call",
      content: "{}",
    })),
  ])(
    "rejects incomplete, orphaned, and duplicate replies (%#)",
    (...results) => {
      const context = new ModelContext(initial);
      expect(() =>
        context.completeTurn(
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                type: "function",
                id: "call",
                function: { name: "tool", arguments: "{}" },
              },
            ],
          },
          results as ModelMessage[],
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
      jsonBytes({ ...request, messages: view.messages }),
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
    first.messages[0]!.content = "provider mutation";
    expect(second.messages.slice(0, 2)).toEqual(initial);
    expect(context.build(base, {}).messages.slice(0, 2)).toEqual(initial);
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
    expect(view.messages).toHaveLength(initial.length + 12 * 3);
    expect(JSON.stringify(view.messages)).not.toContain(
      "browser_working_state",
    );
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
