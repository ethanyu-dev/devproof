import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import { describe, expect, it } from "vitest";
import { BrowserObservations } from "./browser-observation.js";
import { jsonBytes } from "./model-context.js";

const command = (commandType: string, payload: Record<string, unknown> = {}) =>
  runtimeActionCommandInputSchema.parse({ commandType, payload });
const click = (ref: string) => command("page.click", { target: { ref } });

function capture(
  cache: BrowserObservations,
  content: string,
  options: { snapshot?: boolean; truncated?: boolean; url?: string } = {},
) {
  const raw = {
    status: "SUCCEEDED",
    result: {
      content,
      truncated: options.truncated ?? false,
      url: options.url ?? "https://example.com",
    },
    commandId: "transport-command",
    leaseToken: "private-lease",
    payload: { echoed: true },
  };
  cache.capture(
    command(options.snapshot === false ? "page.get_text" : "page.snapshot"),
    raw,
  );
  return {
    raw,
    page: (cache.project(raw) as { result: Record<string, unknown> }).result,
  };
}

describe("browser observations", () => {
  it("keeps action screenshots transient even after later observations and cache reads", () => {
    const cache = new BrowserObservations();
    const immediate = {
      status: "SUCCEEDED",
      result: { ok: true },
      artifacts: [{ id: "loading", kind: "SCREENSHOT" }],
    };
    cache.capture(
      command("page.click", { target: { selector: "#search" } }),
      immediate,
    );
    expect(cache.project(immediate)).toMatchObject({
      observationStage: "AFTER_ACTION",
    });
    expect(cache.project(immediate, false)).toMatchObject({
      observationStage: "AFTER_ACTION",
    });
    expect(cache.verdictEvidenceError(["artifact://loading"])).toContain(
      "过程截图",
    );
    const updated = {
      status: "SUCCEEDED",
      result: { content: "旧版类型对应记录" },
      artifacts: [{ id: "settled", kind: "SCREENSHOT" }],
    };
    cache.capture(command("page.snapshot"), updated);
    expect(cache.verdictEvidenceError(["artifact://settled"])).toBeUndefined();
    expect(
      cache.verdictEvidenceError(["artifact://loading", "artifact://settled"]),
    ).toContain("过程截图");
    const projected = cache.project(immediate) as {
      result: { observationId: string };
    };
    cache.read(projected.result.observationId);
    expect(cache.verdictEvidenceError(["artifact://loading"])).toContain(
      "过程截图",
    );
  });

  it("keeps image bytes out of tool text and invalidates images after mutations, failures, and full-page captures", () => {
    const cache = new BrowserObservations();
    const visual = {
      artifactId: "3a6cbe48-f36c-4b48-bae1-d8d5e50f4ce0",
      observationId: "6730b25a-d1d3-4a10-a0c1-69fd4d74643a",
      capturedAt: new Date().toISOString(),
      viewport: { width: 1280, height: 720 },
      contentType: "image/jpeg",
      dataBase64: Buffer.from("private image bytes").toString("base64"),
    };
    const raw = {
      status: "SUCCEEDED",
      visualObservation: visual,
      result: { content: "- <input> [ref=f1e1]" },
    };
    cache.capture(command("page.snapshot"), raw);
    expect(cache.currentVisual()).toEqual(visual);
    expect(JSON.stringify(cache.project(raw))).not.toContain(visual.dataBase64);
    expect(JSON.stringify(cache.project(raw, false))).not.toContain(
      visual.dataBase64,
    );
    cache.capture(
      command("page.fill", { target: { ref: "f1e1" }, text: "value" }),
      { status: "SUCCEEDED", result: { filled: true } },
    );
    expect(cache.currentVisual()).toBeUndefined();
    cache.capture(command("page.snapshot"), raw);
    cache.capture(command("page.screenshot", { fullPage: true }), {
      status: "SUCCEEDED",
    });
    expect(cache.currentVisual()).toBeUndefined();
    cache.capture(command("page.snapshot"), raw);
    cache.capture(click("f1e1"), { status: "FAILED" });
    expect(cache.currentVisual()).toBeUndefined();
  });

  it("pages exact captured text on complete ref lines and exposes later refs only after reading", () => {
    const cache = new BrowserObservations();
    const content = Array.from(
      { length: 900 },
      (_, index) => `- button "条目😀 ${index}" [ref=f2e${index + 1}]\n`,
    ).join("");
    const { raw, page: first } = capture(cache, content);
    const original = structuredClone(raw);
    expect(cache.staleRef(click("f2e900"))).toBe(true);
    expect(cache.read(String(first.observationId), 1)).toMatchObject({
      accepted: false,
    });
    let page = first;
    let joined = "";
    while (true) {
      expect(jsonBytes(page.content)).toBeLessThanOrEqual(12 * 1_024);
      expect(jsonBytes({ result: page })).toBeLessThanOrEqual(16 * 1_024);
      expect(String(page.content)).toMatch(/\n$/u);
      expect(String(page.content)).not.toContain("�");
      joined += page.content;
      if (page.nextCursor === null) {
        expect(page).not.toHaveProperty("nextAction");
        break;
      }
      expect(page.nextAction).toEqual({
        tool: "read_observation",
        arguments: {
          observationId: first.observationId,
          cursor: page.nextCursor,
        },
      });
      page = cache.read(String(first.observationId), Number(page.nextCursor));
    }
    expect(joined).toBe(content);
    expect(cache.staleRef(click("f2e900"))).toBe(false);
    expect(cache.read(String(first.observationId))).toEqual(first);
    expect(raw).toEqual(original);
    expect(cache.project(raw)).not.toHaveProperty("leaseToken");
    expect(cache.project(raw)).not.toHaveProperty("payload");
  });

  it.each([
    command("page.navigate", { url: "https://next.example.com" }),
    command("page.click", { target: { selector: "#next" } }),
    command("page.fill", { target: { selector: "#name" }, text: "Ada" }),
    command("tab.new", { url: "https://next.example.com" }),
    command("page.get_url"),
  ])(
    "makes earlier refs historical after mutation or an observed URL change (%#)",
    (action) => {
      const cache = new BrowserObservations();
      const { page } = capture(cache, '- button "Continue" [ref=e42]\n');
      expect(cache.staleRef(click("e42"))).toBe(false);
      cache.capture(action, {
        status: "SUCCEEDED",
        result: { url: "https://next.example.com" },
      });
      expect(cache.read(String(page.observationId))).toMatchObject({
        refState: "HISTORICAL",
      });
      expect(cache.staleRef(click("e42"))).toBe(true);
      capture(cache, '- button "New" [ref=e43]\n');
      expect(cache.staleRef(click("e43"))).toBe(false);
      expect(cache.staleRef(click("e42"))).toBe(true);
    },
  );

  it("invalidates old refs when a frame snapshot replaces the current snapshot", () => {
    const cache = new BrowserObservations();
    const { page } = capture(cache, '- button "Parent" [ref=e1]\n');
    const raw = {
      status: "SUCCEEDED",
      result: { content: '- button "Child" [ref=f3e7]\n' },
    };
    cache.capture(
      command("frame.snapshot", { frame: { selector: "iframe" } }),
      raw,
    );
    cache.project(raw);
    cache.read(String(page.observationId));
    expect(cache.staleRef(click("e1"))).toBe(true);
    expect(cache.staleRef(click("f3e7"))).toBe(false);
  });

  it.each([
    command("frame.fill", {
      frame: { selector: "iframe" },
      target: { ref: "e1" },
      text: "Ada",
    }),
    command("page.fill", { target: { ref: "e1" }, text: "Ada" }),
    command("page.type", { target: { ref: "e1" }, text: "Ada" }),
    command("page.check", { target: { ref: "e1" } }),
    command("page.uncheck", { target: { ref: "e1" } }),
    command("page.select", { target: { ref: "e1" }, values: ["2"] }),
  ])(
    "keeps observed refs usable after successful form input (%#)",
    (action) => {
      const cache = new BrowserObservations();
      const { page } = capture(
        cache,
        '- textbox "Name" [ref=e1]\n- button "Submit" [ref=e2]\n',
      );
      cache.capture(action, { status: "SUCCEEDED", result: { ok: true } });
      expect(cache.staleRef(click("e2"))).toBe(false);
      expect(cache.staleRef(click("e3"))).toBe(true);
      expect(cache.read(String(page.observationId))).toMatchObject({
        refState: "CURRENT",
      });

      cache.capture(action, { status: "FAILED", error: { code: "TIMEOUT" } });
      expect(cache.staleRef(click("e2"))).toBe(true);
      expect(cache.read(String(page.observationId))).toMatchObject({
        refState: "HISTORICAL",
      });
    },
  );

  it("routes local continuation offsets to the cached observation rather than browser paging", () => {
    const cache = new BrowserObservations();
    const content = '- text "Catalog detail"\n'.repeat(800);
    const raw = {
      status: "SUCCEEDED",
      result: {
        content,
        cursor: 90_000,
        nextCursor: 90_000 + content.length,
        truncated: true,
      },
    };
    const original = structuredClone(raw);
    cache.capture(command("page.snapshot", { cursor: 90_000 }), raw);
    const { result } = cache.project(raw) as {
      result: {
        content: string;
        sourceTruncated: boolean;
        nextAction: {
          tool: string;
          arguments: { observationId: string; cursor: number };
        };
      };
    };
    expect(result.sourceTruncated).toBe(true);
    expect(result.nextAction.tool).toBe("read_observation");
    expect(result.nextAction.arguments.cursor).toBe(result.content.length);
    expect(result.nextAction.arguments.cursor).toBeLessThan(raw.result.cursor);
    const next = cache.read(
      result.nextAction.arguments.observationId,
      result.nextAction.arguments.cursor,
    );
    expect(result.content + next.content).toBe(content);
    expect(next).not.toHaveProperty("nextAction");
    expect(raw).toEqual(original);
  });

  it("labels shortened index metadata without mistaking it for a URL change", () => {
    const cache = new BrowserObservations();
    const url = `https://example.com/search?q=${"x".repeat(400)}`;
    const { page } = capture(cache, '- button "Next" [ref=e42]\n', { url });
    expect(page).toMatchObject({ metadataTruncated: true });
    expect(String(page.url)).toHaveLength(240);
    cache.capture(command("page.get_url"), {
      status: "SUCCEEDED",
      result: { url },
    });
    expect(cache.staleRef(click("e42"))).toBe(false);
  });

  it("skips an oversized snapshot line explicitly without exposing a partial ref", () => {
    const cache = new BrowserObservations();
    const { page } = capture(
      cache,
      `- button "${"x".repeat(20_000)}" [ref=e1]\n- button "Next" [ref=e2]\n`,
    );
    expect(page).toMatchObject({ omittedLine: true });
    expect(String(page.content)).not.toContain("ref=");
    expect(cache.staleRef(click("e1"))).toBe(true);
    expect(
      cache.read(String(page.observationId), Number(page.nextCursor)),
    ).toMatchObject({
      content: '- button "Next" [ref=e2]\n',
      nextCursor: null,
    });
    expect(cache.staleRef(click("e2"))).toBe(false);
  });

  it("does not keep earlier refs current when a new snapshot fails without content", () => {
    const cache = new BrowserObservations();
    const { page } = capture(cache, '- button "Next" [ref=e42]\n');
    cache.capture(command("page.snapshot"), {
      status: "FAILED",
      error: { code: "SNAPSHOT_FAILED" },
    });
    expect(cache.read(String(page.observationId))).toMatchObject({
      refState: "HISTORICAL",
    });
    expect(cache.staleRef(click("e42"))).toBe(true);
  });

  it("handles JSON escaping and Unicode without losing text across pages", () => {
    const cache = new BrowserObservations();
    const content = '\n"\\😀汉字'.repeat(7_000);
    let { page } = capture(cache, content, { snapshot: false });
    let joined = "";
    while (true) {
      expect(jsonBytes(page.content)).toBeLessThanOrEqual(12 * 1_024);
      expect(String(page.content)).not.toMatch(/[\uD800-\uDBFF]$/u);
      joined += page.content;
      if (page.nextCursor === null) break;
      page = cache.read(String(page.observationId), Number(page.nextCursor));
    }
    expect(joined).toBe(content);
  });

  it("marks uncaptured and upstream-truncated content explicitly", () => {
    const cache = new BrowserObservations(80);
    const { page } = capture(
      cache,
      '- button "First" [ref=e1]\n' + "😀".repeat(100) + "[ref=e2]\n",
      { truncated: true },
    );
    expect(page).toMatchObject({
      captureTruncated: true,
      sourceTruncated: true,
      nextCursor: null,
      content: '- button "First" [ref=e1]\n',
    });
    expect(cache.staleRef(click("e2"))).toBe(true);
  });

  it("expires evicted and foreign-segment content instead of recapturing it", () => {
    const cache = new BrowserObservations(100);
    const { page } = capture(cache, "x".repeat(80), { snapshot: false });
    capture(cache, "y".repeat(80), { snapshot: false });
    expect(cache.index()[0]).toMatchObject({
      observationId: page.observationId,
      availability: "EVICTED",
    });
    expect(cache.read(String(page.observationId))).toMatchObject({
      accepted: false,
    });
    expect(
      new BrowserObservations().read(String(page.observationId)),
    ).toMatchObject({ accepted: false });
    for (let index = 0; index < 270; index += 1)
      capture(cache, "z", { snapshot: false });
    expect(cache.index()).toHaveLength(256);
    expect(cache.read(String(page.observationId))).toMatchObject({
      accepted: false,
    });
  });

  it("preserves evidence IDs and kinds without exposing artifact transport metadata", () => {
    const cache = new BrowserObservations();
    const raw = {
      status: "SUCCEEDED",
      artifacts: [
        {
          id: "proof",
          kind: "SCREENSHOT",
          storageKey: "private/key",
          metadata: { hidden: true },
          dataBase64: "image",
        },
      ],
      evidenceRefs: ["artifact://proof"],
    };
    expect(cache.project(raw)).toEqual({
      status: "SUCCEEDED",
      artifacts: [{ id: "proof", kind: "SCREENSHOT" }],
      evidenceRefs: ["artifact://proof"],
    });
  });

  it("bounds a large recovery envelope while keeping its token and diagnostics addressable", () => {
    const cache = new BrowserObservations();
    const snapshot = {
      status: "SUCCEEDED",
      result: { content: '- button "Target" [ref=e42]\n' },
    };
    cache.capture(command("page.snapshot"), snapshot);
    const raw = {
      status: "FAILED",
      error: { code: "LOCATOR_AMBIGUOUS", message: "诊断".repeat(9_000) },
      locatorRecovery: {
        action: "RESNAPSHOT_AND_RETARGET",
        recoveryToken: "call-42",
        exhausted: false,
        retargetAttempts: 0,
        maxRetargetAttempts: 2,
        snapshot,
      },
    };
    const original = structuredClone(raw);
    const projected = cache.project(raw) as {
      result: { observationId: string };
    };
    expect(jsonBytes(projected)).toBeLessThanOrEqual(16 * 1_024);
    expect(projected).toMatchObject({
      status: "FAILED",
      locatorRecovery: { recoveryToken: "call-42", exhausted: false },
      result: { contentOmitted: true },
    });
    expect(cache.staleRef(click("e42"))).toBe(true);
    let page = cache.read(projected.result.observationId);
    let joined = "";
    while (true) {
      joined += page.content;
      if (page.nextCursor === null) break;
      page = cache.read(
        projected.result.observationId,
        Number(page.nextCursor),
      );
    }
    expect(JSON.parse(joined)).toMatchObject({
      error: raw.error,
      locatorRecovery: {
        snapshot: { result: { content: snapshot.result.content } },
      },
    });
    const snapshotId =
      JSON.parse(joined).locatorRecovery.snapshot.result.observationId;
    cache.read(snapshotId);
    expect(cache.staleRef(click("e42"))).toBe(false);
    expect(raw).toEqual(original);
  });
});
