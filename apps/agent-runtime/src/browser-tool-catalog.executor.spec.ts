import type {
  RuntimeEvidenceKind,
  RuntimeTaskLease,
} from "@devproof/agent-runtime-protocol";
import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserVerificationExecutor,
  type BrowserVerificationOptions,
} from "./browser-verification.executor.js";
import { jsonBytes } from "./model-context.js";
import { createChatCompletionsClient } from "./model-client.js";
import { browserToolGroupNames } from "./browser-tool-catalog.js";

type Request = {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<{
    function: {
      name: string;
      parameters: {
        type?: string;
        anyOf?: Array<{ properties: { commandType: { const: string } } }>;
      };
    };
  }>;
};
type Call = { name: string; args: Record<string, unknown> };
type Step = Call | Call[] | ((request: Request) => Call[]);
const browse = (
  commandType: string,
  payload: Record<string, unknown> = {},
): Call => ({ name: "browser_command", args: { commandType, payload } });
const enable = (...groups: string[]): Call => ({
  name: "enable_browser_tools",
  args: { groups },
});
const record = (evidenceRefs: string[] = []): Call => ({
  name: "record_criterion",
  args: {
    criterionId: "verified",
    status: "PASSED",
    summary: "已观察并验证目标行为。",
    evidenceRefs,
  },
});
const finish: Call = {
  name: "finish_verification",
  args: { verdict: "PASSED", summary: "验证完成。" },
};
const human: Call = {
  name: "request_human_input",
  args: { prompt: "请完成访问确认。", summary: "等待人工确认。" },
};
const names = (request: Request) =>
  request.tools
    .find((tool) => tool.function.name === "browser_command")!
    .function.parameters.anyOf!.map(
      (variant) => variant.properties.commandType.const,
    );
const feedback = (request: Request, step: number, call = 0) =>
  JSON.parse(
    String(
      request.messages.find(
        (item) =>
          item.role === "tool" && item.tool_call_id === `call-${step}-${call}`,
      )!.content,
    ),
  );

function harness(
  script: Step[],
  options: BrowserVerificationOptions = {},
  requiredEvidenceKinds: RuntimeEvidenceKind[] = [],
) {
  const task: RuntimeTaskLease = {
    taskId: "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0",
    fencingToken: "4",
    leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    snapshot: {
      attemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
      attemptNumber: 1,
      runId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
      teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
      traceId: "1234567890abcdef1234567890abcdef",
      businessReferences: [],
      criteria: [
        {
          id: "verified",
          description: "Verify the observed browser behavior.",
          required: true,
          requiredEvidenceKinds,
        },
      ],
      goal: "Verify the page.",
      environment: {},
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      executionPolicy: {},
      modelCandidates: [
        {
          apiKey: "sk-test",
          baseUrl: "https://gateway.example.com/v1",
          displayName: "Test",
          modelId: "test-model",
        },
      ],
    },
  };
  const lease = {
    taskId: task.taskId,
    fencingToken: task.fencingToken,
    leaseToken: task.leaseToken,
    workerId: "worker-test",
  };
  const requests: Request[] = [];
  const create = vi.fn().mockImplementation(async (request: Request) => {
    const index = requests.length;
    requests.push(structuredClone(request));
    const step = script[index];
    if (!step) throw new Error(`Unexpected model request ${index}`);
    const calls =
      typeof step === "function"
        ? step(request)
        : Array.isArray(step)
          ? step
          : [step];
    return {
      id: `response-${index}`,
      message: {
        role: "assistant" as const,
        content: null,
        tool_calls: calls.map((call, callIndex) => ({
          type: "function" as const,
          id: `call-${index}-${callIndex}`,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
    };
  });
  const controlPlane = {
    acquireBrowser: vi.fn().mockResolvedValue({
      browserExecutionId: "ab91fa7b-afd8-42be-982b-e860de0fca67",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      fencingToken: "5",
      leaseId: "b9af89f9-2f36-498b-a626-6df0af16d815",
      runnerId: "d1b7bc2c-18c6-4fc8-a2eb-ec4474ddf072",
      runnerKind: "BROWSER",
      status: "ACQUIRED",
    }),
    appendEvent: vi.fn().mockResolvedValue({}),
    browserCommand: vi.fn().mockImplementation(async (_lease, command) => ({
      status: "SUCCEEDED",
      result: { content: JSON.stringify(command.payload) },
    })),
    releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
  };
  const executor = new BrowserVerificationExecutor(
    () => ({ complete: create }),
    controlPlane as never,
    60,
    options,
  );
  return {
    task,
    lease,
    requests,
    create,
    controlPlane,
    executor,
    run: () => executor.execute(task, lease, new AbortController().signal),
  };
}

describe("browser tool module execution", () => {
  it.each(["GROUPED", "LEGACY"] as const)(
    "sends object-root function parameters to a Kimi-compatible chat endpoint in %s mode",
    async (toolSurfaceMode) => {
      const fixture = harness(
        [
          ...(toolSurfaceMode === "GROUPED"
            ? [enable(...browserToolGroupNames)]
            : []),
          browse("page.snapshot"),
          human,
        ],
        { toolSurfaceMode },
      );
      fixture.task.snapshot.modelCandidates![0]!.modelId = "kimi-k3";
      const modelFetch = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url, init) => {
          expect(String(url)).toBe(
            "https://gateway.example.com/v1/chat/completions",
          );
          const request = JSON.parse(String(init?.body)) as Request;
          // Reproduce the provider's request validation against the real tool catalog.
          if (
            request.tools.some(
              (tool) => tool.function.parameters.type !== "object",
            )
          ) {
            return new Response(
              JSON.stringify({
                error: {
                  message:
                    'Invalid request: tools.function.parameters.type is required and must be "object"',
                },
              }),
              { status: 400, headers: { "content-type": "application/json" } },
            );
          }
          const completion = await fixture.create(request);
          return new Response(
            JSON.stringify({
              id: completion.id,
              choices: [
                {
                  index: 0,
                  finish_reason: "tool_calls",
                  message: completion.message,
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        });
      const executor = new BrowserVerificationExecutor(
        (candidate) => createChatCompletionsClient(candidate, modelFetch),
        fixture.controlPlane as never,
        60,
        { toolSurfaceMode },
      );
      expect(
        await executor.execute(
          fixture.task,
          fixture.lease,
          new AbortController().signal,
        ),
      ).toMatchObject({ kind: "WAITING_HUMAN" });
      expect(modelFetch).toHaveBeenCalledTimes(
        toolSurfaceMode === "GROUPED" ? 3 : 2,
      );
      expect(names(fixture.requests[0]!)).toHaveLength(
        toolSurfaceMode === "GROUPED" ? 15 : 39,
      );
      expect(names(fixture.requests.at(-1)!)).toHaveLength(
        toolSurfaceMode === "GROUPED" ? 38 : 39,
      );
    },
  );

  it("completes a core form without discovery and advertises less than 60% of legacy tool bytes", async () => {
    const script = [
      browse("page.navigate", { url: "https://example.com/form" }),
      browse("page.fill", { target: { selector: "#name" }, text: "Test" }),
      browse("page.check", { target: { selector: "#agree" } }),
      browse("page.press", { target: { selector: "#name" }, key: "Enter" }),
      record(),
      finish,
    ];
    const grouped = harness(script);
    const legacy = harness(script, { toolSurfaceMode: "LEGACY" });
    expect(await grouped.run()).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "PASSED",
    });
    expect(await legacy.run()).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "PASSED",
    });
    const groupedTools = jsonBytes(grouped.requests[0]!.tools);
    const legacyTools = jsonBytes(legacy.requests[0]!.tools);
    expect(groupedTools / legacyTools).toBeLessThanOrEqual(0.6);
    expect(names(grouped.requests[0]!)).toHaveLength(15);
    expect(names(legacy.requests[0]!)).toHaveLength(39);
    expect(
      grouped.controlPlane.browserCommand.mock.calls.map((call) =>
        call.slice(0, 2),
      ),
    ).toEqual(
      legacy.controlPlane.browserCommand.mock.calls.map((call) =>
        call.slice(0, 2),
      ),
    );
    expect(grouped.create).toHaveBeenCalledTimes(
      legacy.create.mock.calls.length,
    );
    console.info("Core tool surface fixture", {
      groupedTools,
      legacyTools,
      groupedRequestBytes: grouped.requests.reduce(
        (sum, request) => sum + jsonBytes(request),
        0,
      ),
      legacyRequestBytes: legacy.requests.reduce(
        (sum, request) => sum + jsonBytes(request),
        0,
      ),
    });
  });

  it("keeps enable calls local and requires the next model round before using the new schema", async () => {
    const fixture = harness([
      browse("page.type", {
        target: { selector: "#search" },
        text: "query",
        delayMs: 30,
      }),
      [
        enable("input"),
        browse("page.type", {
          target: { selector: "#search" },
          text: "query",
          delayMs: 30,
        }),
      ],
      (request) => {
        expect(feedback(request, 0)).toMatchObject({
          code: "TOOL_GROUP_REQUIRED",
          requiredGroup: "input",
        });
        expect(feedback(request, 1, 0)).toEqual({ enabledGroups: ["input"] });
        expect(feedback(request, 1, 1)).toMatchObject({
          code: "TOOL_GROUP_REQUIRED",
          requiredGroup: "input",
        });
        expect(names(request)).toContain("page.type");
        return [
          browse("page.type", {
            target: { selector: "#search" },
            text: "query",
            delayMs: 30,
          }),
        ];
      },
      record(),
      finish,
    ]);
    expect(await fixture.run()).toMatchObject({ verdict: "PASSED" });
    expect(fixture.controlPlane.browserCommand).toHaveBeenCalledExactlyOnceWith(
      fixture.lease,
      runtimeActionCommandInputSchema.parse({
        commandType: "page.type",
        payload: {
          target: { selector: "#search" },
          text: "query",
          delayMs: 30,
        },
      }),
      expect.any(AbortSignal),
    );
    expect(fixture.controlPlane.acquireBrowser).toHaveBeenCalledOnce();
  });

  it("retains active modules after their enable turn is compacted", async () => {
    const fixture = harness([
      enable("input"),
      ...Array.from({ length: 6 }, (_, index) =>
        browse("page.get_text", { target: { selector: `#row-${index}` } }),
      ),
      (request) => {
        expect(
          request.messages.some((item) => item.tool_call_id === "call-0-0"),
        ).toBe(false);
        expect(names(request)).toContain("page.type");
        return [
          browse("page.type", {
            target: { selector: "#search" },
            text: "query",
          }),
        ];
      },
      record(),
      finish,
    ]);
    expect(await fixture.run()).toMatchObject({ verdict: "PASSED" });
    expect(
      fixture.controlPlane.browserCommand.mock.calls.at(-1)![1],
    ).toMatchObject({ commandType: "page.type" });
  });

  it("preserves tab and iframe payloads, accounting for the discovery round", async () => {
    const actions = [
      browse("tab.new", { url: "https://example.com/editor" }),
      browse("tab.switch", { index: 0 }),
      browse("frame.snapshot", { frame: { selector: "#editor" } }),
      browse("frame.fill", {
        frame: { selector: "#editor" },
        target: { selector: "#name" },
        text: "Test",
      }),
      browse("tab.close"),
    ];
    const grouped = harness([
      enable("tabs", "frames"),
      ...actions,
      record(),
      finish,
    ]);
    const legacy = harness([...actions, record(), finish], {
      toolSurfaceMode: "LEGACY",
    });
    expect(await grouped.run()).toMatchObject({ verdict: "PASSED" });
    expect(await legacy.run()).toMatchObject({ verdict: "PASSED" });
    expect(
      grouped.controlPlane.browserCommand.mock.calls.map((call) =>
        call.slice(0, 2),
      ),
    ).toEqual(
      legacy.controlPlane.browserCommand.mock.calls.map((call) =>
        call.slice(0, 2),
      ),
    );
    expect(grouped.create.mock.calls.length).toBe(
      legacy.create.mock.calls.length + 1,
    );
    expect(grouped.controlPlane.browserCommand).toHaveBeenCalledTimes(5);
    console.info("Optional module fixture", {
      groupedRounds: grouped.requests.length,
      legacyRounds: legacy.requests.length,
      groupedRequestBytes: grouped.requests.reduce(
        (sum, request) => sum + jsonBytes(request),
        0,
      ),
      legacyRequestBytes: legacy.requests.reduce(
        (sum, request) => sum + jsonBytes(request),
        0,
      ),
    });
  });

  it.each(["NETWORK", "CONSOLE"] as const)(
    "automatically exposes required %s evidence while keeping fault injection inactive",
    async (kind) => {
      const commandType = kind === "NETWORK" ? "page.network" : "page.console";
      const payload =
        kind === "NETWORK"
          ? { includeResponseBodies: true, urlIncludes: "/api/orders" }
          : {};
      const fixture = harness(
        [browse(commandType, payload), record(["artifact://proof"]), finish],
        {},
        [kind],
      );
      fixture.controlPlane.browserCommand.mockResolvedValue({
        status: "SUCCEEDED",
        result: { content: "证据内容" },
        artifacts: [{ id: "proof", kind }],
      });
      expect(await fixture.run()).toMatchObject({
        verdict: "PASSED",
        evidence: [{ externalId: "artifact://proof", kind }],
      });
      expect(names(fixture.requests[0]!)).toContain(commandType);
      expect(names(fixture.requests[0]!)).not.toContain("network.arm");
      expect(
        fixture.controlPlane.browserCommand,
      ).toHaveBeenCalledExactlyOnceWith(
        fixture.lease,
        runtimeActionCommandInputSchema.parse({ commandType, payload }),
        expect.any(AbortSignal),
      );
    },
  );

  it("keeps network arm, wait, status, and release semantics after enabling", async () => {
    const actions = [
      browse("network.arm", {
        action: "ABORT",
        policyId: "fault-1",
        urlPattern: "**/api/orders",
      }),
      browse("network.wait_for_hit", { policyId: "fault-1", timeoutMs: 100 }),
      browse("network.status", { policyId: "fault-1" }),
      browse("network.release", { policyId: "fault-1" }),
    ];
    const fixture = harness([
      enable("network_faults"),
      ...actions,
      record(),
      finish,
    ]);
    expect(await fixture.run()).toMatchObject({ verdict: "PASSED" });
    expect(
      fixture.controlPlane.browserCommand.mock.calls.map((call) => call[1]),
    ).toEqual(
      actions.map((action) =>
        runtimeActionCommandInputSchema.parse(action.args),
      ),
    );
  });

  it("validates active payloads and keeps Runtime rejection distinct from discovery and platform commands", async () => {
    const fixture = harness([
      enable("viewport", "diagnostics"),
      browse("page.resize", { width: 800, height: 600 }),
      browse("page.network", { includeResponseBodies: true }),
      browse("session.close"),
      browse("page.invented"),
      browse("page.open", { url: "https://example.com" }),
      human,
    ]);
    fixture.controlPlane.browserCommand.mockResolvedValue({
      status: "FAILED",
      error: {
        code: "UNSUPPORTED_COMMAND",
        message: "This Runtime does not support the command.",
        retryable: false,
      },
    });
    expect(await fixture.run()).toMatchObject({ kind: "WAITING_HUMAN" });
    expect(feedback(fixture.requests[2]!, 1)).toMatchObject({
      status: "FAILED",
      error: { code: "UNSUPPORTED_COMMAND" },
    });
    expect(feedback(fixture.requests[3]!, 2)).toMatchObject({
      code: "INVALID_ARGUMENTS",
      issues: [{ path: "payload.urlIncludes" }],
    });
    expect(feedback(fixture.requests[4]!, 3)).toMatchObject({
      code: "COMMAND_NOT_ALLOWED",
    });
    expect(feedback(fixture.requests[5]!, 4)).toMatchObject({
      code: "UNKNOWN_COMMAND",
    });
    expect(feedback(fixture.requests[6]!, 5)).toMatchObject({
      code: "INVALID_ARGUMENTS",
      suggestions: ["page.navigate"],
    });
    expect(fixture.controlPlane.browserCommand).toHaveBeenCalledOnce();
  });

  it("keeps locator recovery tokens and the recovery snapshot after module activation", async () => {
    const fixture = harness([
      enable("frames"),
      browse("frame.click", {
        frame: { selector: "#editor" },
        target: { selector: "button" },
      }),
      (request) => {
        const recovery = feedback(request, 1).locatorRecovery;
        expect(recovery.snapshot.result.content).toContain("[ref=f1e42]");
        return [
          {
            name: "browser_command",
            args: {
              commandType: "frame.click",
              payload: {
                frame: { selector: "#editor" },
                target: { ref: "f1e42" },
              },
              locatorRecoveryToken: recovery.recoveryToken,
            },
          },
        ];
      },
      record(),
      finish,
    ]);
    fixture.controlPlane.browserCommand.mockImplementation(
      async (_lease, command) => {
        if (command.commandType === "frame.snapshot")
          return {
            status: "SUCCEEDED",
            result: { content: '- button "Target" [ref=f1e42]\n' },
          };
        if (command.payload.target.selector)
          return {
            status: "FAILED",
            error: {
              code: "LOCATOR_AMBIGUOUS",
              message: "Two matches.",
              recoveryAction: "RESNAPSHOT_AND_RETARGET",
            },
          };
        return { status: "SUCCEEDED" };
      },
    );
    expect(await fixture.run()).toMatchObject({ verdict: "PASSED" });
    expect(
      fixture.controlPlane.browserCommand.mock.calls.map(
        (call) => call[1].commandType,
      ),
    ).toEqual(["frame.click", "frame.snapshot", "frame.click"]);
    const stateItem = fixture.requests[3]!.messages.find(
      (item) =>
        typeof item.content === "string" &&
        item.content.startsWith('{"kind":"browser_working_state"'),
    )!;
    expect(
      JSON.parse(String(stateItem.content)).data.locatorRecovery,
    ).toBeNull();
  });

  it("keeps enabled schemas identical across fallback even if a provider mutates its request", async () => {
    const fixture = harness([
      enable("tabs"),
      (request) => {
        expect(names(request)).toContain("tab.new");
        request.tools.splice(0);
        request.messages.splice(0);
        throw new Error("primary unavailable");
      },
      human,
    ]);
    fixture.task.snapshot.modelCandidates!.push({
      ...fixture.task.snapshot.modelCandidates![0]!,
      modelId: "fallback-model",
    });
    expect(await fixture.run()).toMatchObject({ kind: "WAITING_HUMAN" });
    expect(names(fixture.requests[1]!)).toContain("tab.new");
    expect(fixture.requests[2]!.tools).toEqual(fixture.requests[1]!.tools);
    expect(fixture.requests[2]!.messages).toEqual(
      fixture.requests[1]!.messages,
    );
    expect(fixture.controlPlane.browserCommand).not.toHaveBeenCalled();
  });

  it("resets optional modules on a new segment after HITL", async () => {
    const fixture = harness([
      enable("tabs"),
      human,
      browse("tab.list"),
      (request) => {
        expect(names(request)).not.toContain("tab.list");
        expect(feedback(request, 2)).toMatchObject({
          code: "TOOL_GROUP_REQUIRED",
          requiredGroup: "tabs",
        });
        return [human];
      },
    ]);
    expect(await fixture.run()).toMatchObject({ kind: "WAITING_HUMAN" });
    const resumed = structuredClone(fixture.task);
    resumed.snapshot.executionPolicy.resume = { response: { approved: true } };
    expect(
      await fixture.executor.execute(
        resumed,
        { ...fixture.lease, fencingToken: "5" },
        new AbortController().signal,
      ),
    ).toMatchObject({ kind: "WAITING_HUMAN" });
    expect(fixture.controlPlane.browserCommand).not.toHaveBeenCalled();
  });

  it("bounds repeated enables by the existing tool-call limit without browser execution", async () => {
    const fixture = harness([
      enable("tabs"),
      enable("tabs"),
      enable("tabs"),
      enable("tabs"),
      enable("tabs"),
    ]);
    const executor = new BrowserVerificationExecutor(
      () => ({ complete: fixture.create }),
      fixture.controlPlane as never,
      5,
    );
    expect(
      await executor.execute(
        fixture.task,
        fixture.lease,
        new AbortController().signal,
      ),
    ).toMatchObject({
      kind: "FATAL_FAILURE",
      executionDisposition: "NOT_RUN",
      error: { code: "AGENT_TOOL_LIMIT_EXCEEDED" },
    });
    expect(feedback(fixture.requests[2]!, 1)).toEqual({
      enabledGroups: ["tabs"],
    });
    expect(fixture.controlPlane.browserCommand).not.toHaveBeenCalled();
    expect(fixture.controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it("rejects an invalid group list without partially activating valid names", async () => {
    const fixture = harness([
      enable("tabs", "made_up"),
      (request) => {
        expect(feedback(request, 0)).toMatchObject({
          code: "INVALID_ARGUMENTS",
        });
        expect(names(request)).not.toContain("tab.list");
        return [browse("tab.list")];
      },
      (request) => {
        expect(feedback(request, 1)).toMatchObject({
          code: "TOOL_GROUP_REQUIRED",
          requiredGroup: "tabs",
        });
        return [human];
      },
    ]);
    expect(await fixture.run()).toMatchObject({ kind: "WAITING_HUMAN" });
    expect(fixture.controlPlane.browserCommand).not.toHaveBeenCalled();
  });

  it("supports grouped discovery with legacy history and restores the alias in legacy tool mode", async () => {
    const grouped = harness(
      [
        enable("input"),
        browse("page.type", { target: { selector: "#search" }, text: "query" }),
        record(),
        finish,
      ],
      { mode: "LEGACY" },
    );
    expect(await grouped.run()).toMatchObject({ verdict: "PASSED" });
    expect(
      grouped.requests[0]!.tools.some(
        (tool) => tool.function.name === "read_observation",
      ),
    ).toBe(false);
    expect(names(grouped.requests[1]!)).toContain("page.type");

    const legacy = harness(
      [browse("page.open", { url: "https://example.com" }), record(), finish],
      { toolSurfaceMode: "LEGACY" },
    );
    expect(await legacy.run()).toMatchObject({ verdict: "PASSED" });
    expect(
      legacy.requests[0]!.tools.some(
        (tool) => tool.function.name === "enable_browser_tools",
      ),
    ).toBe(false);
    expect(legacy.controlPlane.browserCommand.mock.calls[0]![1]).toMatchObject({
      commandType: "page.open",
    });
  });
});
