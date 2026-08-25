import { describe, expect, it, vi } from "vitest";

import { SpecAnalysisRuntimeService } from "./spec-analysis-runtime.service.js";

const teamId = "6f090d88-8987-487f-8338-1a734beab6a6";
const attemptId = "cc61de8d-cf29-4561-b2cd-c67c304668a5";
const taskExecutionId = "9be3dc23-9a52-4a97-b6ca-6df0af16d815";
const leaseToken = "70844616-602c-475b-95f6-393015b82ed1";

function issueTaskInput() {
  return {
    analysisMaxAttempts: 3,
    browserPolicy: {
      availabilityPolicy: "WAIT",
      profile: { mode: "EPHEMERAL" },
      requiredCapabilities: ["browser"],
    },
    deadlineSeconds: 7_200,
    hitlPolicy: {
      enabled: false,
      notificationChannels: [],
      onTimeout: "INCONCLUSIVE",
      timeoutSeconds: 3_600,
    },
    idempotencyKey: "spec-agent-test",
    issueRef: "ENG-123",
    kind: "ISSUE_SPEC",
    retryPolicy: { maxAttempts: 3, retryOn: ["PROVIDER"] },
  };
}

describe("SpecAnalysisRuntimeService", () => {
  it("executes Linear through the control plane and persists an immutable source", async () => {
    const sourceCreate = vi.fn().mockResolvedValue({ id: "source-1" });
    const prisma = {
      taskAnalysisSource: {
        aggregate: vi.fn().mockResolvedValue({
          _count: { _all: 0 },
          _sum: { byteSize: null },
        }),
        create: sourceCreate,
      },
      taskStageAttempt: {
        findUnique: vi.fn().mockResolvedValue({
          fencingToken: 4n,
          id: attemptId,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          leaseOwner: "worker-1",
          leaseToken,
          stage: {
            taskExecution: {
              id: taskExecutionId,
              inputSnapshot: issueTaskInput(),
              teamId,
            },
          },
          status: "RUNNING",
        }),
      },
    };
    const linearResult = {
      issue: {
        assignee: null,
        description: "Users must be able to request a refund.",
        id: "linear-issue-1",
        identifier: "ENG-123",
        labels: ["payments"],
        priority: 2,
        state: "In Review",
        title: "Refund flow",
        url: "https://linear.app/acme/issue/ENG-123/refund-flow",
      },
      pullRequestUrls: ["https://github.com/acme/web/pull/42"],
    };
    const service = new SpecAnalysisRuntimeService(
      prisma as never,
      {} as never,
      { getIssue: vi.fn().mockResolvedValue(linearResult) } as never,
      {} as never,
      {} as never,
    );

    const output = await service.executeTool(teamId, attemptId, {
      arguments: { analysisSummary: "Read the authoritative Issue." },
      callId: "call-1",
      fencingToken: "4",
      leaseToken,
      name: "linear_get_issue",
      workerId: "worker-1",
    });

    expect(output.sourceRefs).toHaveLength(1);
    expect(output.sourceRefs[0]).toMatchObject({
      kind: "LINEAR_ISSUE",
      label: "ENG-123 · Refund flow",
    });
    expect(sourceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: linearResult,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        kind: "LINEAR_ISSUE",
        stageAttemptId: attemptId,
        taskExecutionId,
        teamId,
      }),
    });
  });
});
