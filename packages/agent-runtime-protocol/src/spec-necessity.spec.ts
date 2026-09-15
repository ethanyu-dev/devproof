import { describe, expect, it } from "vitest";
import {
  runtimeGeneratedSpecSchema,
  runtimeSpecRequirementSchema,
} from "./index.js";
import {
  requirementNecessityError,
  specNecessityError,
} from "./spec-necessity.js";

const issue = "analysis-source://issue";
const doc = "analysis-source://route";
const diff = "analysis-source://diff";
const issueText = "新增导出功能，管理员可以导出报表，普通用户不能导出。";
const docText = "报表支持分页、排序、导出，导出文件使用筛选后的数据。";
const patch =
  "--- a/export.ts\n+++ b/export.ts\n@@ -1,2 +1,2 @@\n const pageSize = 20;\n-exportRows(rows);\n+exportRows(filteredRows);";
const context = {
  sources: new Map([
    [issue, { kind: "LINEAR_ISSUE" }],
    [doc, { kind: "GITHUB_FILE" }],
    [diff, { kind: "GITHUB_DIFF" }],
  ]),
  sourceContents: new Map([
    [issue, issueText],
    [doc, docText],
    [diff, patch],
  ]),
};
const secondary = runtimeSpecRequirementSchema.parse({
  id: "r1",
  description: "导出文件只包含筛选结果",
  sourceRef: doc,
  quote: "导出文件使用筛选后的数据",
});
const diffBasis = {
  sourceRef: diff,
  quote: "+exportRows(filteredRows);",
  reason: "本次调整导出数据来源，需要确认导出范围与当前筛选一致。",
};

function spec() {
  return runtimeGeneratedSpecSchema.parse({
    scopePolicy: "CHANGE_FOCUSED",
    summary: "验证导出",
    scope: { inScope: [secondary.description] },
    requirements: [secondary],
    cases: [
      {
        name: "导出筛选结果",
        rationale: "验证导出内容",
        preconditions: ["具有测试数据"],
        sourceRefs: [doc],
        steps: [
          {
            order: 1,
            action: "导出当前结果",
            expectedObservation: "文件包含筛选数据",
          },
        ],
        criteria: [
          {
            id: "c1",
            requirementId: secondary.id,
            description: secondary.description,
            sourceRefs: [doc],
            requiredEvidenceKinds: ["DOM"],
            basis: {
              sourceRef: doc,
              quote: secondary.quote,
              observationTarget: "导出结果",
            },
          },
        ],
      },
    ],
  });
}

describe("change-focused Spec scope", () => {
  it("keeps explicit requirements, including permissions, without extra justification", () => {
    expect(
      requirementNecessityError(
        {
          ...secondary,
          sourceRef: issue,
          quote: "普通用户不能导出",
          description: "普通用户不能导出报表",
        },
        context,
      ),
    ).toBeNull();
  });

  it("requires change relevance before importing page capabilities", () => {
    expect(requirementNecessityError(secondary, context)).toContain(
      "缺少 changeBasis",
    );
    expect(
      requirementNecessityError(
        {
          ...secondary,
          changeBasis: {
            sourceRef: doc,
            quote: secondary.quote,
            reason: "页面文档有定义。",
          },
        },
        context,
      ),
    ).toContain("不能独自扩展范围");
  });

  it("accepts implementation expectations grounded in the Issue or changed lines", () => {
    for (const changeBasis of [
      diffBasis,
      {
        sourceRef: issue,
        quote: "新增导出功能",
        reason: "新增导出能力需要验证导出的内容，页面契约用于明确其数据范围。",
      },
    ]) {
      const requirement = { ...secondary, changeBasis };
      expect(requirementNecessityError(requirement, context)).toBeNull();
      const generated = spec();
      generated.requirements = [requirement];
      expect(specNecessityError(generated, context)).toBeNull();
      expect(
        runtimeGeneratedSpecSchema.parse(generated).requirements![0]!
          .changeBasis,
      ).toEqual(changeBasis);
    }
  });

  it.each([
    [" const pageSize = 20;", "必须包含 diff"],
    ["+++ b/export.ts", "必须包含 diff"],
    ["exportRows(filteredRows);", "必须包含 diff"],
    ["+exportRows(allRows);", "未出现在对应来源"],
  ])(
    "rejects unrelated context, headers and invented diff citations: %s",
    (quote, error) => {
      expect(
        requirementNecessityError(
          { ...secondary, changeBasis: { ...diffBasis, quote } },
          context,
        ),
      ).toContain(error);
    },
  );

  it("does not let a valid change citation validate a fabricated product basis", () => {
    expect(
      requirementNecessityError(
        {
          ...secondary,
          quote: "导出后删除所有原数据",
          changeBasis: diffBasis,
        },
        context,
      ),
    ).toContain("未出现在实际来源");
  });

  it("preserves historical snapshots while guarding both new generation formats", () => {
    const generated = spec();
    expect(specNecessityError(generated, context)).toContain("changeBasis");
    delete generated.scopePolicy;
    expect(
      specNecessityError(runtimeGeneratedSpecSchema.parse(generated), context),
    ).toBeNull();
    generated.scopePolicy = "CHANGE_FOCUSED";
    delete generated.requirements;
    delete generated.cases[0]!.criteria[0]!.requirementId;
    expect(specNecessityError(generated, context)).toContain(
      "requirements 及 changeBasis",
    );
  });
});
