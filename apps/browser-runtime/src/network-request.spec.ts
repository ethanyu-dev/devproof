import { describe, it, expect } from "vitest";
import { observedRequestBody } from "./network-request.js";
import { stepVideoPlan } from "./step-video-plan.js";
import { ActionFeedbackTracker } from "./action-feedback.js";
describe("network request evidence", () => {
  it("keeps business JSON and omits authentication, non-JSON and oversized data", () => {
    const capture = (url: string, body: string, type = "application/json") =>
      observedRequestBody(url, type, body, (v) => v);
    expect(capture("https://app.test/config", '{"value":true}')).toEqual({
      value: true,
    });
    expect(
      capture("https://app.test/oauth/token", '{"secret":"x"}'),
    ).toBeUndefined();
    expect(capture("https://app.test/login", '{"secret":"x"}')).toBeUndefined();
    expect(capture("https://app.test/config", "invalid")).toBeUndefined();
    expect(
      capture("https://app.test/config", '"' + "a".repeat(17000) + '"'),
    ).toBeUndefined();
    expect(
      capture(
        "https://app.test/config",
        "secret=abc",
        "application/x-www-form-urlencoded",
      ),
    ).toBeUndefined();
  });
  it("passes captured values through redaction and includes them in action feedback", () => {
    const body = observedRequestBody(
      "https://app.test/config",
      "application/json",
      '{"value":true,"token":"private"}',
      () => ({ value: true, token: "[REDACTED]" }),
    );
    const tracker = new ActionFeedbackTracker();
    const req = {};
    tracker.begin("cmd", "page.click", "page");
    tracker.request(req, "page", {
      method: "POST",
      url: "https://app.test/config",
    });
    tracker.response(req, { status: 200, requestBody: body });
    expect(tracker.snapshot("page")?.requests[0]?.requestSummary).toBe(
      '{"value":true,"token":"[REDACTED]"}',
    );
  });
});
describe("bounded overview video", () => {
  it("fits both encoding attempts within budget even for long runs, preserving endpoints", () => {
    const frames = Array.from({ length: 400 }, (_, i) => i);
    const plan = stepVideoPlan(frames);
    expect(plan.durationMs).toBeLessThanOrEqual(6000);
    expect(plan.frames.length).toBe(60);
    expect(plan.frames[0]).toBe(0);
    expect(plan.frames.at(-1)).toBe(399);
    expect(plan.sourceFrameCount).toBe(400);
    expect(stepVideoPlan([1, 2, 3]).frames).toEqual([1, 2, 3]);
  });
});
