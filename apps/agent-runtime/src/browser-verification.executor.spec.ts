import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskLease } from "@devproof/agent-runtime-protocol";

import { BrowserVerificationExecutor } from "./browser-verification.executor.js";
import { jsonBytes } from "./model-context.js";

afterEach(() => vi.useRealTimers());

const task: RuntimeTaskLease = {
  fencingToken: "4",
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
  snapshot: {
    attemptId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
    attemptNumber: 2,
    businessReferences: [],
    criteria: [
      {
        description: "The page is visible.",
        id: "page-visible",
        required: true,
        requiredEvidenceKinds: [],
      },
    ],
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    environment: {},
    executionPolicy: {},
    goal: "Verify the page.",
    modelCandidates: [
      {
        apiKey: "sk-test-model-secret",
        baseUrl: "https://gateway.example.com/v1",
        displayName: "Test model",
        modelId: "gpt-test",
      },
    ],
    runId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
    teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
    traceId: "1234567890abcdef1234567890abcdef",
  },
  taskId: "9be3dc23-9a52-4a97-b6ca-7abbbcc4e1d0",
};

const lease = {
  fencingToken: task.fencingToken,
  leaseToken: task.leaseToken,
  taskId: task.taskId,
  workerId: "worker-1",
};

const acquiredBrowser = {
  browserExecutionId: "ab91fa7b-afd8-42be-982b-e860de0fca67",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  fencingToken: "5",
  leaseId: "b9af89f9-2f36-498b-a626-6df0af16d815",
  runnerId: "d1b7bc2c-18c6-4fc8-a2eb-ec4474ddf072",
  runnerKind: "BROWSER" as const,
  status: "ACQUIRED" as const,
};

function functionCall(
  name: string,
  argumentsValue: Record<string, unknown>,
  index: number,
) {
  return {
    arguments: JSON.stringify(argumentsValue),
    call_id: `call-${index}`,
    name,
    type: "function_call" as const,
  };
}

function modelFactory(create: ReturnType<typeof vi.fn>) {
  return () => ({ responses: { create } }) as never;
}

function convergenceHarness(create: ReturnType<typeof vi.fn>) {
  const controlPlane = {
    acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
    appendEvent: vi.fn().mockResolvedValue({}),
    browserCommand: vi.fn().mockResolvedValue({
      status: "SUCCEEDED",
      result: { content: "页面加载中" },
    }),
    releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
  };
  const runTask: RuntimeTaskLease = {
    ...task,
    snapshot: {
      ...structuredClone(task.snapshot),
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      executionPolicy: {
        deadline: {
          mode: "ADAPTIVE",
          finalizationReserveSeconds: 60,
          maxModelCallSeconds: 300,
        },
      },
    },
  };
  const executor = new BrowserVerificationExecutor(
    modelFactory(create),
    controlPlane as never,
    60,
  );
  return { controlPlane, runTask, executor };
}

describe("runtime navigation and combined finalization", () => {
  const criterion = {
    criterionId: "page-visible",
    status: "PASSED",
    summary: "页面可见。",
    evidenceRefs: ["artifact://proof"],
  };
  const finish = (criteria = [criterion]) => ({
    id: "finish",
    output: [
      functionCall(
        "finish_verification",
        {
          verdict: "PASSED",
          summary: "验证完成。",
          criteria,
        },
        2,
      ),
    ],
  });

  it("delivers actual image parts to the model, replaces stale images, and omits bytes from traces", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "observe",
        output: [
          functionCall(
            "browser_command",
            { commandType: "page.snapshot", payload: {} },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce(finish());
    const { runTask, controlPlane, executor } = convergenceHarness(create);
    runTask.snapshot.environment = { targetUrl: "https://example.com" };
    const visual = (bytes: string) => ({
      artifactId: "3a6cbe48-f36c-4b48-bae1-d8d5e50f4ce0",
      observationId: "6730b25a-d1d3-4a10-a0c1-69fd4d74643a",
      capturedAt: new Date().toISOString(),
      viewport: { width: 1280, height: 720 },
      contentType: "image/jpeg",
      dataBase64: Buffer.from(bytes).toString("base64"),
    });
    const first = visual("first private screenshot");
    const second = visual("second private screenshot");
    controlPlane.browserCommand
      .mockResolvedValueOnce({
        status: "SUCCEEDED",
        visualObservation: first,
        result: { url: "https://example.com" },
      })
      .mockResolvedValueOnce({
        status: "SUCCEEDED",
        visualObservation: second,
        result: { content: '- <div> "页面可见" [ref=f1e1]' },
        artifacts: [{ id: "proof", kind: "SCREENSHOT" }],
      });
    expect(
      await executor.execute(runTask, lease, new AbortController().signal),
    ).toMatchObject({ kind: "VERIFICATION_COMPLETED", verdict: "PASSED" });
    const requests = create.mock.calls.map((call) => call[0]);
    expect(requests[0].input.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "input_text" },
        {
          type: "input_image",
          image_url: `data:image/jpeg;base64,${first.dataBase64}`,
        },
      ],
    });
    expect(requests[1].input.at(-1)).toMatchObject({
      role: "user",
      content: [
        { type: "input_text" },
        {
          type: "input_image",
          image_url: `data:image/jpeg;base64,${second.dataBase64}`,
        },
      ],
    });
    expect(JSON.stringify(requests[1])).not.toContain(first.dataBase64);
    const traces = JSON.stringify(controlPlane.appendEvent.mock.calls);
    expect(traces).not.toContain(first.dataBase64);
    expect(traces).not.toContain(second.dataBase64);
    expect(
      controlPlane.acquireBrowser.mock.calls[0]![1].requiredCapabilities,
    ).toContain("dom-vision-v1");
  });

  it("navigates the exact task URL before the model and accepts evidence with the final result", async () => {
    const url =
      "https://example.com/form?trial=57a0c843-9959-4d3c-be24-931b8a7ed37e";
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "observe",
        output: [
          functionCall(
            "browser_command",
            { commandType: "page.dom", payload: {} },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce(finish());
    const { runTask, controlPlane, executor } = convergenceHarness(create);
    runTask.snapshot.environment = { targetUrl: url };
    runTask.snapshot.criteria[0] = {
      ...runTask.snapshot.criteria[0]!,
      requiredEvidenceKinds: ["DOM"],
    };
    controlPlane.browserCommand
      .mockResolvedValueOnce({ status: "SUCCEEDED", result: { url } })
      .mockResolvedValueOnce({
        status: "SUCCEEDED",
        artifacts: [{ id: "proof", kind: "DOM" }],
      });
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "PASSED",
      criteria: [criterion],
    });
    expect(controlPlane.browserCommand.mock.calls[0]![1]).toEqual({
      commandType: "page.navigate",
      payload: { url },
    });
    expect(
      controlPlane.browserCommand.mock.invocationCallOrder[0],
    ).toBeLessThan(create.mock.invocationCallOrder[0]!);
    const bootstrap = create.mock.calls[0]![0].input.find(
      (item: Record<string, unknown>) =>
        typeof item.content === "string" &&
        item.content.includes('"kind":"runtime_initial_navigation"'),
    );
    expect(JSON.parse(bootstrap.content)).toMatchObject({
      command: { payload: { url } },
      result: { status: "SUCCEEDED" },
    });
    expect(controlPlane.browserCommand).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it("preserves the current page on human resume even when a target URL exists", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "human",
      output: [
        functionCall(
          "request_human_input",
          { prompt: "请确认接管状态。", summary: "等待人工确认。" },
          1,
        ),
      ],
    });
    const { runTask, controlPlane, executor } = convergenceHarness(create);
    runTask.snapshot.environment = { targetUrl: "https://example.com" };
    runTask.snapshot.executionPolicy.resume = {
      interventionId: "resume-1",
      response: {},
    };
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("WAITING_HUMAN");
    expect(controlPlane.browserCommand).not.toHaveBeenCalled();
    expect(controlPlane.releaseBrowser).not.toHaveBeenCalled();
  });

  it("exposes a failed initial navigation instead of claiming the page loaded", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "finish",
      output: [
        functionCall(
          "finish_verification",
          {
            verdict: "INCONCLUSIVE",
            summary: "目标页面未能加载。",
            criteria: [
              { ...criterion, status: "INCONCLUSIVE", evidenceRefs: [] },
            ],
          },
          1,
        ),
      ],
    });
    const { runTask, controlPlane, executor } = convergenceHarness(create);
    runTask.snapshot.environment = { targetUrl: "https://example.com" };
    controlPlane.browserCommand.mockRejectedValue(
      new Error("navigation timeout"),
    );
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ verdict: "INCONCLUSIVE" });
    const bootstrap = create.mock.calls[0]![0].input.find(
      (item: Record<string, unknown>) =>
        typeof item.content === "string" &&
        item.content.includes('"kind":"runtime_initial_navigation"'),
    );
    expect(JSON.parse(bootstrap.content).result).toMatchObject({
      accepted: false,
      error: "navigation timeout",
    });
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it("releases the browser when cancelled during initial navigation", async () => {
    const controller = new AbortController();
    const create = vi.fn();
    const { runTask, controlPlane, executor } = convergenceHarness(create);
    runTask.snapshot.environment = { targetUrl: "https://example.com" };
    controlPlane.browserCommand.mockImplementation(async () => {
      controller.abort(new Error("cancel bootstrap"));
      throw controller.signal.reason;
    });
    await expect(
      executor.execute(runTask, lease, controller.signal),
    ).rejects.toThrow("cancel bootstrap");
    expect(create).not.toHaveBeenCalled();
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it.each([
    ["unknown criterion", [{ ...criterion, criterionId: "unknown" }]],
    [
      "unknown evidence",
      [{ ...criterion, evidenceRefs: ["artifact://missing"] }],
    ],
    ["missing required evidence", [{ ...criterion, evidenceRefs: [] }]],
    ["duplicate criterion", [criterion, criterion]],
    ["non-Chinese summary", [{ ...criterion, summary: "Page visible." }]],
  ])("rejects a combined result with %s", async (_label, criteria) => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "observe",
        output: [
          functionCall(
            "browser_command",
            { commandType: "page.dom", payload: {} },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce(finish(criteria))
      .mockResolvedValueOnce(finish());
    const { runTask, controlPlane, executor } = convergenceHarness(create);
    runTask.snapshot.criteria[0] = {
      ...runTask.snapshot.criteria[0]!,
      requiredEvidenceKinds: ["DOM"],
    };
    controlPlane.browserCommand.mockResolvedValue({
      status: "SUCCEEDED",
      artifacts: [{ id: "proof", kind: "DOM" }],
    });
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ verdict: "PASSED" });
    const rejection = create.mock.calls[2]![0].input.find(
      (item: Record<string, unknown>) =>
        item.type === "function_call_output" && item.call_id === "call-2",
    );
    expect(JSON.parse(rejection.output).accepted).toBe(false);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("does not partially accept an invalid combined submission", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "observe",
        output: [
          functionCall(
            "browser_command",
            { commandType: "page.dom", payload: {} },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce(
        finish([criterion, { ...criterion, criterionId: "unknown" }]),
      )
      .mockResolvedValueOnce({
        id: "empty-finish",
        output: [
          functionCall(
            "finish_verification",
            { verdict: "PASSED", summary: "验证完成。" },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce(finish());
    const { runTask, controlPlane, executor } = convergenceHarness(create);
    controlPlane.browserCommand.mockResolvedValue({
      status: "SUCCEEDED",
      artifacts: [{ id: "proof", kind: "DOM" }],
    });
    await executor.execute(runTask, lease, new AbortController().signal);
    const rejection = create.mock.calls[3]![0].input.find(
      (item: Record<string, unknown>) =>
        item.type === "function_call_output" && item.call_id === "call-3",
    );
    expect(JSON.parse(rejection.output)).toMatchObject({ accepted: false });
    expect(rejection.output).toContain("page-visible");
  });

  it("retains the locator-recovery guard in combined finalization", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "click",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              payload: { target: { selector: "button" } },
            },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "wrong-finish",
        output: [
          functionCall(
            "finish_verification",
            {
              verdict: "FAILED",
              summary: "产品操作失败。",
              criteria: [{ ...criterion, status: "FAILED", evidenceRefs: [] }],
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "finish",
        output: [
          functionCall(
            "finish_verification",
            {
              verdict: "INCONCLUSIVE",
              summary: "定位仍不明确。",
              criteria: [
                { ...criterion, status: "INCONCLUSIVE", evidenceRefs: [] },
              ],
            },
            3,
          ),
        ],
      });
    const { runTask, controlPlane, executor } = convergenceHarness(create);
    controlPlane.browserCommand.mockResolvedValueOnce({
      status: "FAILED",
      error: { code: "LOCATOR_AMBIGUOUS", message: "multiple buttons" },
    });
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ verdict: "INCONCLUSIVE" });
    const rejection = create.mock.calls[2]![0].input.find(
      (item: Record<string, unknown>) =>
        item.type === "function_call_output" && item.call_id === "call-2",
    );
    expect(rejection.output).toContain("LOCATOR_AMBIGUOUS");
  });

  it.each([false, true])(
    "records HTTP attempt metadata on model completion/failure (%s)",
    async (fails) => {
      const create = vi.fn().mockImplementation(async (_request, options) => {
        options.onRequestAttempt({
          attempt: 1,
          startedAt: Date.now() - 20,
          durationMs: 20,
          status: fails ? 400 : 200,
          outcome: "RESPONSE",
        });
        if (fails) throw new Error("provider failed");
        return {
          id: "human",
          output: [
            functionCall(
              "request_human_input",
              { prompt: "请确认状态。", summary: "等待确认。" },
              1,
            ),
          ],
        };
      });
      const { runTask, controlPlane, executor } = convergenceHarness(create);
      const execution = executor.execute(
        runTask,
        lease,
        new AbortController().signal,
      );
      if (fails) await expect(execution).rejects.toThrow("provider failed");
      else await execution;
      const event = controlPlane.appendEvent.mock.calls.find(
        (call) =>
          call[1] === (fails ? "agent.model.failed" : "agent.model.completed"),
      );
      expect(event![2].inputPreview.transport).toMatchObject({
        attemptCount: 1,
        retryCount: 0,
        attempts: [{ durationMs: 20, status: fails ? 400 : 200 }],
      });
      expect(create.mock.calls[0]![0]).not.toHaveProperty("transport");
    },
  );
});

describe("browser verification bounded context", () => {
  type Request = {
    input: Array<Record<string, unknown>>;
    tools: Array<Record<string, unknown>>;
    model: string;
  };
  const state = (request: Request) => {
    const item = request.input.find(
      (item) =>
        item.role === "user" &&
        typeof item.content === "string" &&
        item.content.startsWith('{"kind":"browser_working_state"'),
    )!;
    return JSON.parse(String(item.content)).data;
  };
  const output = (request: Request, id: number) =>
    JSON.parse(
      String(
        request.input.find(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === `call-${id}`,
        )!.output,
      ),
    );

  it("recovers an early value after compaction and retains accepted evidence without extra browser work", async () => {
    let index = 0;
    let observationId = "";
    const originalRequests: Request[] = [];
    const snapshots: Request[] = [];
    const create = vi.fn().mockImplementation(async (request: Request) => {
      originalRequests.push(request);
      snapshots.push(structuredClone(request));
      expect(jsonBytes(request)).toBeLessThanOrEqual(96 * 1_024);
      const step = index++;
      let name = "browser_command";
      let args: Record<string, unknown>;
      if (step === 0) args = { commandType: "page.snapshot", payload: {} };
      else if (step === 1) {
        observationId = output(request, 0).result.observationId;
        name = "record_criterion";
        args = {
          criterionId: "page-visible",
          status: "PASSED",
          summary: "订单编号已经显示。",
          evidenceRefs: ["artifact://proof"],
        };
      } else if (step < 8)
        args = {
          commandType: "page.get_text",
          payload: { target: { selector: `#step-${step}` } },
        };
      else if (step === 8) {
        expect(request.input.some((item) => item.call_id === "call-0")).toBe(
          false,
        );
        expect(JSON.stringify(request)).not.toContain("PO-00042");
        expect(state(request)).toMatchObject({
          acceptedCriteria: [
            {
              criterionId: "page-visible",
              status: "PASSED",
              evidenceRefs: ["artifact://proof"],
            },
          ],
          unresolvedCriterionIds: ["order-copy"],
          evidence: [{ externalId: "artifact://proof", kind: "SCREENSHOT" }],
        });
        expect(state(request).observations).toContainEqual(
          expect.objectContaining({
            observationId,
            commandType: "page.snapshot",
            availability: "AVAILABLE",
          }),
        );
        name = "read_observation";
        args = { observationId };
      } else if (step === 9) {
        const order = String(output(request, 8).result.content).match(
          /PO-\d+/u,
        )![0];
        args = {
          commandType: "page.fill",
          payload: { target: { selector: "#order" }, text: order },
        };
      } else if (step === 10) {
        name = "record_criterion";
        args = {
          criterionId: "order-copy",
          status: "PASSED",
          summary: "已按观察到的编号填写订单。",
          evidenceRefs: [],
        };
      } else {
        name = "finish_verification";
        args = { verdict: "PASSED", summary: "订单验证完成。" };
      }
      return {
        id: `response-${step}`,
        output: [functionCall(name, args, step)],
      };
    });
    const { runTask, controlPlane } = convergenceHarness(create);
    runTask.snapshot.criteria = [
      { ...task.snapshot.criteria[0]!, requiredEvidenceKinds: ["SCREENSHOT"] },
      {
        id: "order-copy",
        description: "Copy the observed order number.",
        required: true,
        requiredEvidenceKinds: [],
      },
    ];
    controlPlane.browserCommand.mockImplementation(async (_lease, command) =>
      command.commandType === "page.snapshot"
        ? {
            status: "SUCCEEDED",
            result: { content: 'Order PO-00042\n- textbox "Order" [ref=e1]\n' },
            artifacts: [
              { id: "proof", kind: "SCREENSHOT", metadata: { retained: true } },
            ],
          }
        : {
            status: "SUCCEEDED",
            result: { content: JSON.stringify(command.payload) },
          },
    );
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      20,
    );
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "PASSED",
      criteria: [
        {
          criterionId: "page-visible",
          status: "PASSED",
          evidenceRefs: ["artifact://proof"],
        },
        { criterionId: "order-copy", status: "PASSED" },
      ],
      evidence: [
        { externalId: "artifact://proof", metadata: { retained: true } },
      ],
    });
    expect(controlPlane.browserCommand).toHaveBeenCalledTimes(8);
    expect(controlPlane.browserCommand).toHaveBeenLastCalledWith(
      lease,
      {
        commandType: "page.fill",
        payload: { target: { selector: "#order" }, text: "PO-00042" },
      },
      expect.any(AbortSignal),
    );
    expect(create).toHaveBeenCalledTimes(12);
    expect(originalRequests).toEqual(snapshots);
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
    const metrics = controlPlane.appendEvent.mock.calls
      .filter((call) => call[1] === "agent.model.started")
      .map((call) => call[2].inputPreview.context);
    expect(metrics.at(-1).compactedTurns).toBeGreaterThan(0);
  });

  it("blocks a ref outside the returned page, allows it after local paging, and invalidates it after mutation", async () => {
    let step = 0;
    let observationId = "";
    let nextCursor = 0;
    let recoveryToken = "";
    const create = vi.fn().mockImplementation(async (request: Request) => {
      const index = step++;
      let name = "browser_command";
      let args: Record<string, unknown> = {
        commandType: "page.click",
        payload: { target: { ref: "e900" } },
      };
      if (index === 0 || index === 6)
        args = {
          commandType: "page.snapshot",
          payload: index === 6 ? { target: { selector: "#target" } } : {},
        };
      if (index === 1) {
        observationId = output(request, 0).result.observationId;
        nextCursor = output(request, 0).result.nextCursor;
      }
      if (index === 2) {
        expect(output(request, 1)).toMatchObject({
          accepted: false,
          code: "INVALID_ARGUMENTS",
        });
        name = "read_observation";
        args = { observationId, cursor: nextCursor };
      }
      if (index === 3)
        expect(output(request, 2).result.content).toContain("[ref=e900]");
      if (index === 4) {
        name = "read_observation";
        args = { observationId, cursor: nextCursor };
      }
      if (index === 5)
        expect(output(request, 4).result.refState).toBe("HISTORICAL");
      if (index === 6) {
        expect(output(request, 5)).toMatchObject({ accepted: false });
        recoveryToken = output(request, 5).locatorRecovery.recoveryToken;
      }
      if (index === 7) args.locatorRecoveryToken = recoveryToken;
      return {
        id: `response-${index}`,
        output: [functionCall(name, args, index)],
      };
    });
    const { runTask, controlPlane } = convergenceHarness(create);
    const content =
      '- text "Padding"\n'.repeat(800) + '- button "Target" [ref=e900]\n';
    controlPlane.browserCommand.mockImplementation(async (_lease, command) => ({
      status: "SUCCEEDED",
      result:
        command.commandType === "page.snapshot"
          ? {
              content: command.payload.target
                ? '- button "Target" [ref=e900]\n'
                : content,
            }
          : { clicked: true },
    }));
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      8,
    );
    await executor.execute(runTask, lease, new AbortController().signal);
    expect(
      controlPlane.browserCommand.mock.calls.map((call) => call[1].commandType),
    ).toEqual([
      "page.snapshot",
      "page.click",
      "page.snapshot",
      "page.snapshot",
      "page.click",
    ]);
  });

  it("keeps multi-call groups and opaque reasoning identical across provider fallback", async () => {
    const requests: Request[] = [];
    const reasoning = {
      type: "reasoning",
      id: "opaque-id",
      encrypted_content: "opaque-provider-data",
      summary: [],
    };
    const create = vi.fn().mockImplementation(async (request: Request) => {
      requests.push(structuredClone(request));
      if (requests.length === 1)
        return {
          id: "first",
          output: [
            reasoning,
            functionCall(
              "browser_command",
              { commandType: "page.get_url", payload: {} },
              0,
            ),
            functionCall(
              "browser_command",
              { commandType: "page.get_title", payload: {} },
              1,
            ),
          ],
        };
      if (requests.length === 2) {
        request.input.splice(0);
        request.tools.splice(0);
        throw new Error("primary unavailable");
      }
      return {
        id: "last",
        output: [
          functionCall(
            "request_human_input",
            { prompt: "请完成访问确认。", summary: "等待人工确认。" },
            2,
          ),
        ],
      };
    });
    const { runTask, controlPlane } = convergenceHarness(create);
    runTask.snapshot.modelCandidates = [
      task.snapshot.modelCandidates![0]!,
      { ...task.snapshot.modelCandidates![0]!, modelId: "fallback-long-name" },
    ];
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );
    expect(
      await executor.execute(runTask, lease, new AbortController().signal),
    ).toMatchObject({ kind: "WAITING_HUMAN" });
    expect(requests[2]!.input).toEqual(requests[1]!.input);
    expect(requests[2]!.tools).toEqual(requests[1]!.tools);
    expect(requests[2]!.input).toContainEqual(reasoning);
    const group = requests[2]!.input.filter(
      (item) => typeof item.call_id === "string",
    );
    expect(group.map((item) => [item.type, item.call_id])).toEqual([
      ["function_call", "call-0"],
      ["function_call", "call-1"],
      ["function_call_output", "call-0"],
      ["function_call_output", "call-1"],
    ]);
  });

  it("starts a fresh cache on the next segment after human intervention", async () => {
    let index = 0;
    let observationId = "";
    const create = vi.fn().mockImplementation(async (request: Request) => {
      const step = index++;
      if (step === 0)
        return {
          id: "first",
          output: [
            functionCall(
              "browser_command",
              { commandType: "page.snapshot", payload: {} },
              0,
            ),
          ],
        };
      if (step === 1) observationId = output(request, 0).result.observationId;
      if (step === 2) {
        expect(state(request).observations).toEqual([]);
        expect(JSON.stringify(request.input)).toContain("人工已完成登录");
        return {
          id: "resumed",
          output: [functionCall("read_observation", { observationId }, 2)],
        };
      }
      if (step === 3)
        expect(output(request, 2)).toMatchObject({
          accepted: false,
          error: expect.stringContaining("当前执行段"),
        });
      return {
        id: "human",
        output: [
          functionCall(
            "request_human_input",
            { prompt: "请完成登录。", summary: "等待人工登录。" },
            step,
          ),
        ],
      };
    });
    const { runTask, controlPlane } = convergenceHarness(create);
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );
    expect(
      await executor.execute(runTask, lease, new AbortController().signal),
    ).toMatchObject({ kind: "WAITING_HUMAN" });
    const resumedTask = structuredClone(runTask);
    resumedTask.snapshot.executionPolicy.resume = {
      response: { message: "人工已完成登录" },
    };
    expect(
      await executor.execute(
        resumedTask,
        { ...lease, fencingToken: "5" },
        new AbortController().signal,
      ),
    ).toMatchObject({ kind: "WAITING_HUMAN" });
    expect(controlPlane.browserCommand).toHaveBeenCalledOnce();
    expect(controlPlane.acquireBrowser).toHaveBeenCalledTimes(2);
  });

  it("reports insufficient initial capacity before any model or browser command", async () => {
    const create = vi.fn();
    const { runTask, controlPlane } = convergenceHarness(create);
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
      { maxBytes: 1_000 },
    );
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: "FATAL_FAILURE",
      executionDisposition: "NOT_RUN",
      error: {
        code: "AGENT_CONTEXT_BUDGET_EXCEEDED",
        details: { maxBytes: 1_000 },
      },
    });
    expect(outcome).not.toHaveProperty("verdict");
    expect(create).not.toHaveBeenCalled();
    expect(controlPlane.browserCommand).not.toHaveBeenCalled();
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it("retains accepted criteria and evidence when the latest provider group exceeds capacity", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "observe",
        output: [
          functionCall(
            "browser_command",
            { commandType: "page.snapshot", payload: {} },
            0,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "record",
        output: [
          { type: "reasoning", encrypted_content: "x".repeat(100_000) },
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              status: "PASSED",
              summary: "页面可见。",
              evidenceRefs: ["artifact://proof"],
            },
            1,
          ),
        ],
      });
    const { runTask, controlPlane } = convergenceHarness(create);
    controlPlane.browserCommand.mockResolvedValue({
      status: "SUCCEEDED",
      result: { content: "页面可见" },
      artifacts: [{ id: "proof", kind: "SCREENSHOT" }],
    });
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: "FATAL_FAILURE",
      executionDisposition: "AGENT_ERROR",
      error: {
        code: "AGENT_CONTEXT_BUDGET_EXCEEDED",
        details: {
          acceptedCriteria: [
            {
              criterionId: "page-visible",
              status: "PASSED",
              evidenceRefs: ["artifact://proof"],
            },
          ],
          evidence: [{ externalId: "artifact://proof", kind: "SCREENSHOT" }],
        },
      },
    });
    expect(outcome).not.toHaveProperty("verdict");
    expect(create).toHaveBeenCalledTimes(2);
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it("does not replay a partial multi-call response when the tool budget is exhausted", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "multiple",
      output: [0, 1].map((id) =>
        functionCall(
          "browser_command",
          { commandType: "page.get_url", payload: {} },
          id,
        ),
      ),
    });
    const { runTask, controlPlane } = convergenceHarness(create);
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      1,
    );
    expect(
      await executor.execute(runTask, lease, new AbortController().signal),
    ).toMatchObject({ error: { code: "AGENT_TOOL_LIMIT_EXCEEDED" } });
    expect(create).toHaveBeenCalledOnce();
    expect(controlPlane.browserCommand).toHaveBeenCalledOnce();
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it("stops a partially executed response immediately on cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("lease cancelled");
    const create = vi.fn().mockResolvedValue({
      id: "multiple",
      output: [0, 1].map((id) =>
        functionCall(
          "browser_command",
          { commandType: "page.get_url", payload: {} },
          id,
        ),
      ),
    });
    const { runTask, controlPlane } = convergenceHarness(create);
    controlPlane.browserCommand.mockImplementation(async () => {
      controller.abort(reason);
      return { status: "SUCCEEDED", result: { url: "https://example.com" } };
    });
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );
    await expect(
      executor.execute(runTask, lease, controller.signal),
    ).rejects.toBe(reason);
    expect(create).toHaveBeenCalledOnce();
    expect(controlPlane.browserCommand).toHaveBeenCalledOnce();
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it("rolls back to raw outputs and full history without advertising the local read tool", async () => {
    let index = 0;
    const requests: Request[] = [];
    const create = vi.fn().mockImplementation(async (request: Request) => {
      requests.push(request);
      const step = index++;
      return {
        id: `response-${step}`,
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.get_text",
              payload: { target: { selector: `#row-${step}` } },
            },
            step,
          ),
        ],
      };
    });
    const { runTask, controlPlane } = convergenceHarness(create);
    const raw = {
      status: "SUCCEEDED",
      commandId: "transport-id",
      result: { content: "原始观察" },
    };
    controlPlane.browserCommand.mockResolvedValue(raw);
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      7,
      { mode: "LEGACY", maxBytes: 1_000 },
    );
    await executor.execute(runTask, lease, new AbortController().signal);
    expect(
      requests.at(-1)!.tools.some((tool) => tool.name === "read_observation"),
    ).toBe(false);
    expect(JSON.stringify(requests[0]!.input)).not.toContain(
      "browser_working_state",
    );
    expect(
      requests
        .at(-1)!
        .input.filter((item) => item.type === "function_call_output"),
    ).toHaveLength(6);
    expect(output(requests.at(-1)!, 0)).toEqual(raw);
  });
});

describe("browser verification argument corrections", () => {
  const invalidCalls = [
    {
      name: "browser_command",
      arguments: '{"commandType":',
      code: "INVALID_JSON",
    },
    { name: "browser_command", arguments: "null", code: "INVALID_ARGUMENTS" },
    { name: "browser_command", arguments: "[]", code: "INVALID_ARGUMENTS" },
    {
      name: "browser_command",
      arguments: JSON.stringify({ commandType: "page.content", payload: {} }),
      code: "UNKNOWN_COMMAND",
    },
    {
      name: "browser_command",
      arguments: JSON.stringify({
        commandType: "page.click",
        payload: { target: { ref: "bad-ref" } },
      }),
      code: "INVALID_ARGUMENTS",
    },
    {
      name: "browser_command",
      arguments: JSON.stringify({
        commandType: "page.navigate",
        payload: { url: "file:///private/data" },
      }),
      code: "INVALID_ARGUMENTS",
    },
    {
      name: "browser_command",
      arguments: JSON.stringify({
        commandType: "page.network",
        payload: { includeResponseBodies: true },
      }),
      code: "TOOL_GROUP_REQUIRED",
    },
    {
      name: "browser_command",
      arguments: JSON.stringify({ commandType: "session.close", payload: {} }),
      code: "COMMAND_NOT_ALLOWED",
    },
    {
      name: "record_criterion",
      arguments: JSON.stringify({ status: "made-up" }),
      code: "INVALID_ARGUMENTS",
    },
    {
      name: "record_criterion",
      arguments: JSON.stringify({
        criterionId: "page-visible",
        status: "PASSED",
        summary: "页面通过。",
        evidenceRefs: ["artifact://invented"],
      }),
      code: "INVALID_ARGUMENTS",
    },
    {
      name: "request_human_input",
      arguments: JSON.stringify({ prompt: [], summary: "需要人工操作。" }),
      code: "INVALID_ARGUMENTS",
    },
    {
      name: "finish_verification",
      arguments: JSON.stringify({ summary: "完成。", verdict: "made-up" }),
      code: "INVALID_ARGUMENTS",
    },
    { name: "unknown_tool", arguments: "{}", code: "UNKNOWN_TOOL" },
  ];

  it.each(invalidCalls)(
    "corrects $name ($code) without a browser side effect",
    async (invalid) => {
      const calls = [
        {
          type: "function_call",
          call_id: "call-invalid",
          name: invalid.name,
          arguments: invalid.arguments,
        },
        functionCall(
          "finish_verification",
          { verdict: "PASSED", summary: "提前完成。" },
          2,
        ),
        functionCall(
          "browser_command",
          {
            commandType: "page.navigate",
            payload: { url: "https://example.com" },
          },
          3,
        ),
        functionCall(
          "record_criterion",
          {
            criterionId: "page-visible",
            status: "PASSED",
            summary: "页面当前可见。",
            evidenceRefs: [],
          },
          4,
        ),
        functionCall(
          "finish_verification",
          { verdict: "PASSED", summary: "验证完成。" },
          5,
        ),
      ];
      const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
      let index = 0;
      const create = vi.fn().mockImplementation(async (request) => {
        requests.push(structuredClone(request));
        return { id: `response-${index}`, output: [calls[index++]] };
      });
      const controlPlane = {
        acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
        appendEvent: vi.fn().mockResolvedValue({}),
        browserCommand: vi.fn().mockResolvedValue({
          status: "SUCCEEDED",
          result: { url: "https://example.com", title: "页面" },
        }),
        releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
      };
      const executor = new BrowserVerificationExecutor(
        modelFactory(create),
        controlPlane as never,
        5,
      );
      const outcome = await executor.execute(
        task,
        lease,
        new AbortController().signal,
      );
      expect(outcome).toMatchObject({
        kind: "VERIFICATION_COMPLETED",
        verdict: "PASSED",
      });
      expect(controlPlane.browserCommand).toHaveBeenCalledExactlyOnceWith(
        lease,
        {
          commandType: "page.navigate",
          payload: {
            url: "https://example.com",
            waitUntil: "domcontentloaded",
          },
        },
        expect.any(AbortSignal),
      );
      const feedback = requests[1]!.input.find(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "call-invalid",
      )!;
      expect(Buffer.byteLength(String(feedback.output))).toBeLessThanOrEqual(
        2_048,
      );
      expect(JSON.parse(String(feedback.output))).toMatchObject({
        accepted: false,
        code: invalid.code,
        retryable: true,
      });
      const earlyFinish = requests[2]!.input.find(
        (item) =>
          item.type === "function_call_output" && item.call_id === "call-2",
      )!;
      expect(String(earlyFinish.output)).toContain(
        "至少需要执行一次浏览器命令",
      );
      expect(create).toHaveBeenCalledTimes(5);
      expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
      const trace = controlPlane.appendEvent.mock.calls.find(
        ([, kind, payload]) =>
          kind === "agent.tool.completed" && payload.callId === "call-invalid",
      );
      expect(trace?.[2].outputPreview.correctionBytes).toBe(
        Buffer.byteLength(String(feedback.output)),
      );
    },
  );

  it("counts invalid calls toward the tool limit without claiming browser execution", async () => {
    let index = 0;
    const create = vi.fn().mockImplementation(async () => ({
      id: `response-${index}`,
      output: [
        functionCall(
          "browser_command",
          { commandType: "page.content", payload: {} },
          index++,
        ),
      ],
    }));
    const { controlPlane } = convergenceHarness(create);
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      2,
    );
    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: "RETRYABLE_FAILURE",
      executionDisposition: "NOT_RUN",
      error: { code: "AGENT_TOOL_LIMIT_EXCEEDED" },
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(controlPlane.browserCommand).not.toHaveBeenCalled();
  });

  it("keeps transport failures separate from invalid argument corrections", async () => {
    const calls = [
      functionCall(
        "browser_command",
        {
          commandType: "page.navigate",
          payload: { url: "https://example.com" },
        },
        1,
      ),
      functionCall(
        "request_human_input",
        { prompt: "请检查浏览器连接。", summary: "等待恢复连接。" },
        2,
      ),
    ];
    const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
    let index = 0;
    const create = vi.fn().mockImplementation(async (request) => {
      requests.push(structuredClone(request));
      return { id: `response-${index}`, output: [calls[index++]] };
    });
    const { controlPlane } = convergenceHarness(create);
    controlPlane.browserCommand.mockRejectedValue(
      new Error("Runtime transport unavailable"),
    );
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      2,
    );
    expect(
      await executor.execute(task, lease, new AbortController().signal),
    ).toMatchObject({ kind: "WAITING_HUMAN" });
    const feedback = requests[1]!.input.find(
      (item) => item.type === "function_call_output",
    )!;
    expect(JSON.parse(String(feedback.output))).toEqual({
      accepted: false,
      error: "Runtime transport unavailable",
    });
  });
});

describe("browser verification convergence", () => {
  it("shares a five-second budget across forced-finalization telemetry and a hung release", async () => {
    vi.useFakeTimers();
    const create = vi.fn();
    const { executor, controlPlane, runTask } = convergenceHarness(create);
    runTask.snapshot.deadlineAt = new Date(Date.now() + 30_000).toISOString();
    controlPlane.appendEvent.mockImplementation(async (_lease, kind) => {
      if (
        kind === "executor.deadline.finalized" ||
        kind === "agent.segment.completed"
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      return {};
    });
    let rejectRelease: (error: Error) => void = () => {};
    controlPlane.releaseBrowser.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRelease = reject;
        }),
    );
    let completed = false;
    const execution = executor
      .execute(runTask, lease, new AbortController().signal)
      .then((outcome) => {
        completed = true;
        return outcome;
      });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await execution).toMatchObject({
      kind: "FATAL_FAILURE",
      executionDisposition: "NOT_RUN",
    });
    expect(create).not.toHaveBeenCalled();
    rejectRelease(new Error("Late close RPC failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(
      controlPlane.appendEvent.mock.calls.some(
        (call) => call[1] === "browser.release.deferred",
      ),
    ).toBe(false);
  });

  it("does not append more telemetry after a forced-finalization RPC consumes the budget", async () => {
    vi.useFakeTimers();
    const { executor, controlPlane, runTask } = convergenceHarness(vi.fn());
    runTask.snapshot.deadlineAt = new Date(Date.now() + 30_000).toISOString();
    controlPlane.appendEvent.mockImplementation(async (_lease, kind) => {
      if (kind === "executor.deadline.finalized") await new Promise(() => {});
      return {};
    });
    controlPlane.releaseBrowser.mockImplementation(() => new Promise(() => {}));
    const execution = executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await execution).toMatchObject({
      kind: "FATAL_FAILURE",
      executionDisposition: "NOT_RUN",
    });
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
    expect(
      controlPlane.appendEvent.mock.calls.some(
        (call) => call[1] === "agent.segment.completed",
      ),
    ).toBe(false);
  });

  it("stops a fast repeated snapshot loop and fills missing criteria without inventing evidence", async () => {
    let index = 0;
    const create = vi.fn().mockImplementation(async () => ({
      id: `response-${++index}`,
      output: [
        functionCall(
          "browser_command",
          { commandType: "page.snapshot", payload: {} },
          index,
        ),
      ],
    }));
    const { executor, controlPlane, runTask } = convergenceHarness(create);
    controlPlane.browserCommand.mockImplementation(async () => ({
      id: `command-${index}`,
      result: { content: `页面加载中 [ref=e${index}]` },
      durationMs: index,
      status: "SUCCEEDED",
    }));
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(create).toHaveBeenCalledTimes(25);
    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "INCONCLUSIVE",
      evidence: [],
      criteria: [
        {
          criterionId: "page-visible",
          status: "INCONCLUSIVE",
          evidenceRefs: [],
        },
      ],
    });
    expect(outcome.summary).toContain("重复操作");
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it("bounds text-only responses even though they never consume a tool call", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "text",
      output: [{ type: "message", text: "继续分析" }],
    });
    const { executor, controlPlane, runTask } = convergenceHarness(create);
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(create).toHaveBeenCalledTimes(4);
    expect(controlPlane.browserCommand).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "FATAL_FAILURE",
      executionDisposition: "NOT_RUN",
      error: {
        code: "AGENT_NO_PROGRESS",
        details: {
          reason: "TEXT_ONLY_LOOP",
          unverifiedCriterionIds: ["page-visible"],
        },
      },
    });
    expect(outcome.summary).toContain("1 条验收标准未验证");
  });

  it("finalizes zero recorded criteria when browser work reaches the reserve", async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockResolvedValue({
      id: "browser",
      output: [
        functionCall(
          "browser_command",
          { commandType: "page.snapshot", payload: {} },
          1,
        ),
      ],
    });
    const { executor, controlPlane, runTask } = convergenceHarness(create);
    controlPlane.browserCommand.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 60_000);
      return { status: "SUCCEEDED", result: { content: "页面加载中" } };
    });
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "INCONCLUSIVE",
      evidence: [],
      criteria: [{ status: "INCONCLUSIVE", evidenceRefs: [] }],
    });
    expect(outcome.summary).toContain("剩余执行时间不足");
  });

  it("preserves a recorded failure and its evidence when other criteria remain unknown", async () => {
    vi.useFakeTimers();
    const screenshotId = "11111111-1111-4111-8111-111111111111";
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "browser",
        output: [
          functionCall(
            "browser_command",
            { commandType: "page.screenshot", payload: {} },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "criterion",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              status: "FAILED",
              summary: "页面缺少所需内容。",
              evidenceRefs: [`artifact://${screenshotId}`],
            },
            2,
          ),
        ],
      });
    const { executor, controlPlane, runTask } = convergenceHarness(create);
    runTask.snapshot.criteria = [
      ...runTask.snapshot.criteria,
      {
        id: "footer",
        description: "页脚可见",
        required: true,
        requiredEvidenceKinds: ["SCREENSHOT"],
      },
    ];
    controlPlane.browserCommand.mockResolvedValue({
      status: "SUCCEEDED",
      artifacts: [{ id: screenshotId, kind: "SCREENSHOT", metadata: {} }],
    });
    controlPlane.appendEvent.mockImplementation(async (_lease, kind) => {
      if (kind === "agent.tool.completed" && create.mock.calls.length === 2)
        vi.setSystemTime(Date.now() + 60_000);
      return {};
    });
    const outcome = await executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "FAILED",
      criteria: [
        {
          criterionId: "page-visible",
          status: "FAILED",
          summary: "页面缺少所需内容。",
          evidenceRefs: [`artifact://${screenshotId}`],
        },
        { criterionId: "footer", status: "INCONCLUSIVE", evidenceRefs: [] },
      ],
      evidence: [
        { externalId: `artifact://${screenshotId}`, kind: "SCREENSHOT" },
      ],
    });
  });

  it("cuts off a hung model at the reserve even if its client ignores abort", async () => {
    vi.useFakeTimers();
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "browser",
        output: [
          functionCall(
            "browser_command",
            { commandType: "page.snapshot", payload: {} },
            1,
          ),
        ],
      })
      .mockImplementation(() => new Promise(() => {}));
    const { executor, controlPlane, runTask } = convergenceHarness(create);
    const execution = executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await execution;
    expect(create.mock.calls[1]![1].signal.aborted).toBe(true);
    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "INCONCLUSIVE",
    });
    expect(controlPlane.appendEvent).toHaveBeenCalledWith(
      lease,
      "agent.model.failed",
      expect.objectContaining({
        errorMessage: expect.stringContaining("收尾窗口"),
      }),
    );
    expect(controlPlane.releaseBrowser).toHaveBeenCalledOnce();
  });

  it("honors a heartbeat deadline extension while preserving a finalization window", async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { executor, runTask } = convergenceHarness(create);
    const execution = executor.execute(
      runTask,
      lease,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    runTask.snapshot.deadlineAt = new Date(Date.now() + 150_000).toISOString();
    await vi.advanceTimersByTimeAsync(30_001);
    expect(create.mock.calls[0]![1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await execution).toMatchObject({
      kind: "FATAL_FAILURE",
      executionDisposition: "NOT_RUN",
    });
    expect(create.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("lets parent cancellation or lease loss win over model finalization", async () => {
    vi.useFakeTimers();
    const create = vi.fn().mockImplementation(() => new Promise(() => {}));
    const { executor, controlPlane, runTask } = convergenceHarness(create);
    const controller = new AbortController();
    const execution = executor.execute(runTask, lease, controller.signal);
    const reason = new Error("Runtime lease was lost.");
    const rejected = expect(execution).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(59_999);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(
      controlPlane.appendEvent.mock.calls.some((call) =>
        String(call[1]).endsWith(".finalized"),
      ),
    ).toBe(false);
  });
});

describe("Agent Runtime browser verification executor", () => {
  it("removes validation-only formats from non-strict function schemas", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "response-schema",
      output: [
        functionCall(
          "request_human_input",
          {
            prompt: "请批准访问。",
            summary: "当前需要人工批准。",
          },
          1,
        ),
      ],
    });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi.fn(),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    await executor.execute(task, lease, new AbortController().signal);

    const tools = create.mock.calls[0]?.[0].tools;
    expect(JSON.stringify(tools)).not.toContain('"format":');
    expect(
      (tools as Array<{ strict?: boolean }>).every(
        (tool) => tool.strict === false,
      ),
    ).toBe(true);
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "browser_command", strict: false }),
      ]),
    );
    const browserTool = (
      tools as Array<{ name: string; parameters: unknown }>
    ).find((tool) => tool.name === "browser_command");
    expect(JSON.stringify(browserTool?.parameters)).toContain(
      "locatorRecoveryToken",
    );
    const firstRequest = create.mock.calls[0]?.[0] as {
      input: Array<{ content?: string; role?: string }>;
      tools: Array<{ description: string }>;
    };
    expect(firstRequest.input[0]?.content).toContain(
      "所有用户可见的生成内容必须使用简体中文",
    );
    expect(
      firstRequest.tools.every((tool) =>
        /[\u3400-\u9fff]/u.test(tool.description),
      ),
    ).toBe(true);
  });

  it("redacts secrets before trace previews cross the control plane", async () => {
    const sensitiveTask: RuntimeTaskLease = {
      ...task,
      snapshot: {
        ...task.snapshot,
        goal: "Verify Bearer trace-secret-value and https://example.com?token=query-secret-value",
      },
    };
    const create = vi.fn().mockResolvedValue({
      id: "response-sensitive",
      output: [
        functionCall(
          "request_human_input",
          {
            context: { apiKey: "tool-secret-value" },
            prompt: "请批准访问。",
            summary: "当前需要人工批准。",
          },
          1,
        ),
      ],
    });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi.fn(),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    await executor.execute(sensitiveTask, lease, new AbortController().signal);

    const tracePayloads = JSON.stringify(
      controlPlane.appendEvent.mock.calls
        .filter((call) => String(call[1]).startsWith("agent."))
        .map((call) => call[2]),
    );
    expect(tracePayloads).toContain("redacted");
    expect(tracePayloads).not.toContain("trace-secret-value");
    expect(tracePayloads).not.toContain("query-secret-value");
    expect(tracePayloads).not.toContain("tool-secret-value");
    expect(tracePayloads).not.toContain("sk-test-model-secret");
  });

  it("redacts JSON-encoded tool outputs without changing model history", async () => {
    const raw = {
      status: "SUCCEEDED",
      leaseToken: "lease-secret-value",
      ownerFencingToken: "owner-secret-value",
      result: {
        title: "订单已确认",
        content: JSON.stringify({
          refreshToken: "refresh-secret-value",
          password: "secret with spaces",
          nested: JSON.stringify({ apiKey: "nested-secret-value" }),
        }),
      },
    };
    const requests: Array<{ input: Array<Record<string, unknown>> }> = [];
    const create = vi.fn().mockImplementation(async (request) => {
      requests.push(structuredClone(request));
      return {
        id: `response-${requests.length}`,
        output: [
          requests.length === 1
            ? functionCall(
                "browser_command",
                { commandType: "page.get_title", payload: {} },
                1,
              )
            : functionCall(
                "request_human_input",
                { prompt: "请确认订单。", summary: "等待人工确认。" },
                2,
              ),
        ],
      };
    });
    const { runTask, controlPlane } = convergenceHarness(create);
    controlPlane.browserCommand.mockResolvedValue(raw);
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
      { mode: "LEGACY" },
    );

    await executor.execute(runTask, lease, new AbortController().signal);

    const modelOutput = requests[1]!.input.find(
      (item) => item.type === "function_call_output",
    );
    expect(JSON.parse(String(modelOutput?.output))).toEqual(raw);
    const tracePayloads = JSON.stringify(
      controlPlane.appendEvent.mock.calls
        .filter((call) => String(call[1]).startsWith("agent."))
        .map((call) => call[2]),
    );
    expect(tracePayloads).toContain("订单已确认");
    expect(tracePayloads).toContain("redacted");
    for (const secret of [
      "lease-secret-value",
      "owner-secret-value",
      "refresh-secret-value",
      "secret with spaces",
      "nested-secret-value",
    ]) {
      expect(tracePayloads.includes(secret), `Trace contains ${secret}`).toBe(
        false,
      );
    }
  });

  it("rejects direct completion until browser work and criteria exist", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-1",
        output: [
          functionCall(
            "finish_verification",
            { summary: "看起来正常。", verdict: "PASSED" },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-2",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.navigate",
              payload: { url: "https://example.com" },
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-3",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [],
              status: "PASSED",
              summary: "页面已加载。",
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-4",
        output: [
          functionCall(
            "finish_verification",
            { summary: "所需页面已加载。", verdict: "PASSED" },
            4,
          ),
        ],
      });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi.fn().mockResolvedValue({ status: "SUCCEEDED" }),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      executionDisposition: "EXECUTED",
      kind: "VERIFICATION_COMPLETED",
      verdict: "PASSED",
    });
    expect(controlPlane.browserCommand).toHaveBeenCalledTimes(1);
    expect(controlPlane.releaseBrowser).toHaveBeenCalledTimes(1);
    expect(controlPlane.appendEvent.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        "agent.segment.started",
        "agent.model.completed",
        "agent.tool.completed",
        "agent.segment.completed",
      ]),
    );
    const secondInput = create.mock.calls[1]?.[0].input as unknown[];
    expect(secondInput).toContainEqual(
      expect.objectContaining({
        output: expect.stringContaining("至少需要执行一次浏览器命令"),
        type: "function_call_output",
      }),
    );
  });

  it("finalizes recorded criteria without another model call near the deadline", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const adaptiveTask: RuntimeTaskLease = {
      ...task,
      snapshot: {
        ...task.snapshot,
        deadlineAt: new Date(startedAt + 120_000).toISOString(),
        executionPolicy: {
          deadline: {
            finalizationReserveSeconds: 60,
            maxModelCallSeconds: 300,
            mode: "ADAPTIVE",
            refundHumanWait: true,
          },
        },
      },
    };
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-browser",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.navigate",
              payload: { url: "https://example.com" },
            },
            1,
          ),
        ],
      })
      .mockImplementationOnce(async () => {
        // The criterion arrives before the reserved window; finalization is
        // evaluated on the next iteration, after it has been recorded.
        vi.setSystemTime(startedAt + 59_999);
        return {
          id: "response-criterion",
          output: [
            functionCall(
              "record_criterion",
              {
                criterionId: "page-visible",
                evidenceRefs: [],
                status: "PASSED",
                summary: "页面已加载。",
              },
              2,
            ),
          ],
        };
      });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockImplementation(async (_lease, kind) => {
        if (kind === "agent.tool.completed" && create.mock.calls.length === 2) {
          vi.setSystemTime(startedAt + 60_000);
        }
        return {};
      }),
      browserCommand: vi.fn().mockResolvedValue({ status: "SUCCEEDED" }),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    const outcome = await executor.execute(
      adaptiveTask,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "PASSED",
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(controlPlane.appendEvent).toHaveBeenCalledWith(
      lease,
      "executor.deadline.finalized",
      expect.any(Object),
    );
  });

  it("does not accept a text-only model response as completion", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-1",
        output: [
          { role: "assistant", text: "It probably passed.", type: "message" },
        ],
      })
      .mockResolvedValueOnce({
        id: "response-2",
        output: [
          functionCall(
            "request_human_input",
            {
              prompt: "请批准访问。",
              summary: "当前需要人工批准。",
            },
            2,
          ),
        ],
      });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi.fn(),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome.kind).toBe("WAITING_HUMAN");
    expect(create).toHaveBeenCalledTimes(2);
    expect(controlPlane.browserCommand).not.toHaveBeenCalled();
    expect(controlPlane.releaseBrowser).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      intervention: {
        kind: "BROWSER_HITL",
        responseSchema: {},
      },
    });
    expect(
      outcome.kind === "WAITING_HUMAN"
        ? outcome.intervention.expiresAt
        : undefined,
    ).toEqual(expect.any(String));
  });

  it("falls through configured models and probes the preferred model again on the next call", async () => {
    const fallbackTask: RuntimeTaskLease = {
      ...task,
      snapshot: {
        ...task.snapshot,
        modelCandidates: [
          {
            apiKey: "sk-primary",
            baseUrl: "https://primary.example.com/v1",
            displayName: "Primary",
            modelId: "gpt-primary",
          },
          {
            apiKey: "sk-fallback",
            baseUrl: "https://fallback.example.com/v1",
            displayName: "Fallback",
            modelId: "gpt-fallback",
          },
        ],
      },
    };
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("primary unavailable for Bearer sk-primary-secret-123456"),
      )
      .mockResolvedValueOnce({
        id: "response-fallback",
        output: [{ role: "assistant", text: "Continue.", type: "message" }],
      })
      .mockResolvedValueOnce({
        id: "response-primary-recovered",
        output: [
          functionCall(
            "request_human_input",
            {
              prompt: "请批准访问。",
              summary: "当前需要人工批准。",
            },
            2,
          ),
        ],
      });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi.fn(),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    const outcome = await executor.execute(
      fallbackTask,
      lease,
      new AbortController().signal,
    );

    expect(outcome.kind).toBe("WAITING_HUMAN");
    expect(create.mock.calls.map((call) => call[0].model)).toEqual([
      "gpt-primary",
      "gpt-fallback",
      "gpt-primary",
    ]);
    expect(controlPlane.appendEvent).toHaveBeenCalledWith(
      lease,
      "agent.model.failed",
      expect.objectContaining({ model: "gpt-primary" }),
    );
    expect(controlPlane.appendEvent).toHaveBeenCalledWith(
      lease,
      "agent.model.completed",
      expect.objectContaining({ model: "gpt-primary" }),
    );
    expect(JSON.stringify(controlPlane.appendEvent.mock.calls)).not.toContain(
      "sk-primary-secret-123456",
    );
  });

  it("does not hold a Runtime lane while browser capacity is unavailable", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "response-after-capacity",
      output: [
        functionCall(
          "request_human_input",
          {
            prompt: "请批准访问。",
            summary: "当前需要人工批准。",
          },
          1,
        ),
      ],
    });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValueOnce({
        browserExecutionId: "ab91fa7b-afd8-42be-982b-e860de0fca67",
        reason: "NO_AVAILABLE_SLOT",
        retryAfterMs: 1,
        status: "WAITING_CAPACITY",
      }),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi.fn(),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    await expect(
      executor.execute(task, lease, new AbortController().signal),
    ).rejects.toThrow("Browser admission was lost");
    expect(controlPlane.acquireBrowser).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("reports a lost admission without starting the model", async () => {
    const create = vi.fn();
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue({
        browserExecutionId: "ab91fa7b-afd8-42be-982b-e860de0fca67",
        reason: "NO_AVAILABLE_SLOT",
        retryAfterMs: 10_000,
        status: "WAITING_CAPACITY",
      }),
      appendEvent: vi.fn(),
      browserCommand: vi.fn(),
      releaseBrowser: vi.fn(),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );
    await expect(
      executor.execute(task, lease, new AbortController().signal),
    ).rejects.toThrow("Browser admission was lost");
    expect(controlPlane.acquireBrowser).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("includes resolved human input when the same task resumes", async () => {
    const resumedTask: RuntimeTaskLease = {
      ...task,
      snapshot: {
        ...task.snapshot,
        executionPolicy: {
          resume: {
            interventionId: "d63bd843-b89d-48ea-90c9-caad5b51d526",
            resolvedAt: "2026-08-19T07:00:00.000Z",
            response: {
              approved: true,
              note: "MFA completed in the preserved browser session.",
            },
          },
        },
      },
    };
    const create = vi.fn().mockResolvedValue({
      id: "response-resumed",
      output: [
        functionCall(
          "request_human_input",
          {
            prompt: "请再次批准。",
            summary: "正在等待再次批准。",
          },
          1,
        ),
      ],
    });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi.fn(),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    await executor.execute(resumedTask, lease, new AbortController().signal);

    const input = create.mock.calls[0]?.[0].input as Array<{
      content?: string;
      role?: string;
    }>;
    const userPrompt = input.find((item) => item.role === "user")?.content;
    expect(userPrompt).toContain("MFA completed");
  });

  it("supplies business references and rejects passing criteria with missing evidence kinds", async () => {
    const referencedTask: RuntimeTaskLease = {
      ...task,
      snapshot: {
        ...task.snapshot,
        businessReferences: [
          {
            externalId: "reference://spec/spec-1/issue",
            kind: "BUSINESS_REFERENCE",
            label: "ENG-1",
            metadata: { source: "LINEAR", title: "Requirement" },
          },
        ],
        criteria: [
          {
            description: "The requirement is visible.",
            id: "page-visible",
            required: true,
            requiredEvidenceKinds: ["SCREENSHOT", "BUSINESS_REFERENCE"],
          },
        ],
      },
    };
    const screenshotRef = "artifact://11111111-1111-4111-8111-111111111111";
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-1",
        output: [
          functionCall(
            "browser_command",
            { commandType: "page.screenshot", payload: {} },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-2",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [screenshotRef],
              status: "PASSED",
              summary: "页面当前可见。",
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-3",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [screenshotRef, "reference://spec/spec-1/issue"],
              status: "PASSED",
              summary: "页面符合来源中的要求。",
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-4",
        output: [
          functionCall(
            "finish_verification",
            { summary: "验证已完成。", verdict: "PASSED" },
            4,
          ),
        ],
      });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi.fn().mockResolvedValue({
        artifacts: [
          {
            id: screenshotRef.slice("artifact://".length),
            kind: "SCREENSHOT",
            metadata: {},
          },
        ],
        evidenceRefs: [screenshotRef],
        status: "SUCCEEDED",
      }),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    const outcome = await executor.execute(
      referencedTask,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "PASSED",
    });
    if (outcome.kind !== "VERIFICATION_COMPLETED") {
      throw new Error("Expected completed verification.");
    }
    expect(outcome.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "SCREENSHOT" }),
        expect.objectContaining({ kind: "BUSINESS_REFERENCE" }),
      ]),
    );
    expect(create.mock.calls[2]?.[0].input).toContainEqual(
      expect.objectContaining({
        output: expect.stringContaining("BUSINESS_REFERENCE"),
        type: "function_call_output",
      }),
    );
    expect(JSON.stringify(create.mock.calls[0]?.[0].input)).toContain(
      "reference://spec/spec-1/issue",
    );
  });

  it("resnapshots after an ambiguous locator and accepts a precise retarget", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-ambiguous-click",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              payload: { target: { selector: 'a[href="/solution/ai"]' } },
            },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-ref-click",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              locatorRecoveryToken: "call-1",
              payload: { target: { ref: "e42" } },
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-criterion",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [],
              status: "PASSED",
              summary: "已通过唯一 ref 打开目标页面。",
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-finish",
        output: [
          functionCall(
            "finish_verification",
            { summary: "目标页面验证完成。", verdict: "PASSED" },
            4,
          ),
        ],
      });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi
        .fn()
        .mockImplementation(
          (_lease, command: { commandType: string; payload: unknown }) => {
            if (command.commandType === "page.snapshot") {
              return Promise.resolve({
                result: {
                  content:
                    '- link "人工智能解决方案 了解详情" [ref=e42]\n- link "人工智能解决方案" [ref=e97]',
                },
                status: "SUCCEEDED",
              });
            }
            if (
              command.commandType === "page.click" &&
              JSON.stringify(command.payload).includes("selector")
            ) {
              return Promise.resolve({
                error: {
                  code: "LOCATOR_AMBIGUOUS",
                  details: {
                    candidates: [
                      { index: 0, name: "人工智能解决方案", ref: "e42" },
                      { index: 1, name: "人工智能解决方案", ref: "e97" },
                    ],
                    count: 2,
                  },
                  message: "Locator matched 2 elements.",
                  recoveryAction: "RESNAPSHOT_AND_RETARGET",
                  retryable: false,
                },
                status: "FAILED",
              });
            }
            return Promise.resolve({ status: "SUCCEEDED" });
          },
        ),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "PASSED",
    });
    expect(
      controlPlane.browserCommand.mock.calls.map((call) => call[1].commandType),
    ).toEqual(["page.click", "page.snapshot", "page.click"]);
    expect(JSON.stringify(create.mock.calls[1]?.[0].input)).toContain(
      "RESNAPSHOT_AND_RETARGET",
    );
    expect(JSON.stringify(create.mock.calls[1]?.[0].input)).toContain("e42");
  });

  it("prevents an unresolved locator ambiguity from becoming a product failure", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-ambiguous-click",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              payload: { target: { selector: 'a[href="/solution/ai"]' } },
            },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-invalid-failure",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [],
              status: "FAILED",
              summary: "无法点击目标入口。",
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-inconclusive",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [],
              status: "INCONCLUSIVE",
              summary: "自动化定位歧义，无法确认产品行为。",
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-finish",
        output: [
          functionCall(
            "finish_verification",
            {
              summary: "定位歧义导致验证结果不确定。",
              verdict: "INCONCLUSIVE",
            },
            4,
          ),
        ],
      });
    const controlPlane = {
      acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
      appendEvent: vi.fn().mockResolvedValue({}),
      browserCommand: vi
        .fn()
        .mockImplementation((_lease, command: { commandType: string }) =>
          Promise.resolve(
            command.commandType === "page.snapshot"
              ? {
                  result: { content: "- link [ref=e42]\n- link [ref=e97]" },
                  status: "SUCCEEDED",
                }
              : {
                  error: {
                    code: "LOCATOR_AMBIGUOUS",
                    message: "Locator matched 2 elements.",
                    recoveryAction: "RESNAPSHOT_AND_RETARGET",
                    retryable: false,
                  },
                  status: "FAILED",
                },
          ),
        ),
      releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
    };
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "INCONCLUSIVE",
    });
    expect(JSON.stringify(create.mock.calls[2]?.[0].input)).toContain(
      "不能据此记录产品 FAILED",
    );
  });

  it("settles only the criterion affected by locator recovery", async () => {
    const multiCriterionTask: RuntimeTaskLease = {
      ...task,
      snapshot: {
        ...task.snapshot,
        criteria: [
          ...task.snapshot.criteria,
          {
            description: "The footer remains visible.",
            id: "footer-visible",
            required: true,
            requiredEvidenceKinds: [],
          },
        ],
      },
    };
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-ambiguous-click",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              payload: { target: { selector: 'a[href="/solution/ai"]' } },
            },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-invalid-page-failure",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [],
              status: "FAILED",
              summary: "目标入口无法点击。",
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-page-inconclusive",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [],
              status: "INCONCLUSIVE",
              summary: "定位歧义，页面入口结果无法确认。",
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-footer-failure",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "footer-visible",
              evidenceRefs: [],
              status: "FAILED",
              summary: "页脚未显示。",
            },
            4,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-finish",
        output: [
          functionCall(
            "finish_verification",
            { summary: "页面结果不确定，页脚验证失败。", verdict: "FAILED" },
            5,
          ),
        ],
      });
    const controlPlane = locatorAmbiguousControlPlane();
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    const outcome = await executor.execute(
      multiCriterionTask,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      criteria: [
        { criterionId: "page-visible", status: "INCONCLUSIVE" },
        { criterionId: "footer-visible", status: "FAILED" },
      ],
      kind: "VERIFICATION_COMPLETED",
      verdict: "FAILED",
    });
  });

  it("does not clear locator recovery after an unrelated successful click", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-ambiguous-click",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              payload: { target: { selector: 'a[href="/solution/ai"]' } },
            },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-cookie-click",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              payload: { target: { selector: "#accept-cookie" } },
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-invalid-failure",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [],
              status: "FAILED",
              summary: "入口无法打开。",
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-inconclusive",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [],
              status: "INCONCLUSIVE",
              summary: "定位恢复未完成，无法确认入口行为。",
            },
            4,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-finish",
        output: [
          functionCall(
            "finish_verification",
            { summary: "定位恢复未完成。", verdict: "INCONCLUSIVE" },
            5,
          ),
        ],
      });
    const controlPlane = locatorAmbiguousControlPlane({
      successfulSelectors: ["#accept-cookie"],
    });
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "INCONCLUSIVE",
    });
    expect(JSON.stringify(create.mock.calls[2]?.[0].input)).toContain(
      "没有正确确认原定位恢复",
    );
    expect(JSON.stringify(create.mock.calls[3]?.[0].input)).toContain(
      "不能据此记录产品 FAILED",
    );
  });

  it("counts stale and invisible refs toward the two retarget limit", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-ambiguous-click",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              payload: { target: { selector: 'a[href="/solution/ai"]' } },
            },
            1,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-stale-ref",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              locatorRecoveryToken: "call-1",
              payload: { target: { ref: "e42" } },
            },
            2,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-invisible-ref",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              locatorRecoveryToken: "call-1",
              payload: { target: { ref: "e97" } },
            },
            3,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-third-ref",
        output: [
          functionCall(
            "browser_command",
            {
              commandType: "page.click",
              locatorRecoveryToken: "call-1",
              payload: { target: { ref: "e99" } },
            },
            4,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-inconclusive",
        output: [
          functionCall(
            "record_criterion",
            {
              criterionId: "page-visible",
              evidenceRefs: [],
              status: "INCONCLUSIVE",
              summary: "两次重新定位均失败，无法确认页面行为。",
            },
            5,
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-finish",
        output: [
          functionCall(
            "finish_verification",
            { summary: "重新定位次数已用完。", verdict: "INCONCLUSIVE" },
            6,
          ),
        ],
      });
    const controlPlane = locatorAmbiguousControlPlane({
      refErrors: {
        e42: "ELEMENT_NOT_FOUND",
        e97: "ELEMENT_NOT_VISIBLE",
      },
    });
    const executor = new BrowserVerificationExecutor(
      modelFactory(create),
      controlPlane as never,
      12,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      kind: "VERIFICATION_COMPLETED",
      verdict: "INCONCLUSIVE",
    });
    expect(
      controlPlane.browserCommand.mock.calls.map((call) => call[1].commandType),
    ).toEqual([
      "page.click",
      "page.snapshot",
      "page.click",
      "page.snapshot",
      "page.click",
    ]);
    expect(controlPlane.browserCommand.mock.calls[2]?.[1].payload).toEqual({
      target: { ref: "e42" },
    });
    expect(controlPlane.browserCommand.mock.calls[4]?.[1].payload).toEqual({
      target: { ref: "e97" },
    });
    expect(JSON.stringify(create.mock.calls[3]?.[0].input)).toContain(
      'retargetAttempts\\":2',
    );
    expect(JSON.stringify(create.mock.calls[4]?.[0].input)).toContain(
      "已用完两次重新定位机会",
    );
  });
});

function locatorAmbiguousControlPlane(options?: {
  refErrors?: Record<string, string>;
  successfulSelectors?: string[];
}) {
  return {
    acquireBrowser: vi.fn().mockResolvedValue(acquiredBrowser),
    appendEvent: vi.fn().mockResolvedValue({}),
    browserCommand: vi.fn().mockImplementation(
      (
        _lease,
        command: {
          commandType: string;
          payload?: { target?: { ref?: string; selector?: string } };
        },
      ) => {
        if (command.commandType === "page.snapshot") {
          return Promise.resolve({
            result: { content: "- link [ref=e42]\n- link [ref=e97]" },
            status: "SUCCEEDED",
          });
        }
        const ref = command.payload?.target?.ref;
        const refError = ref ? options?.refErrors?.[ref] : undefined;
        if (refError) {
          return Promise.resolve({
            error: {
              code: refError,
              message: `${ref} cannot be used.`,
              retryable: true,
            },
            status: "FAILED",
          });
        }
        const selector = command.payload?.target?.selector;
        if (selector && options?.successfulSelectors?.includes(selector)) {
          return Promise.resolve({ status: "SUCCEEDED" });
        }
        return Promise.resolve({
          error: {
            code: "LOCATOR_AMBIGUOUS",
            message: "Locator matched 2 elements.",
            recoveryAction: "RESNAPSHOT_AND_RETARGET",
            retryable: false,
          },
          status: "FAILED",
        });
      },
    ),
    releaseBrowser: vi.fn().mockResolvedValue({ released: true }),
  };
}
