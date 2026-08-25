import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskLease } from "@devproof/agent-runtime-protocol";

import { BrowserVerificationExecutor } from "./browser-verification.executor.js";

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
    const adaptiveTask: RuntimeTaskLease = {
      ...task,
      snapshot: {
        ...task.snapshot,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
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
      .mockResolvedValueOnce({
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

  it("waits for browser capacity within the same Runtime task", async () => {
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
      acquireBrowser: vi
        .fn()
        .mockResolvedValueOnce({
          browserExecutionId: "ab91fa7b-afd8-42be-982b-e860de0fca67",
          reason: "NO_AVAILABLE_SLOT",
          retryAfterMs: 1,
          status: "WAITING_CAPACITY",
        })
        .mockResolvedValueOnce(acquiredBrowser),
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
    expect(controlPlane.acquireBrowser).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(controlPlane.releaseBrowser).not.toHaveBeenCalled();
  });

  it("stops a capacity wait when the Runtime task is cancelled", async () => {
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
    const controller = new AbortController();

    const execution = executor.execute(task, lease, controller.signal);
    await vi.waitFor(() =>
      expect(controlPlane.acquireBrowser).toHaveBeenCalledTimes(1),
    );
    controller.abort(new Error("Run cancellation requested."));

    await expect(execution).rejects.toThrow("Run cancellation requested.");
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
});
