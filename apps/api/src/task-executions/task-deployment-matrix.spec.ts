import { describe, expect, it } from "vitest";

import { taskDeploymentMatrix } from "./task-deployment-matrix.js";

describe("task deployment execution matrix", () => {
  it("fans four Specs out across two Deployments", () => {
    const rows = taskDeploymentMatrix(
      "issue-1",
      ["spec-1", "spec-2", "spec-3", "spec-4"].map((id) => ({ id })),
      ["deployment-a", "deployment-b"].map((id) => ({ id })),
    );

    expect(rows).toHaveLength(8);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: "spec-1",
          deploymentId: "deployment-a",
        }),
        expect.objectContaining({
          caseId: "spec-1",
          deploymentId: "deployment-b",
        }),
        expect.objectContaining({
          caseId: "spec-4",
          deploymentId: "deployment-a",
        }),
        expect.objectContaining({
          caseId: "spec-4",
          deploymentId: "deployment-b",
        }),
      ]),
    );
    expect(rows.every((row) => row.executionOrdinal === 1)).toBe(true);
  });
});
