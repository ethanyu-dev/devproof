import { describe, expect, it } from "vitest";
import { displayCriteria } from "./run-criteria";

describe("criterion presentation", () => {
  it("folds legacy provenance and redundant enums without changing the snapshot", () => {
    const snapshot = [
      {
        id: "case-1-criterion-1",
        description:
          "白名单配置页提供 LEGACY_CORPORATE 对应的旧版对公转账白名单类型，且可在类型选择流程中被定位。\n验收对象：LEGACY_CORPORATE 业务类型\n来源原文：LEGACY_CORPORATE 旧版对公转账白名单\nSpec 来源：reference://task/one",
        observationTargets: [
          {
            expectedText: "旧版对公转账白名单",
            alternatives: ["LEGACY_CORPORATE"],
          },
        ],
      },
    ];
    const before = structuredClone(snapshot);
    const [view] = displayCriteria({
      criteriaSnapshot: snapshot,
      criterionResults: [
        {
          criterionId: snapshot[0]!.id,
          status: "PASSED",
          summary: "已找到该选项。",
        },
      ],
    });
    expect(view?.description).toBe(
      "白名单配置页提供旧版对公转账白名单类型，且可在类型选择流程中被定位。",
    );
    expect(view?.basis.join("\n")).toContain("reference://task/one");
    expect(view?.basis.join("\n")).toContain("LEGACY_CORPORATE");
    expect(view?.summary).toBe("已找到该选项。");
    expect(snapshot).toEqual(before);
  });
  it("shows structured basis separately and preserves meaningful API assertions", () => {
    const [view] = displayCriteria({
      criteriaSnapshot: [
        {
          id: "api",
          description: "保存后 POST 请求中的 type 必须为 LEGACY_CORPORATE。",
          basis: {
            observationTarget: "请求字段",
            quote: "原始要求",
            sourceRefs: ["reference://one"],
          },
        },
      ],
      criterionResults: [],
    });
    expect(view?.description).toContain("type 必须为 LEGACY_CORPORATE");
    expect(view?.basis).toEqual([
      "验收对象：请求字段",
      "来源原文：原始要求",
      "Spec 来源：reference://one",
    ]);
  });
});
