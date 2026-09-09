import { describe, expect, it } from "vitest";
import { ActionFeedbackTracker } from "./action-feedback.js";

describe("action request feedback", () => {
  it("excludes requests started before the action and on other pages, including late responses", () => {
    const tracker = new ActionFeedbackTracker();
    const oldRequest = {};
    tracker.request(oldRequest, "page", { url: "/old" });
    tracker.begin("click", "page.click", "page");
    tracker.response(oldRequest, { status: 400 });
    tracker.request({}, "other-page", { url: "/other" });
    expect(tracker.snapshot("page")).toMatchObject({
      inputCompleted: false,
      coverageIncomplete: true,
      requests: [],
    });
    expect(tracker.snapshot("other-page")).toBeUndefined();
  });

  it("updates pending responses on observation and exposes business errors even with HTTP 200", () => {
    const tracker = new ActionFeedbackTracker();
    const request = {};
    tracker.begin("click", "page.click", "page");
    tracker.request(request, "page", { method: "POST", url: "/save" });
    tracker.completed("click");
    expect(tracker.snapshot("page")).toMatchObject({
      inputCompleted: true,
      pending: true,
      coverageIncomplete: true,
    });
    const response: Record<string, unknown> = {
      status: 200,
      bodyPending: true,
    };
    tracker.response(request, response);
    expect(tracker.snapshot("page")?.pending).toBe(true);
    response.bodyPending = false;
    response.responseBody = { code: "USER_NOT_FOUND" };
    expect(tracker.snapshot("page")).toMatchObject({
      association: "temporal",
      pending: false,
      requests: [{ status: 200, responseSummary: '{"code":"USER_NOT_FOUND"}' }],
    });
  });

  it("marks omitted bodies and retention gaps, and bounds multibyte feedback including JSON escaping", () => {
    const tracker = new ActionFeedbackTracker();
    tracker.begin("click", "page.click", "page");
    for (let index = 0; index < 210; index++) {
      const request = {};
      tracker.request(request, "page", {
        url: `/${index}/${'汉字"'.repeat(900)}`,
      });
      tracker.response(request, {
        status: 400,
        responseBody: { error: "汉字".repeat(3000) },
      });
    }
    const feedback = tracker.snapshot("page")!;
    expect(Buffer.byteLength(JSON.stringify(feedback))).toBeLessThanOrEqual(
      12 * 1024,
    );
    expect(feedback.coverageIncomplete).toBe(true);
    expect(feedback.requests.at(-1)?.requestId).toBe(210);
    tracker.begin("new", "page.click", "page");
    const omitted = {};
    tracker.request(omitted, "page", { url: "/cross-origin" });
    tracker.response(omitted, {
      status: 200,
      responseBodyOmitted: "origin_or_content_type",
    });
    expect(tracker.snapshot("page")?.coverageIncomplete).toBe(true);
  });
});
