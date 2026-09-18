import { expect, it } from "vitest";
import { specCheckSchema, expandSpecCheck } from "./spec-draft.js";
import { specCriterionIssues } from "./spec-criterion-validation.js";
const quote =
  '关闭开关后，两种白名单在列表显示禁用。合规模型映射、旧版对公转账白名单。请求体 config 为 {"value":false}。';
const sourceRef = "analysis-source://issue";
const requirement = {
  id: "r",
  description: quote,
  sourceRef,
  quote,
  testScope: "FUNCTIONAL" as const,
};
const sources = new Map([[sourceRef, quote]]);
it("does not confuse an action's switch with a list text assertion", () => {
  const c = expandSpecCheck(
    specCheckSchema.parse({
      requirementId: "r",
      description: "关闭开关后，列表配置显示禁用。",
      businessCheck: {
        subjects: ["合规模型映射", "旧版对公转账白名单"],
        state: { label: "配置值", property: "TEXT", equals: "禁用" },
        when: "AFTER_ACTION",
      },
    }),
    requirement,
    "c",
  );
  expect(specCriterionIssues(c, sources)).toEqual([]);
  expect(c.observationContract?.targets).toHaveLength(2);
});
it("rejects a network requirement compiled as a DOM business state even if NETWORK is also listed", () => {
  const c = expandSpecCheck(
    specCheckSchema.parse({
      requirementId: "r",
      description: "请求体 config 为指定值。",
      requiredEvidenceKinds: ["DOM", "NETWORK"],
      businessCheck: {
        subjects: ["合规模型映射"],
        state: { label: "config", equals: '{"value":false}' },
      },
    }),
    requirement,
    "c",
  );
  expect(specCriterionIssues(c, sources)).toContainEqual(
    expect.objectContaining({ code: "EVIDENCE_CHANNEL_MISMATCH" }),
  );
});
