import { describe, expect, it, vi } from "vitest";

import type { RuntimePostRunAnalysisTaskLease } from "@devproof/agent-runtime-protocol";

import { PostRunAnalysisExecutor } from "./post-run-analysis.executor.js";

const task: RuntimePostRunAnalysisTaskLease = {
  fencingToken: "3",
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  leaseToken: "70844616-602c-475b-95f6-393015b82ed1",
  snapshot: {
    analysisId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
    analyzerVersion: "post-run-analysis-v3",
    attemptNumber: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    input: {
      byteSize: 120,
      completeness: { browserExecutionsFinalized: true },
      manifest: {
        evidenceLocations: [
          {
            attemptNumber: 1,
            evidenceRef: "artifact://network-log",
            runId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
            runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
          },
        ],
        evidenceRefs: ["artifact://network-log"],
        runs: [
          {
            attempts: [{ attemptId: "attempt-1", number: 1 }],
            browserExecutions: [
              {
                attemptId: "attempt-1",
                runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
              },
            ],
            runId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
          },
        ],
        schemaVersion: "devproof.execution-manifest.v2",
        stages: [],
      },
      schemaVersion: "devproof.task-logs.v2",
      sha256: "a".repeat(64),
    },
    modelCandidates: [
      {
        apiKey: "sk-test-model-secret",
        baseUrl: "https://gateway.example.com/v1",
        displayName: "Test model",
        modelId: "gpt-test",
      },
    ],
    sourceRef: "ENG-123",
    taskExecutionId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
    teamId: "6f090d88-8987-487f-8338-1a734beab6a6",
    title: "退款流程验证",
    traceId: "1234567890abcdef1234567890abcdef",
  },
  taskId: "cc61de8d-cf29-4561-b2cd-c67c304668a5",
};

const lease = {
  fencingToken: task.fencingToken,
  leaseToken: task.leaseToken,
  taskId: task.taskId,
  workerId: "worker-1",
};

function call(name: string, arguments_: unknown, id: string) {
  return {
    arguments: JSON.stringify(arguments_),
    call_id: id,
    name,
    type: "function_call" as const,
  };
}

describe("PostRunAnalysisExecutor", () => {
  it("reads targeted evidence from the manifest without scanning the full bundle", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-1",
        output: [
          call(
            "read_analysis_evidence",
            {
              analysisSummary: "检查失败请求正文。",
              cursor: 0,
              evidenceRef: "artifact://network-log",
              maxBytes: 32_000,
            },
            "call-1",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-2",
        output: [
          call(
            "finish_analysis",
            {
              report: {
                findings: [
                  {
                    attemptNumber: 1,
                    category: "PRODUCT_BUG",
                    component: "Refund API",
                    confidence: 0.94,
                    evidenceRefs: ["artifact://network-log"],
                    failureClass: "INVALID_STATE_TRANSITION",
                    impact: "退款操作无法完成。",
                    phase: "SPEC_EXECUTION.BROWSER_COMMAND",
                    recommendation: "修正状态转换并增加回归测试。",
                    rootCause: "服务端拒绝了合法的退款状态转换。",
                    runId: "9be3dc23-9a52-4a97-b6ca-6df0af16d815",
                    runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
                    severity: "HIGH",
                    title: "退款状态转换失败",
                  },
                ],
                summary: "发现一项有网络日志支持的产品问题。",
              },
            },
            "call-2",
          ),
        ],
      });
    const appendPostRunAnalysisEvent = vi.fn().mockResolvedValue({
      accepted: true,
    });
    const readPostRunAnalysisBundle = vi.fn().mockResolvedValue({
      body: '{"evidenceRef":"artifact://network-log"}',
      contentType: "application/json",
      nextCursor: null,
      sha256: "a".repeat(64),
      totalBytes: 120,
      truncated: false,
    });
    const readPostRunAnalysisEvidence = vi.fn().mockResolvedValue({
      body: '{"status":500}',
      contentType: "application/json",
      evidenceRef: "artifact://network-log",
      nextCursor: null,
      sha256: "b".repeat(64),
      totalBytes: 14,
      truncated: false,
    });
    const executor = new PostRunAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      {
        appendPostRunAnalysisEvent,
        readPostRunAnalysisBundle,
        readPostRunAnalysisEvidence,
      } as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome.kind).toBe("ANALYSIS_COMPLETED");
    expect(readPostRunAnalysisBundle).not.toHaveBeenCalled();
    expect(readPostRunAnalysisEvidence).toHaveBeenCalledOnce();
    expect(
      appendPostRunAnalysisEvent.mock.calls.map((entry) => entry[1]),
    ).toEqual(
      expect.arrayContaining([
        "analysis.evidence.read",
        "analysis.report.generated",
      ]),
    );
    const firstRequest = create.mock.calls[0]?.[0] as {
      input: Array<{ content?: string }>;
      tools: Array<{ name: string }>;
    };
    expect(firstRequest.input[0]?.content).toContain("不可信数据");
    expect(firstRequest.tools.map((tool) => tool.name)).toContain(
      "read_analysis_evidence",
    );
  });

  it("allows a model to jump to a relevant range in a large text artifact", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-head",
        output: [
          call(
            "read_analysis_evidence",
            {
              analysisSummary: "先读取文本证据开头并获取总长度。",
              cursor: 0,
              evidenceRef: "artifact://network-log",
              maxBytes: 1_024,
            },
            "call-head",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-tail",
        output: [
          call(
            "read_analysis_evidence",
            {
              analysisSummary: "开头不足，定点检查异常发生时的尾部范围。",
              cursor: 9_000,
              evidenceRef: "artifact://network-log",
              maxBytes: 1_024,
            },
            "call-tail",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-finished",
        output: [
          call(
            "finish_analysis",
            {
              report: {
                findings: [],
                summary: "定点范围未显示达到阈值的问题。",
              },
            },
            "call-finished",
          ),
        ],
      });
    const readPostRunAnalysisEvidence = vi
      .fn()
      .mockResolvedValueOnce({
        body: "head",
        contentType: "text/plain",
        evidenceRef: "artifact://network-log",
        nextCursor: 1_024,
        sha256: "b".repeat(64),
        totalBytes: 10_000,
        truncated: true,
      })
      .mockResolvedValueOnce({
        body: "tail",
        contentType: "text/plain",
        evidenceRef: "artifact://network-log",
        nextCursor: null,
        sha256: "b".repeat(64),
        totalBytes: 10_000,
        truncated: false,
      });
    const executor = new PostRunAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      {
        appendPostRunAnalysisEvent: vi.fn().mockResolvedValue({
          accepted: true,
        }),
        readPostRunAnalysisEvidence,
      } as never,
      10,
    );

    await expect(
      executor.execute(task, lease, new AbortController().signal),
    ).resolves.toMatchObject({ kind: "ANALYSIS_COMPLETED" });

    expect(readPostRunAnalysisEvidence).toHaveBeenNthCalledWith(
      2,
      lease,
      expect.objectContaining({ cursor: 9_000 }),
      expect.any(AbortSignal),
    );
  });

  it("returns a tool error instead of rereading past the completed bundle", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-bundle",
        output: [
          call(
            "read_analysis_bundle",
            {
              analysisSummary: "读取日志包并确认是否存在额外异常。",
              cursor: 0,
              maxBytes: 1_024,
            },
            "call-bundle",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-reread",
        output: [
          call(
            "read_analysis_bundle",
            {
              analysisSummary: "尝试继续读取已经结束的日志包。",
              cursor: 120,
              maxBytes: 1_024,
            },
            "call-reread",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-finished",
        output: [
          call(
            "finish_analysis",
            {
              report: {
                findings: [],
                summary: "日志包已经完整读取，没有发现达到阈值的问题。",
              },
            },
            "call-finished",
          ),
        ],
      });
    const readPostRunAnalysisBundle = vi.fn().mockResolvedValue({
      body: "{}",
      contentType: "application/json",
      nextCursor: null,
      sha256: "a".repeat(64),
      totalBytes: 120,
      truncated: false,
    });
    const executor = new PostRunAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      {
        appendPostRunAnalysisEvent: vi.fn().mockResolvedValue({
          accepted: true,
        }),
        readPostRunAnalysisBundle,
      } as never,
      10,
    );

    await expect(
      executor.execute(task, lease, new AbortController().signal),
    ).resolves.toMatchObject({ kind: "ANALYSIS_COMPLETED" });

    expect(readPostRunAnalysisBundle).toHaveBeenCalledOnce();
    expect(JSON.stringify(create.mock.calls[2]?.[0])).toContain(
      "日志包已完整读取",
    );
  });

  it("does not scan a multi-megabyte bundle when the manifest is sufficient", async () => {
    const totalBytes = 6_303_712;
    const requestSizes: number[] = [];
    const create = vi
      .fn()
      .mockImplementation(
        async (request: {
          input: Array<{ output?: string; type?: string }>;
        }) => {
          requestSizes.push(Buffer.byteLength(JSON.stringify(request.input)));
          return {
            id: "response-finished",
            output: [
              call(
                "finish_analysis",
                {
                  report: {
                    findings: [],
                    summary: "Manifest 未显示需要进一步读取的异常证据。",
                  },
                },
                "call-finished",
              ),
            ],
          };
        },
      );
    const readPostRunAnalysisBundle = vi.fn();
    const executor = new PostRunAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      {
        appendPostRunAnalysisEvent: vi.fn().mockResolvedValue({
          accepted: true,
        }),
        readPostRunAnalysisBundle,
      } as never,
      100,
    );

    const outcome = await executor.execute(
      {
        ...task,
        snapshot: {
          ...task.snapshot,
          input: { ...task.snapshot.input, byteSize: totalBytes },
        },
      },
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({ kind: "ANALYSIS_COMPLETED" });
    expect(create).toHaveBeenCalledOnce();
    expect(readPostRunAnalysisBundle).not.toHaveBeenCalled();
    expect(Math.max(...requestSizes)).toBeLessThan(40_000);
  });

  it("loads a truncated manifest in bounded pages before accepting a report", async () => {
    const fullManifest = JSON.stringify(task.snapshot.input.manifest);
    const split = Math.floor(fullManifest.length / 2);
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-manifest-1",
        output: [
          call(
            "read_analysis_manifest",
            {
              analysisSummary: "读取执行索引第一页。",
              cursor: 0,
              maxBytes: 1_024,
            },
            "call-manifest-1",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-manifest-2",
        output: [
          call(
            "read_analysis_manifest",
            {
              analysisSummary: "继续读取执行索引。",
              cursor: split,
              maxBytes: 1_024,
            },
            "call-manifest-2",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-finished",
        output: [
          call(
            "finish_analysis",
            {
              report: {
                findings: [],
                summary: "完整索引未显示需要报告的问题。",
              },
            },
            "call-finished",
          ),
        ],
      });
    const readPostRunAnalysisManifest = vi
      .fn()
      .mockResolvedValueOnce({
        body: fullManifest.slice(0, split),
        contentType: "application/vnd.devproof.execution-manifest+json",
        nextCursor: split,
        sha256: "c".repeat(64),
        totalBytes: fullManifest.length,
        truncated: true,
      })
      .mockResolvedValueOnce({
        body: fullManifest.slice(split),
        contentType: "application/vnd.devproof.execution-manifest+json",
        nextCursor: null,
        sha256: "c".repeat(64),
        totalBytes: fullManifest.length,
        truncated: false,
      });
    const executor = new PostRunAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      {
        appendPostRunAnalysisEvent: vi.fn().mockResolvedValue({
          accepted: true,
        }),
        readPostRunAnalysisManifest,
      } as never,
      10,
    );

    const outcome = await executor.execute(
      {
        ...task,
        snapshot: {
          ...task.snapshot,
          input: {
            ...task.snapshot.input,
            manifest: {
              evidenceRefCount: 1,
              manifestByteSize: fullManifest.length,
              truncated: true,
            },
          },
        },
      },
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({ kind: "ANALYSIS_COMPLETED" });
    expect(readPostRunAnalysisManifest).toHaveBeenCalledTimes(2);
    const firstRequest = create.mock.calls[0]?.[0] as {
      input: Array<{ content?: string }>;
    };
    expect(Buffer.byteLength(JSON.stringify(firstRequest.input))).toBeLessThan(
      40_000,
    );
  });

  it("requires every cited evidenceRef to exist and be read before submission", async () => {
    const validRef = "artifact://network-log";
    const report = (evidenceRef: string) => ({
      findings: [
        {
          attemptNumber: 1,
          category: "PRODUCT_BUG",
          component: "Refund API",
          confidence: 0.94,
          evidenceRefs: [evidenceRef],
          failureClass: "INVALID_STATE_TRANSITION",
          impact: "退款操作无法完成。",
          phase: "SPEC_EXECUTION.BROWSER_COMMAND",
          recommendation: "修正状态转换并增加回归测试。",
          rootCause: "服务端拒绝了合法的退款状态转换。",
          runId: null,
          runtimeId: null,
          severity: "HIGH",
          title: "退款状态转换失败",
        },
      ],
      summary: "发现一项有证据支持的问题。",
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-invalid",
        output: [
          call(
            "finish_analysis",
            { report: report("artifact://invented") },
            "call-invalid",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-unread",
        output: [
          call("finish_analysis", { report: report(validRef) }, "call-unread"),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-read",
        output: [
          call(
            "read_analysis_evidence",
            {
              analysisSummary: "核验 Manifest 中存在的网络日志。",
              cursor: 0,
              evidenceRef: validRef,
              maxBytes: 32_000,
            },
            "call-read",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-repaired",
        output: [
          call(
            "finish_analysis",
            { report: report(validRef) },
            "call-repaired",
          ),
        ],
      });
    const appendPostRunAnalysisEvent = vi.fn().mockResolvedValue({
      accepted: true,
    });
    const executor = new PostRunAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      {
        appendPostRunAnalysisEvent,
        readPostRunAnalysisEvidence: vi.fn().mockResolvedValue({
          body: '{"status":500}',
          contentType: "application/json",
          evidenceRef: validRef,
          nextCursor: null,
          sha256: "b".repeat(64),
          totalBytes: 14,
          truncated: false,
        }),
      } as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      kind: "ANALYSIS_COMPLETED",
      report: { findings: [{ evidenceRefs: [validRef] }] },
    });
    expect(create).toHaveBeenCalledTimes(4);
    expect(
      appendPostRunAnalysisEvent.mock.calls.map((entry) => entry[1]),
    ).toContain("analysis.report.validation_failed");
    expect(JSON.stringify(create.mock.calls[2]?.[0])).toContain(
      "unreadEvidenceRefs",
    );
  });

  it("feeds an invalid runtime location back to the model before submission", async () => {
    const finding = (runId: string | null) => ({
      attemptNumber: runId ? 1 : null,
      category: "PRODUCT_BUG" as const,
      component: "Refund API",
      confidence: 0.94,
      evidenceRefs: ["artifact://network-log"],
      failureClass: "INVALID_STATE_TRANSITION",
      impact: "退款操作无法完成。",
      phase: "SPEC_EXECUTION.BROWSER_COMMAND",
      recommendation: "修正状态转换并增加回归测试。",
      rootCause: "服务端拒绝了合法的退款状态转换。",
      runId,
      runtimeId: null,
      severity: "HIGH" as const,
      title: "退款状态转换失败",
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-read-evidence",
        output: [
          call(
            "read_analysis_evidence",
            {
              analysisSummary: "先核验浏览器命令证据。",
              cursor: 0,
              evidenceRef: "artifact://network-log",
              maxBytes: 32_000,
            },
            "call-read-evidence",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-invalid-location",
        output: [
          call(
            "finish_analysis",
            {
              report: {
                findings: [finding("32aa246a-01ae-4541-b0b3-ab02043ead38")],
                summary: "首次报告使用了错误定位。",
              },
            },
            "call-invalid-location",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-repaired-location",
        output: [
          call(
            "finish_analysis",
            {
              report: {
                findings: [finding(null)],
                summary: "已移除无法确认的运行定位。",
              },
            },
            "call-repaired-location",
          ),
        ],
      });
    const appendPostRunAnalysisEvent = vi.fn().mockResolvedValue({
      accepted: true,
    });
    const executor = new PostRunAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      {
        appendPostRunAnalysisEvent,
        readPostRunAnalysisEvidence: vi.fn().mockResolvedValue({
          body: '{"status":500}',
          contentType: "application/json",
          evidenceRef: "artifact://network-log",
          nextCursor: null,
          sha256: "b".repeat(64),
          totalBytes: 14,
          truncated: false,
        }),
      } as never,
      10,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      kind: "ANALYSIS_COMPLETED",
      report: { findings: [{ runId: null }] },
    });
    expect(create).toHaveBeenCalledTimes(3);
    const repairRequest = create.mock.calls[2]?.[0] as {
      input: Array<{ output?: string }>;
    };
    expect(JSON.stringify(repairRequest.input)).toContain(
      "references unknown runId",
    );
    expect(
      appendPostRunAnalysisEvent.mock.calls.map((entry) => entry[1]),
    ).toContain("analysis.report.validation_failed");
  });

  it("does not mark evidence as read when its audit event cannot be persisted", async () => {
    const report = {
      findings: [
        {
          attemptNumber: null,
          category: "PRODUCT_BUG" as const,
          component: "Refund API",
          confidence: 0.94,
          evidenceRefs: ["artifact://network-log"],
          failureClass: "INVALID_STATE_TRANSITION",
          impact: "退款操作无法完成。",
          phase: "SPEC_EXECUTION.BROWSER_COMMAND",
          recommendation: "修正状态转换并增加回归测试。",
          rootCause: "服务端拒绝了合法的退款状态转换。",
          runId: null,
          runtimeId: null,
          severity: "HIGH" as const,
          title: "退款状态转换失败",
        },
      ],
      summary: "发现一项问题。",
    };
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "response-read",
        output: [
          call(
            "read_analysis_evidence",
            {
              analysisSummary: "核验网络日志。",
              cursor: 0,
              evidenceRef: "artifact://network-log",
              maxBytes: 32_000,
            },
            "call-read",
          ),
        ],
      })
      .mockResolvedValueOnce({
        id: "response-unread-report",
        output: [call("finish_analysis", { report }, "call-unread-report")],
      })
      .mockResolvedValueOnce({
        id: "response-empty-report",
        output: [
          call(
            "finish_analysis",
            {
              report: {
                findings: [],
                summary: "证据读取未完成，本次不生成问题。",
              },
            },
            "call-empty-report",
          ),
        ],
      });
    const appendPostRunAnalysisEvent = vi.fn(
      async (_lease: unknown, kind: string) => {
        if (kind === "analysis.evidence.read") {
          throw new Error("event store unavailable");
        }
        return { accepted: true };
      },
    );
    const executor = new PostRunAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      {
        appendPostRunAnalysisEvent,
        readPostRunAnalysisEvidence: vi.fn().mockResolvedValue({
          body: '{"status":500}',
          contentType: "application/json",
          evidenceRef: "artifact://network-log",
          nextCursor: null,
          sha256: "b".repeat(64),
          totalBytes: 14,
          truncated: false,
        }),
      } as never,
      10,
    );

    await expect(
      executor.execute(task, lease, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: "ANALYSIS_COMPLETED",
      report: { findings: [] },
    });
    expect(JSON.stringify(create.mock.calls[2]?.[0])).toContain(
      "unreadEvidenceRefs",
    );
  });

  it("stops repeated text-only responses at the model turn limit", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "response-without-tool-call",
      output: [
        {
          content: "仍在分析中。",
          role: "assistant",
          type: "message",
        },
      ],
    });
    const executor = new PostRunAnalysisExecutor(
      () => ({ responses: { create } }) as never,
      {
        appendPostRunAnalysisEvent: vi.fn().mockResolvedValue({
          accepted: true,
        }),
      } as never,
      3,
    );

    const outcome = await executor.execute(
      task,
      lease,
      new AbortController().signal,
    );

    expect(create).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({
      error: {
        code: "POST_RUN_ANALYSIS_MODEL_TURN_LIMIT_EXCEEDED",
        details: { callCount: 0, modelTurnCount: 3 },
      },
      kind: "RETRYABLE_FAILURE",
    });
  });
});
