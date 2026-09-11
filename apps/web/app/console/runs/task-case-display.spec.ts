import { describe, expect, it } from "vitest";
import { caseDescription, latestTaskCaseExecutions } from "./task-case-display";
import type { TaskCase, TaskCaseExecution } from "./task-types";

const definition: TaskCase["definition"] = {
  authRole: "member",
  name: "编辑下架时间",
  preconditions: [],
  steps: [{ order: 1, action: "打开模型编辑页面" }],
  expected: ["保存后显示更新的下架时间"],
};

describe("case descriptions", () => {
  it("shows acceptance requirements without including internal source references", () => {
    expect(
      caseDescription({
        ...definition,
        criteria: [
          {
            id: "c1",
            description: "支持清空下架时间",
            required: true,
            requiredEvidenceKinds: [],
            sourceRefs: ["analysis-source://internal-reference"],
          },
        ],
      }),
    ).toBe("支持清空下架时间");
  });

  it("uses legacy expectations when criteria are absent or empty", () => {
    expect(caseDescription(definition)).toBe("保存后显示更新的下架时间");
    expect(caseDescription({ ...definition, criteria: [] })).toBe(
      "保存后显示更新的下架时间",
    );
  });

  it("falls back to actions and then an explicit empty description", () => {
    expect(caseDescription({ ...definition, expected: [] })).toBe(
      "打开模型编辑页面",
    );
    expect(caseDescription({ ...definition, expected: [], steps: [] })).toBe(
      "暂无用例描述。",
    );
  });
});

function execution(
  id: string,
  deploymentId: string,
  ordinal: number,
): TaskCaseExecution {
  return {
    id,
    deployment: {
      id: deploymentId,
      key: deploymentId,
      name: deploymentId,
      targetUrl: "https://example.com",
    },
    executionOrdinal: ordinal,
    dispatch: {
      attempts: 0,
      lastError: null,
      requestedAt: null,
      status: "PENDING",
    },
    run: null,
  };
}

describe("case execution selection", () => {
  it("selects the latest execution per environment regardless of response order, retaining history", () => {
    const records = [
      execution("preview-old", "preview", 1),
      execution("staging-new", "staging", 3),
      execution("preview-new", "preview", 2),
      execution("staging-old", "staging", 2),
    ];
    expect(latestTaskCaseExecutions(records).map((item) => item.id)).toEqual([
      "preview-new",
      "staging-new",
    ]);
    expect(records.map((item) => item.id)).toEqual([
      "preview-old",
      "staging-new",
      "preview-new",
      "staging-old",
    ]);
    expect(latestTaskCaseExecutions([])).toEqual([]);
  });
});
