import { describe, expect, it, vi } from "vitest";
import { sessionExecutionPermit } from "./session-permit.js";

const now = new Date("2026-09-04T08:00:00Z");
const expiresAt = new Date(now.getTime() + 60_000);

function fixture() {
  const session = {
    id: "session-1",
    fencingToken: 10n,
    leaseToken: "session-token",
    ownerTaskId: "task-1" as string | null,
    ownerFencingToken: 3n as bigint | null,
    status: "ACTIVE",
    closedAt: null,
    quarantinedAt: null,
    leaseExpiresAt: expiresAt,
    executionPermitExpiresAt: expiresAt,
    humanControlExpiresAt: expiresAt,
  };
  const task = {
    id: "task-1",
    status: "WAITING_HUMAN",
    fencingToken: 3n,
    leaseExpiresAt: expiresAt,
    run: { lifecycle: "WAITING_HUMAN", deadlineAt: expiresAt },
    snapshot: {
      executionPolicy: { resume: { interventionId: "intervention-1" } },
    },
  };
  const tx = {
    agentRuntimeTask: { findUnique: vi.fn().mockResolvedValue(task) },
    humanIntervention: { findFirst: vi.fn().mockResolvedValue({ expiresAt }) },
  };
  return { session, task, tx };
}

describe("human/agent permit epoch continuity", () => {
  it.each(["console-takeover", "waiting-human", "resume-handoff"])(
    "carries the previous Agent epoch during %s so stale ACKs cannot reverse a newer claim",
    async (phase) => {
      const { session, task, tx } = fixture();
      if (phase === "console-takeover") session.status = "HUMAN_CONTROL";
      if (phase === "resume-handoff") {
        task.status = "PENDING";
        task.run.lifecycle = "QUEUED";
      }
      await expect(
        sessionExecutionPermit(tx as never, session as never, now),
      ).resolves.toEqual({
        sessionId: "session-1",
        fencingToken: "10",
        leaseToken: "session-token",
        controlGeneration: 0,
        ownerKind: "HUMAN",
        ownerTaskId: "task-1",
        ownerFencingToken: "3",
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  it("resumes Agent authority only when the task and session agree on the newly claimed epoch", async () => {
    const { session, task, tx } = fixture();
    task.status = "RUNNING";
    task.run.lifecycle = "RUNNING";
    task.fencingToken = 4n;
    await expect(
      sessionExecutionPermit(tx as never, session as never, now),
    ).resolves.toBeNull();
    session.ownerFencingToken = 4n;
    await expect(
      sessionExecutionPermit(tx as never, session as never, now),
    ).resolves.toMatchObject({
      ownerKind: "AGENT",
      ownerTaskId: "task-1",
      ownerFencingToken: "4",
    });
  });

  it("permits standalone human sessions without inventing an Agent epoch", async () => {
    const { session, tx } = fixture();
    session.status = "HUMAN_CONTROL";
    session.ownerTaskId = null;
    session.ownerFencingToken = null;
    const permit = await sessionExecutionPermit(
      tx as never,
      session as never,
      now,
    );
    expect(permit?.ownerKind).toBe("HUMAN");
    expect(permit).not.toHaveProperty("ownerTaskId");
    expect(permit).not.toHaveProperty("ownerFencingToken");
  });
});
