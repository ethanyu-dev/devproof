import { describe, expect, it, vi } from "vitest";
import {
  verificationRequestSchema,
  verificationResultSchema,
} from "@devproof/contracts";

import {
  canonicalJson,
  decodeUtf8ArtifactPage,
  matchesVerificationRequestIdentity,
  validateRecordedAssertions,
  validateVerificationEvidenceRefs,
  VerificationService,
  verificationRequestHash,
} from "./verification.service.js";

const screenshotId = "11111111-1111-4111-8111-111111111111";
const screenshotRef = `artifact://${screenshotId}`;

function evidenceRequest(requiredKinds: string[] = ["SCREENSHOT"]) {
  return verificationRequestSchema.parse({
    acceptanceCriteria: [{ description: "Page loads", id: "page" }],
    evidencePolicy: { requiredKinds, retentionDays: 90 },
    execution: { requiredCapabilities: ["browser"] },
    goal: "Verify release",
    idempotencyKey: "release-evidence",
  });
}

function evidenceResult(evidenceRefs: string[], verdict = "PASSED") {
  return verificationResultSchema.parse({
    criteria: [
      {
        criterionId: "page",
        evidenceRefs,
        status: verdict,
        summary: "The page was evaluated.",
      },
    ],
    evidenceRefs,
    summary: "The verification completed.",
    verdict,
  });
}

describe("verification request identity", () => {
  it("hashes equivalent request objects identically", () => {
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Page loads", id: "page" }],
      execution: { requiredCapabilities: ["browser"] },
      goal: "Verify release",
      idempotencyKey: "release-1",
    });
    const reordered = {
      ...request,
      inputs: { nested: { b: 2, a: 1 } },
    };
    const reorderedAgain = {
      ...request,
      inputs: { nested: { a: 1, b: 2 } },
    };

    expect(verificationRequestHash(reordered)).toBe(
      verificationRequestHash(reorderedAgain),
    );
  });

  it("keeps array order in the canonical representation", () => {
    expect(canonicalJson({ criteria: ["a", "b"] })).not.toBe(
      canonicalJson({ criteria: ["b", "a"] }),
    );
  });

  it("accepts a pre-upgrade snapshot after removed fields and new defaults", () => {
    const current = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Page loads", id: "page" }],
      execution: { requiredCapabilities: ["browser"] },
      goal: "Verify release",
      idempotencyKey: "legacy-release",
    });
    const legacySnapshot = structuredClone(current) as Record<string, unknown>;
    delete legacySnapshot.mode;
    const legacyExecution = legacySnapshot.execution as Record<string, unknown>;
    legacyExecution.allowedOrigins = ["https://login.example.com"];
    delete legacyExecution.runTimeoutSeconds;

    expect(
      matchesVerificationRequestIdentity(
        "pre-upgrade-hash",
        legacySnapshot,
        verificationRequestHash(current),
      ),
    ).toBe(true);
  });
});

describe("artifact UTF-8 paging", () => {
  it("backs up to a complete code point and resumes losslessly", () => {
    const source = Buffer.from("ab你cd", "utf8");
    const first = decodeUtf8ArtifactPage(source.subarray(0, 4), true);
    const second = decodeUtf8ArtifactPage(
      source.subarray(first.body.byteLength),
      false,
    );
    expect(first.text + second.text).toBe("ab你cd");
    expect(first.text + second.text).not.toContain("�");
  });

  it("rejects a caller-supplied cursor inside a code point", () => {
    const source = Buffer.from("你", "utf8");
    expect(() => decodeUtf8ArtifactPage(source.subarray(1), false)).toThrow(
      /valid UTF-8/u,
    );
  });
});

describe("TEST verification assertions", () => {
  const request = verificationRequestSchema.parse({
    acceptanceCriteria: [{ description: "Page loads", id: "page" }],
    execution: { requiredCapabilities: ["browser"] },
    goal: "Verify release",
    idempotencyKey: "release-test-assertion",
    mode: "TEST",
  });
  const result = evidenceResult([]);

  it("rejects PASS until every required assertion is recorded", () => {
    expect(() => validateRecordedAssertions(request, result, [])).toThrow(
      /missing required assertion page/u,
    );
  });

  it("requires the final result to agree with recorded state", () => {
    expect(() =>
      validateRecordedAssertions(request, result, [
        {
          criterionId: "page",
          evidenceRefs: [],
          status: "FAILED",
        },
      ]),
    ).toThrow(/disagrees with recorded assertion/u);
  });

  it("accepts a matching required assertion", () => {
    expect(() =>
      validateRecordedAssertions(request, result, [
        {
          criterionId: "page",
          evidenceRefs: [],
          status: "PASSED",
        },
      ]),
    ).not.toThrow();
  });
});

describe("verification completion terminal states", () => {
  it.each(["CANCELLED", "TIMED_OUT"] as const)(
    "rejects completion immediately when a run is already %s",
    async (status) => {
      const runId = "11111111-1111-4111-8111-111111111111";
      const teamId = "22222222-2222-4222-8222-222222222222";
      const transaction = {
        $queryRaw: vi.fn().mockResolvedValue([{ id: runId }]),
        verificationRun: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            id: runId,
            result: null,
            status,
          }),
        },
      };
      const prisma = {
        $transaction: vi.fn(
          async (operation: (tx: typeof transaction) => unknown) =>
            operation(transaction),
        ),
      };
      const lifecycle = { transitionInTransaction: vi.fn() };
      const service = new VerificationService(
        prisma as never,
        lifecycle as never,
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        service.complete(
          {
            credential: {
              id: "33333333-3333-4333-8333-333333333333",
            },
            team: { id: teamId },
          } as never,
          runId,
          evidenceResult([], "FAILED"),
        ),
      ).rejects.toThrow(`already terminal with status ${status}`);
      expect(lifecycle.transitionInTransaction).not.toHaveBeenCalled();
    },
  );

  it("treats cancellation of an already terminal run as idempotent cleanup", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const teamId = "22222222-2222-4222-8222-222222222222";
    const prisma = {
      verificationRun: {
        findFirst: vi.fn().mockResolvedValue({ id: runId, status: "FAILED" }),
      },
    };
    const lifecycle = { transition: vi.fn() };
    const service = new VerificationService(
      prisma as never,
      lifecycle as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const detail = vi
      .spyOn(service, "detail")
      .mockResolvedValue({ id: runId, status: "FAILED" } as never);

    await expect(
      service.cancel(
        {
          credential: { id: "33333333-3333-4333-8333-333333333333" },
          team: { id: teamId },
        } as never,
        runId,
      ),
    ).resolves.toMatchObject({ status: "FAILED" });
    expect(detail).toHaveBeenCalledWith(expect.anything(), runId);
    expect(lifecycle.transition).not.toHaveBeenCalled();
  });
});

describe("verification evidence references", () => {
  it("accepts required evidence referenced from the current run", () => {
    expect(() =>
      validateVerificationEvidenceRefs(
        evidenceRequest(),
        evidenceResult([screenshotRef]),
        [{ id: screenshotId, kind: "SCREENSHOT" }],
      ),
    ).not.toThrow();
  });

  it("rejects a PASSED result that leaves required evidence unreferenced", () => {
    expect(() =>
      validateVerificationEvidenceRefs(evidenceRequest(), evidenceResult([]), [
        { id: screenshotId, kind: "SCREENSHOT" },
      ]),
    ).toThrow(/missing referenced evidence kinds: SCREENSHOT/u);
  });

  it("rejects evidence that is unavailable to the current run", () => {
    expect(() =>
      validateVerificationEvidenceRefs(
        evidenceRequest(),
        evidenceResult([screenshotRef]),
        [],
      ),
    ).toThrow(/evidence unavailable to this verification/u);
  });

  it("allows evidence-free HITL results when no artifact kind is required", () => {
    expect(() =>
      validateVerificationEvidenceRefs(
        evidenceRequest([]),
        evidenceResult([]),
        [],
      ),
    ).not.toThrow();
  });

  it("allows FAILED results to complete without unavailable required evidence", () => {
    expect(() =>
      validateVerificationEvidenceRefs(
        evidenceRequest(),
        evidenceResult([], "FAILED"),
        [],
      ),
    ).not.toThrow();
  });
});
