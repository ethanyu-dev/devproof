import { describe, expect, it } from "vitest";
import {
  specCapabilityError,
  localizationRequirementError,
} from "./spec-capabilities.js";
import { observedValueMatches } from "./observed-value.js";

describe("source-bound browser test scope", () => {
  const criterion = {
    id: "check-1",
    requirementId: "r1",
    description: "英文环境下的显示名称",
    requiredEvidenceKinds: ["DOM"],
  };
  const testCase = {
    name: "英文名称",
    preconditions: [],
    steps: [],
    criteria: [criterion],
  };
  it("rejects expansion from route docs and i18n diffs", () => {
    expect(
      specCapabilityError(
        { cases: [testCase] },
        new Map([["issue", "新增两种配置，样式参考 ZDR"]]),
      ),
    ).toContain("无明确需求依据");
  });
  it("accepts explicit localization requirements with issue provenance", () => {
    const requirement = {
      id: "r1",
      description: "英文环境下显示名称",
      testScope: "LOCALIZATION",
      issueEvidence: {
        sourceRef: "issue",
        quote: "英文环境下显示名称必须正确",
      },
    };
    expect(
      specCapabilityError(
        { requirements: [requirement], cases: [testCase] },
        new Map([["issue", requirement.issueEvidence.quote]]),
      ),
    ).toBeNull();
    expect(
      specCapabilityError(
        { requirements: [requirement], cases: [testCase] },
        new Map([["diff", requirement.issueEvidence.quote]]),
      ),
    ).toBeTruthy();
  });
  it.each(["pr", "brief"])(
    "accepts explicit intent evidence from %s without an Issue",
    (sourceRef) => {
      const quote = "英文环境下显示名称必须正确";
      const requirement = {
        id: "r1",
        description: quote,
        testScope: "LOCALIZATION",
        intentEvidence: { sourceRef, quote },
      };
      expect(
        specCapabilityError(
          { requirements: [requirement], cases: [testCase] },
          new Map([[sourceRef, quote]]),
        ),
      ).toBeNull();
      expect(
        specCapabilityError(
          { requirements: [requirement], cases: [testCase] },
          new Map([["unrelated", quote]]),
        ),
      ).toBeTruthy();
    },
  );
  it("does not confuse English functional UI or enum identifiers with localization", () => {
    const functional = {
      ...testCase,
      name: "Save 按钮创建 MODEL_NAME_MAPPING_WHITELIST",
      criteria: [{ ...criterion, description: "点击 Save 后列表出现新记录" }],
    };
    expect(specCapabilityError({ cases: [functional] }, new Map())).toBeNull();
  });
  it("rejects explicitly excluded language work and missing issue context", () => {
    const r = {
      id: "r1",
      description: "多语言测试",
      testScope: "LOCALIZATION",
      issueEvidence: { sourceRef: "issue", quote: "不需要多语言测试" },
    };
    expect(
      localizationRequirementError(
        r,
        new Map([["issue", r.issueEvidence.quote]]),
      ),
    ).toBeTruthy();
    expect(localizationRequirementError(r, new Map())).toBeTruthy();
  });
  it("rejects DOM-only request payload assertions", () => {
    const c = {
      ...testCase,
      name: "创建",
      criteria: [{ ...criterion, description: "请求体包含正确的 config" }],
    };
    expect(specCapabilityError({ cases: [c] }, new Map())).toContain("NETWORK");
    c.criteria[0]!.requiredEvidenceKinds = ["NETWORK"];
    expect(specCapabilityError({ cases: [c] }, new Map())).toBeNull();
  });
});

describe("observed JSON values", () => {
  it("compares whitespace and key ordering while preserving booleans and string contents", () => {
    expect(
      observedValueMatches(
        '{"config":"{\\"value\\": true}"}',
        '{"value":true}',
      ),
    ).toBe(true);
    expect(observedValueMatches('{"b":2,"a":1}', '{"a":1,"b":2}')).toBe(true);
    expect(observedValueMatches('{"value":false}', '{"value":true}')).toBe(
      false,
    );
    expect(observedValueMatches('{"value":"true"}', '{"value":true}')).toBe(
      false,
    );
    expect(observedValueMatches('{"value":"a b"}', '{"value":"ab"}')).toBe(
      false,
    );
  });
});
