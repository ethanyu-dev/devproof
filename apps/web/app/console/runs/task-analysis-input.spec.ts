import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskAnalysisInputCard } from "./task-analysis-input";

describe("task analysis input", () => {
  it.each([
    { name: "no suggestions", deploymentCandidates: [] },
    {
      name: "a suggested environment",
      deploymentCandidates: ["https://preview.example.com"],
    },
  ])(
    "renders missing deployment input with $name",
    ({ deploymentCandidates }) => {
      const html = renderToStaticMarkup(
        createElement(TaskAnalysisInputCard, {
          request: {
            attemptId: "attempt-1",
            missing: ["DEPLOYMENT_TARGET"],
            message: "请补充测试环境。",
            issueRef: "PFRD-3551",
            pullRequestUrls: [],
            deploymentCandidates,
          },
          busy: false,
          onSubmit: async () => undefined,
        }),
      );

      expect(html).toContain('aria-label="测试环境地址"');
      expect(html).toContain("提交并继续分析");
      const controlId = html.match(/<textarea[^>]+id="([^"]+)"/)?.[1];
      expect(controlId).toBeTruthy();
      expect(html).toContain(`for="${controlId}"`);
      expect(html).toContain(`aria-describedby="${controlId}-description"`);
      for (const candidate of deploymentCandidates) {
        expect(html).toContain(candidate);
      }
      expect(html.includes("发现的候选地址")).toBe(
        deploymentCandidates.length > 0,
      );
    },
  );
});
