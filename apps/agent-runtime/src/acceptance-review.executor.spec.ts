import { describe, expect, it, vi } from "vitest";
import { executeAcceptanceReview } from "./acceptance-review.executor.js";
import type { AcceptanceReviewLease } from "@devproof/agent-runtime-protocol";
const task: AcceptanceReviewLease = {
  id: "review",
  leaseToken: "lease",
  deadlineAt: new Date(Date.now() + 480000).toISOString(),
  context: JSON.stringify({
    score: 80,
    recommendation: "NEEDS_VALIDATION",
    assessment: { findings: [{ key: "gap-1" }] },
  }),
  modelCandidates: [
    {
      modelId: "model-1",
      apiKey: "test-secret",
      baseUrl: "https://model.example",
      displayName: "test",
    },
  ],
};
const review = {
  score: 80,
  recommendation: "NEEDS_VALIDATION",
  summary: "4 项已通过",
  releaseReason: "补充验证默认开关",
  focusAreas: [
    {
      criterionKey: "gap-1",
      impact: "默认状态未确认",
      nextStep: "补充开关截图",
    },
  ],
};
const completion = (result: unknown) => ({
  id: "reply",
  message: {
    role: "assistant",
    tool_calls: [
      {
        type: "function",
        id: "call",
        function: {
          name: "submit_acceptance_review",
          arguments: JSON.stringify(result),
        },
      },
    ],
  },
});
describe("bounded AI report review", () => {
  it("produces grounded commentary using only the report and a single result tool", async () => {
    const complete = vi.fn().mockResolvedValue(completion(review));
    expect(
      await executeAcceptanceReview(
        task,
        () => ({ complete }),
        new AbortController().signal,
      ),
    ).toMatchObject({ result: review, model: "model-1" });
    const request = complete.mock.calls[0]![0];
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0].function.name).toBe("submit_acceptance_review");
    expect(request.messages[1].content).not.toContain("test-secret");
  });
  it.each([
    { ...review, score: 100 },
    { ...review, recommendation: "RECOMMENDED" },
    {
      ...review,
      focusAreas: [{ ...review.focusAreas[0], criterionKey: "fabricated" }],
    },
  ])("rejects changed scoring or fabricated findings", async (result) => {
    await expect(
      executeAcceptanceReview(
        task,
        () => ({ complete: vi.fn().mockResolvedValue(completion(result)) }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("未生成有效结果");
  });
  it("bounds failures and never exposes provider secrets", async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(new Error("api_key=test-secret"));
    await expect(
      executeAcceptanceReview(
        task,
        () => ({ complete }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("证据评分");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
