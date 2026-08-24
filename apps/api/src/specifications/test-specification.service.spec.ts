import { describe, expect, it, vi } from "vitest";

import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { TestSpecificationService } from "./test-specification.service.js";

const current: ToolAuthContext = {
  credential: {
    id: "credential-1",
    name: "Test",
    scopes: ["run:read", "run:write", "run:cancel"],
  },
  team: { id: "team-1", name: "DevProof", slug: "devproof" },
};

const definition = {
  authRole: "default",
  evidence: [
    { description: "Capture the result", kind: "SCREENSHOT" as const },
    {
      description: "Link the source requirement",
      kind: "BUSINESS_REFERENCE" as const,
    },
  ],
  expected: ["The result is visible."],
  name: "Visible result",
  preconditions: ["The deployment is available."],
  rationale: "Covers the primary business result.",
  steps: [{ action: "Open the page", order: 1 }],
};

function setup(createRun: ReturnType<typeof vi.fn>) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    generatedTestCase: { updateMany },
    testSpecification: {
      findFirst: vi.fn().mockResolvedValue({
        cases: [
          {
            definition,
            generationVersion: 2,
            id: "case-1",
          },
        ],
        currentVersion: 2,
        context: {
          issue: {
            description: "The result must be visible.",
            id: "issue-1",
            identifier: "ENG-123",
            labels: [],
            priority: null,
            state: "In Review",
            title: "Timestamp input",
            url: "https://linear.app/acme/issue/ENG-123",
          },
          knowledge: [],
          pullRequests: [
            {
              body: "Implements the visible result.",
              changedFiles: ["src/page.tsx"],
              id: "pr-42",
              isPrimary: true,
              number: 42,
              organization: "acme",
              repository: "acme/web",
              title: "Show result",
              url: "https://github.com/acme/web/pull/42",
            },
          ],
          resolution: { completeness: "COMPLETE", diagnostics: [] },
        },
        id: "specification-1",
        issueIdentifier: "ENG-123",
        issueTitle: "Timestamp input",
        targetUrl: "https://preview.example.com/app",
      }),
    },
  };
  const service = new TestSpecificationService(
    prisma as never,
    { create: createRun } as never,
    {} as never,
  );
  const executePending = (
    service as unknown as {
      executePending: (
        context: ToolAuthContext,
        specificationId: string,
      ) => Promise<void>;
    }
  ).executePending.bind(service);
  return { executePending, updateMany };
}

describe("TestSpecificationService Case dispatch", () => {
  it("claims a Case and creates one idempotent Run v2", async () => {
    const createRun = vi.fn().mockResolvedValue({ id: "run-1" });
    const { executePending, updateMany } = setup(createRun);

    await executePending(current, "specification-1");

    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: {
        executionAttempts: { increment: 1 },
      },
      where: { executionRunId: null, id: "case-1" },
    });
    expect(createRun).toHaveBeenCalledWith(
      current,
      expect.objectContaining({
        businessReferences: expect.arrayContaining([
          expect.objectContaining({
            externalId: "reference://spec/specification-1/issue",
            kind: "BUSINESS_REFERENCE",
          }),
          expect.objectContaining({
            externalId: "reference://spec/specification-1/pull-request/1",
            kind: "BUSINESS_REFERENCE",
          }),
        ]),
        criteria: [
          expect.objectContaining({
            requiredEvidenceKinds: ["SCREENSHOT", "BUSINESS_REFERENCE"],
          }),
        ],
        idempotencyKey: "spec-case:case-1",
        source: { id: "case-1", kind: "SPEC_CASE" },
      }),
    );
    expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
      data: { executionRunId: "run-1" },
      where: { executionRunId: null, id: "case-1" },
    });
  });

  it("persists a redacted dispatch error and timestamps the retry backoff", async () => {
    const createRun = vi
      .fn()
      .mockRejectedValue(new Error("Bearer abcdef123 token=unsafe-value"));
    const { executePending, updateMany } = setup(createRun);

    await expect(executePending(current, "specification-1")).rejects.toThrow();

    expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
      data: {
        executionLastError: {
          code: "RUN_DISPATCH_FAILED",
          message: "Bearer [REDACTED] token=[REDACTED]",
        },
        executionRequestedAt: expect.any(Date),
      },
    });
  });
});
