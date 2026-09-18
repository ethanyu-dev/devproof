import { expect, it, vi } from "vitest";
import {
  currentAccountEvidenceFilter,
  ObservationBindingService,
} from "./observation-binding.service.js";
it("applies the new account epoch to runtime binding reads without modifying history", async () => {
  const snapshot = {
    executionPolicy: { accountRevisionStartedAt: "2026-09-18T02:00:00.000Z" },
  };
  const db = {
    runObservationBinding: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const service = new ObservationBindingService(db as never, {} as never);
  await service.all({ runId: "run", attemptId: "attempt", snapshot });
  expect(db.runObservationBinding.findMany).toHaveBeenCalledWith({
    where: {
      runId: "run",
      attemptId: "attempt",
      createdAt: { gte: new Date("2026-09-18T02:00:00.000Z") },
    },
    orderBy: { createdAt: "asc" },
  });
  expect(currentAccountEvidenceFilter({ executionPolicy: {} })).toEqual({});
});
