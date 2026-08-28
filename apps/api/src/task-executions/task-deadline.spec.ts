import { describe, expect, it } from "vitest";

import { refreshedTaskDeadline } from "./task-deadline.js";

describe("refreshedTaskDeadline", () => {
  it("restarts the full Issue task window from human resume", () => {
    const resumedAt = new Date("2026-08-28T02:00:00.000Z");

    expect(
      refreshedTaskDeadline(
        {
          idempotencyKey: "issue-resume-key",
          issueRef: "PROD-6781",
          kind: "ISSUE_SPEC",
        },
        resumedAt,
      ).toISOString(),
    ).toBe("2026-08-28T04:00:00.000Z");
  });

  it("uses the configured Direct task window", () => {
    const resumedAt = new Date("2026-08-28T02:00:00.000Z");

    expect(
      refreshedTaskDeadline(
        {
          idempotencyKey: "direct-resume-key",
          kind: "DIRECT_RUN",
          run: {
            criteria: [
              {
                description: "The page is visible.",
                id: "visible",
                required: true,
                requiredEvidenceKinds: [],
              },
            ],
            deadlineSeconds: 600,
            goal: "Verify the page",
            idempotencyKey: "direct-run-resume-key",
            source: { kind: "API" },
          },
        },
        resumedAt,
      ).toISOString(),
    ).toBe("2026-08-28T02:10:00.000Z");
  });
});
