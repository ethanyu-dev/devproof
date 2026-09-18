import { describe, expect, it } from "vitest";
import { splitStepContext } from "./step-context.js";

describe("step context sections", () => {
  it("projects all seven sections from the actual request without shortening content", () => {
    const dom = "- 目标选项".repeat(10000);
    const request = {
      tools: [{ name: "browser_command" }],
      messages: [
        { role: "system", content: "fixed instructions" },
        { role: "user", content: JSON.stringify({ goal: "verify" }) },
        {
          role: "user",
          content: JSON.stringify({
            kind: "browser_working_state",
            data: {
              executionState: { phase: "VERIFYING" },
              savedCriterionObservations: ["saved"],
              currentGoal: { step: "inspect list" },
              acceptedCriteria: [],
            },
          }),
        },
        {
          role: "user",
          content: JSON.stringify({
            kind: "recent_operations",
            turns: [1, 2, 3, 4],
          }),
        },
        {
          role: "user",
          content: JSON.stringify({
            kind: "current_browser_page",
            data: { content: dom },
          }),
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,abcd" },
            },
          ],
        },
      ],
    };
    const sections = splitStepContext(request);
    expect(Object.keys(sections)).toHaveLength(7);
    expect(sections.fixedTask).toEqual(request.messages.slice(0, 2));
    expect(sections.currentGoal).toEqual({ step: "inspect list" });
    expect(JSON.stringify(sections.currentPage)).toContain(dom);
    expect(sections.tools).toEqual(request.tools);
  });
  it("does not invent missing goals or tool definitions for historical previews", () => {
    const partial = '{"kind":"current_browser_page","data":"[truncated]';
    const sections = splitStepContext({
      messages: [{ role: "user", content: partial }],
    });
    expect(sections.currentGoal).toBeNull();
    expect(sections.tools).toBeNull();
    expect(JSON.stringify(sections.fixedTask)).toContain("[truncated]");
  });
});
