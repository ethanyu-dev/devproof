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
it("rejects code templates and distinct weekdays masquerading as alternatives", () => {
  const text =
    "周一 周二 周三 周四 周五 第 {{a}} 个与第 {{b}} 个时段存在重叠。";
  const c = expandSpecCheck(
    specCheckSchema.parse({
      requirementId: "r",
      description: "工作日选中周一至周五。",
      observationTargets: [
        {
          label: "选中的星期按钮",
          expectedText: "周一",
          alternatives: ["周二", "周三", "周四", "周五"],
        },
        {
          label: "重叠提示",
          expectedText: "第 {{a}} 个与第 {{b}} 个时段存在重叠。",
        },
      ],
    }),
    { ...requirement, quote: text },
    "c",
  );
  expect(
    specCriterionIssues(c, new Map([[sourceRef, text]])).map(
      (issue) => issue.code,
    ),
  ).toEqual(
    expect.arrayContaining([
      "STRUCTURED_STATE_REQUIRED",
      "ALTERNATIVES_ARE_DISTINCT_SUBJECTS",
      "UNRESOLVED_TEMPLATE",
    ]),
  );
});
it("does not confuse an action's switch with a list text assertion", () => {
  const c = expandSpecCheck(
    specCheckSchema.parse({
      requirementId: "r",
      description: "关闭开关后，列表配置显示禁用。",
      businessCheck: {
        identityMatchMode: "DISPLAY_TEXT",
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
it("allows source-backed alternate names for the same weekday", () => {
  const text = "页面包含周日，也称星期天。";
  const c = expandSpecCheck(
    specCheckSchema.parse({
      requirementId: "r",
      description: "页面包含星期名称。",
      observationTargets: [
        { label: "星期名称", expectedText: "周日", alternatives: ["星期天"] },
      ],
    }),
    { ...requirement, quote: text },
    "c",
  );
  expect(specCriterionIssues(c, new Map([[sourceRef, text]]))).toEqual([]);
});
it("rejects a network assertion disguised as a DOM business state", () => {
  const c = expandSpecCheck(
    specCheckSchema.parse({
      requirementId: "r",
      description: "请求体 config 为指定值。",
      requiredEvidenceKinds: ["DOM"],
      businessCheck: {
        identityMatchMode: "DISPLAY_TEXT",
        subjects: ["合规模型映射"],
        state: { label: "config", equals: '{"value":false}' },
      },
    }),
    requirement,
    "c",
  );
  expect(specCriterionIssues(c, sources)).toContainEqual(
    expect.objectContaining({ code: "NETWORK_REFERENCE_ONLY" }),
  );
});
