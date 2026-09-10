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
  it("credits changed automatic DOM, but not refresh identities or animations", () => {
    const progress = new VerificationProgress();
    progress.observe(snapshot('- button "Open" [ref=f1e1]', 1).output);
    expect(progress.state()).toMatchObject({ meaningful: true, sequence: 1 });
    progress.observe(snapshot('- button "Open" [ref=f2e1]', 2).output);
    expect(progress.state()).toMatchObject({ meaningful: false, sequence: 1 });
    progress.observe(snapshot('- button "Close" [ref=f3e1]', 3).output);
    expect(progress.state()).toMatchObject({ meaningful: true, sequence: 2 });
  });
  it("bounds repeated cached pages despite new capture IDs, cursor offsets and refs", () => {
    let now = 0;
    const progress = new VerificationProgress(() => now);
    let stopped = false;
    for (let n = 0; n < 12 && !stopped; n++) {
      now += 61_000;
      stopped = progress.tool({
        name: "read_observation",
        arguments: JSON.stringify({
          observationId: `new-${n}`,
          cursor: 11088 + n,
        }),
        criteria: [],
        output: {
          result: {
            content: `- option "Same option" [ref=f${n}e1]`,
            url: "https://example.com",
          },
        },
      });
      expect(progress.state().meaningful).toBe(n === 0);
    }
    expect(stopped).toBe(true);
    expect(progress.state().sequence).toBe(1);
    expect(
      progress.tool({
        name: "read_observation",
        arguments: '{"cursor":0}',
        criteria: [],
        output: { result: { content: "New option" } },
      }),
    ).toBe(false);
    expect(progress.state()).toMatchObject({
      meaningful: true,
      sequence: 2,
      repeatedSteps: 0,
    });
  });

  it("does not label a fresh screenshot hash alone as meaningful deadline progress", () => {
    const progress = new VerificationProgress();
    for (let n = 0; n < 3; n++) {
      progress.tool({
        ...snapshot("same", n),
        output: {
          artifacts: [{ kind: "SCREENSHOT", sha256: `animation-${n}` }],
        },
      });
      expect(progress.state()).toMatchObject({
        meaningful: false,
        sequence: 0,
      });
    }
  });
  it("stops three rejected saves despite fresh DOM and counts delayed feedback only once", () => {
    const progress = new VerificationProgress();
    const save = (index: number, stateKey = "same-account-type") => ({
      ...snapshot(`变化的提示 ${index}`, index),
      arguments: JSON.stringify({
        commandType: "page.click",
        payload: { ref: `f${index}e1` },
      }),
      output: {
        result: {
          interaction: { targetKey: "save", stateKey },
          actionFeedback: {
            commandId: `save-${index}`,
            requests: [{ method: "POST", status: 400 }],
          },
        },
      },
    });
    expect(progress.tool(save(1))).toBe(false);
    for (let i = 0; i < 3; i++) expect(progress.tool(save(1))).toBe(false);
    expect(progress.tool(snapshot("重新渲染的表单", 2))).toBe(false);
    expect(progress.tool(save(2))).toBe(false);
    expect(progress.tool(save(3, "corrected-account-type"))).toBe(false);
    expect(progress.tool(save(4))).toBe(true);
  });

  it("does not count infrastructure failures or read requests as rejected writes", () => {
    const progress = new VerificationProgress();
    for (let i = 0; i < 5; i++)
      expect(
        progress.tool({
          ...snapshot(`观察 ${i}`, i),
          output: {
            result: {
              content: `新页面 ${i}`,
              interaction: { targetKey: "save", stateKey: "form" },
              actionFeedback: {
                commandId: `action-${i}`,
                requests: [
                  { method: "POST", status: 503 },
                  { method: "GET", status: 400 },
                ],
              },
            },
          },
        }),
      ).toBe(false);
  });
  it("bounds the same target with unchanged fields despite coordinate jitter and interleaved animated screenshots", () => {
    let now = 0;
    const progress = new VerificationProgress(() => now);
    let stopped = false;
    for (let index = 0; index < 12 && !stopped; index++) {
      now = index * 10_000;
      progress.tool({
        ...snapshot("表单", index),
        output: {
          artifacts: [{ kind: "SCREENSHOT", sha256: `animation-${index}` }],
        },
      });
      stopped = progress.tool({
        name: "browser_command",
        criteria: [],
        arguments: JSON.stringify({
          commandType: "page.click",
          payload: { point: { x: 800 + index, y: 600 } },
        }),
        output: {
          result: {
            interaction: {
              targetKey: "save",
              stateKey: "same-fields",
              hasFormInputs: true,
            },
          },
          artifacts: [{ kind: "SCREENSHOT", sha256: `cursor-${index}` }],
        },
      });
      if (index < 8) expect(stopped).toBe(false);
    }
    expect(stopped).toBe(true);
  });

  it("allows corrected inputs and repeated actions with observed business progress", () => {
    const progress = new VerificationProgress(() => 120_000);
    for (let index = 0; index < 35; index++) {
      expect(progress.tool(snapshot(`已创建 ${index} 条记录`, index))).toBe(
        false,
      );
      expect(
        progress.tool({
          name: "browser_command",
          criteria: [],
          arguments: JSON.stringify({ commandType: "page.click" }),
          output: {
            result: {
              interaction: {
                targetKey: "save",
                stateKey: index % 2 ? "corrected" : "original",
                hasFormInputs: true,
              },
            },
          },
        }),
      ).toBe(false);
    }
  });
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
