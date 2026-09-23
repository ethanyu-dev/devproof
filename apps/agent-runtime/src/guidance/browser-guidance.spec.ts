import { describe, expect, it } from "vitest";
import {
  browserGuidanceSections,
  browserSystemPrompt,
  includedGuidanceSections,
} from "./index.js";
import type { BrowserGuidanceContext } from "./types.js";

const full: BrowserGuidanceContext = {
  bounded: true,
  groupedTools: true,
  hasBusinessChecks: true,
  hasObservationContractV2: true,
};

const ids = (ctx: BrowserGuidanceContext) =>
  includedGuidanceSections(ctx).map((section) => section.id);

describe("guidance catalog", () => {
  it("has unique, well-formed section ids", () => {
    const seen = new Set<string>();
    for (const section of browserGuidanceSections) {
      expect(section.id).toMatch(/^[a-z0-9-]+$/);
      expect(seen.has(section.id)).toBe(false);
      seen.add(section.id);
    }
  });

  it("every section has a human-readable description and non-empty content", () => {
    for (const section of browserGuidanceSections) {
      expect(section.description.trim().length).toBeGreaterThan(0);
      expect(section.content.trim().length).toBeGreaterThan(0);
    }
  });

  it("content is safe to embed in a template literal", () => {
    for (const section of browserGuidanceSections) {
      expect(section.content).not.toContain("`");
      expect(section.content).not.toContain("${");
    }
  });

  it("content lines carry no stray whitespace", () => {
    for (const section of browserGuidanceSections) {
      for (const line of section.content.split("\n")) {
        expect(line.trimEnd()).toBe(line);
        expect(line.trimStart()).toBe(line);
      }
    }
  });

  it("reports included section ids for observability", () => {
    expect(ids(full)).toEqual(browserGuidanceSections.map((s) => s.id));
  });
});

describe("browserSystemPrompt assembly", () => {
  it("includes every section when all conditions hold", () => {
    const prompt = browserSystemPrompt(full);
    for (const section of browserGuidanceSections) {
      expect(prompt).toContain(section.content);
    }
  });

  it("joins sections in catalog order without trailing newline", () => {
    const prompt = browserSystemPrompt(full);
    expect(prompt).toBe(
      browserGuidanceSections.map((s) => s.content).join("\n"),
    );
    expect(prompt.endsWith("\n")).toBe(false);
    let last = -1;
    for (const section of browserGuidanceSections) {
      const at = prompt.indexOf(section.content);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it("omits the working-state block in legacy mode", () => {
    const legacyIds = ids({ ...full, bounded: false });
    expect(legacyIds).not.toContain("working-state-records");
    expect(legacyIds).not.toContain("working-state-ref-validity");
    expect(browserSystemPrompt({ ...full, bounded: false })).not.toContain(
      "browser_working_state 是执行记录数据",
    );
  });

  it("omits the grouped tool-surface guidance when tools are flat", () => {
    const flat = ids({ ...full, groupedTools: false });
    expect(flat).not.toContain("tool-surface-grouped");
    expect(browserSystemPrompt({ ...full, groupedTools: false })).not.toContain(
      "enable_browser_tools",
    );
  });

  it("omits business-check v3 guidance for tasks without v3 criteria", () => {
    const noV3 = ids({ ...full, hasBusinessChecks: false });
    expect(noV3).not.toContain("business-checks-v3");
    expect(
      browserSystemPrompt({ ...full, hasBusinessChecks: false }),
    ).not.toContain("observe_subject");
  });

  it("omits legacy observationContract v2 guidance for tasks without v2 criteria", () => {
    const noV2 = ids({ ...full, hasObservationContractV2: false });
    expect(noV2).not.toContain("legacy-contract-v2");
    expect(
      browserSystemPrompt({ ...full, hasObservationContractV2: false }),
    ).not.toContain("对于旧版 observationContract.version=2");
  });

  it("keeps core invariants in every mode", () => {
    for (const ctx of [
      full,
      {
        bounded: false,
        groupedTools: true,
        hasBusinessChecks: false,
        hasObservationContractV2: false,
      },
      {
        bounded: true,
        groupedTools: false,
        hasBusinessChecks: false,
        hasObservationContractV2: false,
      },
    ]) {
      const prompt = browserSystemPrompt(ctx);
      expect(prompt).toContain("你是 DevProof 内部的浏览器验证执行 Agent");
      expect(prompt).toContain("stepIntent");
      expect(prompt).toContain("简体中文");
      expect(prompt).toContain("绝不能调用会话生命周期操作");
      expect(prompt).toContain("也绝不能泄露凭据");
    }
  });

  it("keeps the blank line before the action-feedback paragraph", () => {
    const prompt = browserSystemPrompt(full);
    expect(prompt).toContain(
      "不授权重新提交业务写入。\n\nresult.actionFeedback 是浏览器采集的操作反馈",
    );
  });
});
