import { describe, expect, it } from "vitest";
import { VerificationProgress } from "./verification-progress.js";

function snapshot(content: string, index: number) {
  return {
    name: "browser_command",
    arguments: JSON.stringify({ commandType: "page.snapshot", payload: {} }),
    criteria: [],
    output: {
      id: `command-${index}`,
      durationMs: index,
      evidenceRefs: [`artifact://${index}`],
      result: { content, url: "https://example.com" },
      artifacts: [{ id: `${index}`, kind: "SCREENSHOT" }],
    },
  };
}

describe("verification progress", () => {
  it("ignores prose and artifact-id rewrites when the recorded criterion has not changed", () => {
    const progress = new VerificationProgress(() => 0);
    const criteria = [
      {
        criterionId: "ready",
        status: "INCONCLUSIVE",
        evidenceKinds: ["SCREENSHOT"],
      },
    ];
    let stopped = false;
    for (let index = 0; index < 25; index++) {
      stopped = progress.tool({
        name: "record_criterion",
        arguments: JSON.stringify({
          criterionId: "ready",
          status: "INCONCLUSIVE",
          summary: `暂未确认，观察第${index}次。`,
          evidenceRefs: [`artifact://${index}`],
        }),
        output: { accepted: true },
        criteria,
      });
      if (index < 24) expect(stopped).toBe(false);
    }
    expect(stopped).toBe(true);
    expect(
      progress.tool({
        name: "record_criterion",
        arguments: JSON.stringify({
          criterionId: "ready",
          status: "PASSED",
          summary: "页面已就绪。",
        }),
        output: { accepted: true },
        criteria: [{ ...criteria[0]!, status: "PASSED" }],
      }),
    ).toBe(false);
  });

  it("bounds changing invalid arguments without treating legitimate form arguments as identical", () => {
    const progress = new VerificationProgress(() => 0);
    for (let index = 0; index < 24; index++) {
      expect(
        progress.tool({
          name: "browser_command",
          arguments: JSON.stringify({ commandType: `invalid-${index}` }),
          output: {
            accepted: false,
            error: `Unknown command invalid-${index}`,
          },
          criteria: [],
        }),
      ).toBe(false);
    }
    expect(
      progress.tool({
        name: "browser_command",
        arguments: JSON.stringify({
          commandType: "yet-another-invalid-command",
        }),
        output: { accepted: false, error: "Unknown command" },
        criteria: [],
      }),
    ).toBe(true);
  });

  it("allows ordinary polling, then stops repeated observations despite transport and ref changes", () => {
    let now = 0;
    const progress = new VerificationProgress(() => now);
    for (let index = 0; index < 9; index++) {
      now = index * 1_000;
      expect(
        progress.tool(snapshot(`- text Loading [ref=e${index}]`, index)),
      ).toBe(false);
    }
    now = 60_000;
    expect(progress.tool(snapshot("- text Loading [ref=e99]", 99))).toBe(true);
  });

  it("bounds fast cycles across already seen pages", () => {
    const progress = new VerificationProgress(() => 0);
    let stopped = false;
    for (let index = 0; index < 30 && !stopped; index++) {
      stopped = progress.tool(snapshot(index % 2 ? "Page B" : "Page A", index));
    }
    expect(stopped).toBe(true);
  });

  it("resets when a pending page changes and when a criterion makes new progress", () => {
    let now = 0;
    const progress = new VerificationProgress(() => now);
    for (let index = 0; index < 8; index++)
      progress.tool(snapshot("Loading", index));
    now = 60_000;
    expect(progress.tool(snapshot("Ready", 8))).toBe(false);
    for (let index = 0; index < 7; index++)
      progress.tool(snapshot("Ready", index));
    now = 120_000;
    expect(
      progress.tool({
        ...snapshot("Ready", 9),
        criteria: [
          {
            criterionId: "ready",
            status: "PASSED",
            evidenceKinds: ["SCREENSHOT"],
          },
        ],
      }),
    ).toBe(false);
    expect(progress.tool(snapshot("Ready", 10))).toBe(false);
  });

  it("does not mistake distinct form actions for a repetition loop", () => {
    const progress = new VerificationProgress(() => 120_000);
    for (let index = 0; index < 30; index++) {
      expect(
        progress.tool({
          name: "browser_command",
          arguments: JSON.stringify({
            commandType: "page.fill",
            payload: {
              target: { selector: `#field-${index}` },
              value: `value-${index}`,
            },
          }),
          output: { result: { filled: true } },
          criteria: [],
        }),
      ).toBe(false);
    }
  });

  it("uses screenshot content hashes instead of fresh artifact identities", () => {
    let now = 0;
    const progress = new VerificationProgress(() => now);
    const observe = (hash: string, index: number) =>
      progress.tool({
        ...snapshot("Same page", index),
        output: {
          artifacts: [{ id: `${index}`, kind: "SCREENSHOT", sha256: hash }],
        },
      });
    for (let index = 0; index < 8; index++)
      expect(observe("hash-a", index)).toBe(false);
    now = 60_000;
    expect(observe("hash-b", 8)).toBe(false);
    for (let index = 0; index < 7; index++) observe("hash-b", index);
    now = 120_000;
    expect(observe("hash-a", 9)).toBe(true);
  });
});
