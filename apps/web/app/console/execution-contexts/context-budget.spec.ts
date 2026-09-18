import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ContextBudget } from "./context-budget";

it("does not invent budgets for legacy archives", () => {
  expect(
    renderToStaticMarkup(
      createElement(ContextBudget, { metrics: { requestBytes: 10000 } }),
    ),
  ).toBe("");
});

it("explains retained history, pruning, images and unconfigured model windows", () => {
  const html = renderToStaticMarkup(
    createElement(ContextBudget, {
      metrics: {
        maxTextBytes: 524288,
        textRequestBytes: 100000,
        detailedTurns: 2,
        summaryTurns: 10,
        imageCount: 2,
        resultsWithOmissions: 1,
        truncations: [{ reason: "OLDER_SUMMARY_BUDGET", count: 2 }],
        omitted: { savedObservations: 3, objectBindings: 1 },
        windowBudget: { unconfiguredModels: ["vision"] },
      },
    }),
  );
  expect(html).toContain("2 轮详细事实、10 轮摘要");
  expect(html).toContain("省略较早操作摘要");
  expect(html).toContain("未配置模型窗口：vision");
  expect(html).toContain("附带 2 张图片");
});
