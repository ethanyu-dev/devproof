import { expect, it, vi } from "vitest";
import { coordinateResumedAccounts } from "./account-coordination.js";
import { executionResourceClaims } from "./execution-concurrency.js";
const input = {
  sessionId: "current-session",
  targetUrl: "https://app.test",
  concurrencyPolicy: {},
  executionPolicy: {
    testAccounts: [
      {
        slotId: "subject:1",
        account: "replacement",
        aliases: [],
        usage: "CREATE_OR_MODIFY",
        requiredTypes: ["MAPPING"],
      },
    ],
  },
};
it("waits for a conflicting replacement account before the agent receives a lease", async () => {
  const claims = executionResourceClaims(
    input.targetUrl,
    input.concurrencyPolicy,
    input.executionPolicy,
  );
  const tx = {
    executionResourceLease: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ ...claims.at(-1), sessionId: "other-session" }]),
      upsert: vi.fn(),
    },
  };
  expect(await coordinateResumedAccounts(tx as never, input)).toEqual({
    sessionId: "other-session",
  });
  expect(tx.executionResourceLease.upsert).not.toHaveBeenCalled();
});
it("reserves the new identity without releasing the old session's cleanup locks", async () => {
  const tx = {
    executionResourceLease: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  expect(await coordinateResumedAccounts(tx as never, input)).toBeNull();
  expect(tx.executionResourceLease.upsert).toHaveBeenCalled();
  expect(tx.executionResourceLease.deleteMany).not.toHaveBeenCalled();
});
