import { describe, expect, it, vi } from "vitest";
import {
  TaskAcceptanceReviewService,
  validateAcceptanceReview,
  acceptanceReviewContext,
} from "./task-acceptance-review.service.js";
import type { TaskAcceptanceReport } from "@devproof/contracts";
const report = {
  taskId: "task-1",
  revision: "revision-1",
  final: true,
  title: "白名单",
  scope: "REQUIREMENT",
  verdict: "INCONCLUSIVE",
  assessment: {
    score: 80,
    recommendation: "NEEDS_VALIDATION",
    findings: [{ key: "gap-1" }],
  },
  cases: [{ lifecycle: "COMPLETED", criteria: [], issues: [] }],
  requirements: [],
  issues: [],
} as unknown as TaskAcceptanceReport;
const result = {
  score: 80,
  recommendation: "NEEDS_VALIDATION",
  summary: "4 项通过，1 项待确认",
  releaseReason: "补验默认状态",
  focusAreas: [
    {
      criterionKey: "gap-1",
      impact: "尚不知默认状态",
      nextStep: "打开弹窗取证",
    },
  ],
};
describe("cached acceptance review", () => {
  it("validates scoring gates and finding references independently of the model", () => {
    expect(validateAcceptanceReview(report, result)).toEqual(result);
    for (const change of [
      { score: 100 },
      { recommendation: "RECOMMENDED" },
      { focusAreas: [{ ...result.focusAreas[0], criterionKey: "invented" }] },
      { focusAreas: [result.focusAreas[0], result.focusAreas[0]] },
    ])
      expect(() =>
        validateAcceptanceReview(report, { ...result, ...change }),
      ).toThrow();
  });
  it("does not enqueue before all cases are terminal", async () => {
    const prisma = {
      taskExecution: { count: vi.fn() },
      taskAcceptanceReview: { upsert: vi.fn() },
    };
    const service = new TaskAcceptanceReviewService(
      prisma as never,
      {} as never,
    );
    await service.attach("team-1", { ...report, final: false });
    await service.attach("team-1", {
      ...report,
      cases: [{ lifecycle: "RUNNING" }] as never,
    });
    expect(prisma.taskAcceptanceReview.upsert).not.toHaveBeenCalled();
  });
  it("isolates ownership and caches by immutable report revision", async () => {
    const upsert = vi.fn().mockResolvedValue({
      status: "COMPLETED",
      result,
      model: "review-model",
      updatedAt: new Date(),
      error: null,
    });
    const count = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const service = new TaskAcceptanceReviewService(
      { taskExecution: { count }, taskAcceptanceReview: { upsert } } as never,
      {} as never,
    );
    expect(await service.attach("other-team", report)).toBe(report);
    expect(upsert).not.toHaveBeenCalled();
    expect(await service.attach("team-1", report)).toMatchObject({
      review: { status: "COMPLETED", model: "review-model" },
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          taskExecutionId_revision: {
            taskExecutionId: "task-1",
            revision: "revision-1",
          },
        },
        update: {},
      }),
    );
    expect(count).toHaveBeenLastCalledWith({
      where: { id: "task-1", teamId: "team-1" },
    });
  });
  it("retains the score if storage for AI review is unavailable", async () => {
    const service = new TaskAcceptanceReviewService(
      {
        taskExecution: {
          count: vi.fn().mockRejectedValue(new Error("unavailable")),
        },
      } as never,
      {} as never,
    );
    expect(await service.attach("team-1", report)).toMatchObject({
      assessment: { score: 80 },
      review: { status: "FAILED" },
    });
  });
  it("rejects a late outcome after another worker owns the lease", async () => {
    const service = new TaskAcceptanceReviewService(
      {
        taskAcceptanceReview: {
          findFirst: vi.fn().mockResolvedValue({
            leaseToken: "new-owner",
            leaseOwner: "worker-2",
          }),
        },
      } as never,
      {} as never,
    );
    await expect(
      service.complete("team-1", "review-1", {
        workerId: "worker-1",
        leaseToken: "old-owner",
        result: result as never,
      }),
    ).rejects.toThrow("lease was lost");
  });
  it("does not send raw browser snapshots, credentials or artifact URLs to the synthesis model", () => {
    const context = acceptanceReviewContext(report);
    expect(context).toContain("NEEDS_VALIDATION");
    expect(context).not.toContain("apiKey");
    expect(context).not.toContain("modelCandidates");
  });
});
