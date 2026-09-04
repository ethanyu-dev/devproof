import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskLease } from "@devproof/agent-runtime-protocol";

import { BrowserVerificationExecutor } from "./browser-verification.executor.js";

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
    environment: { targetUrl: "https://example.com" },
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
      ...task.snapshot,
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
