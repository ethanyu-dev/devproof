import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserObservations } from "./browser-observation.js";
import { ModelContext, jsonBytes } from "./model-context.js";

afterEach(() => vi.useRealTimers());

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
  const modalContent =
    '- <span> "Navigation background" [ref=f9e1] [box=0,0,80,20]\n'.repeat(
      260,
    ) + '- <button> "OK" [ref=f9e206] [box=864,464,52,32]\n';

  it("delivers a complete captured DOM without exposing refs from discarded candidates", () => {
    const cache = new BrowserObservations(undefined, true);
    const { page } = capture(cache, modalContent, { truncated: true });
    const full = cache.currentPage(true);
    expect(full.snapshot).toMatchObject({
      content: modalContent,
      cursor: 0,
      nextCursor: null,
      nextUnreadCursor: null,
      sourceTruncated: true,
    });
    expect(full.snapshot).not.toHaveProperty("nextAction");
    expect(cache.staleRef(click("f9e206"))).toBe(true);
    expect(cache.hasDeliveredQuote(String(page.observationId), 0, '"OK"')).toBe(
      false,
    );

    const forged = structuredClone(full);
    forged.snapshot!.content += '\n- <button> "Invented" [ref=e999]\n';
    cache.deliverCurrentPage(forged);
    expect(cache.staleRef(click("f9e206"))).toBe(true);
    expect(cache.staleRef(click("e999"))).toBe(true);

    cache.deliverCurrentPage(full);
    expect(cache.staleRef(click("f9e206"))).toBe(false);
    expect(cache.hasDeliveredQuote(String(page.observationId), 0, '"OK"')).toBe(
      true,
    );
    expect(cache.index()[0]?.nextUnreadCursor).toBeNull();
  });

  it("keeps an unselected complete candidate unread when only a page fits the request", () => {
    const cache = new BrowserObservations(undefined, true);
    const { page } = capture(cache, modalContent);
    const full = cache.currentPage(true);
    const fallback = cache.currentPage();
    const context = new ModelContext([], { maxBytes: 15_000 });
    const view = context.build({}, {}, undefined, full, fallback);
    expect(view.metrics.usedPageFallback).toBe(true);
    expect(view.metrics.textRequestBytes).toBeLessThanOrEqual(15_000);
    cache.deliverCurrentPage(view.currentPage!);
    expect(cache.staleRef(click("f9e206"))).toBe(true);
    expect(cache.hasDeliveredQuote(String(page.observationId), 0, '"OK"')).toBe(
      false,
    );
    const correction = cache.unreadRefCorrection(click("f9e206"))!;
    expect(correction).toMatchObject({
      code: "OBSERVATION_NOT_READ",
      nextAction: { arguments: { cursor: page.nextCursor } },
    });
  });

  it("can retarget a previously delivered tail after the context falls back to pagination", () => {
    const cache = new BrowserObservations(undefined, true);
    const { page } = capture(cache, modalContent);
    cache.deliverCurrentPage(cache.currentPage(true));
    cache.deliverCurrentPage(cache.currentPage());
    expect(cache.staleRef(click("f9e206"))).toBe(true);
    const correction = cache.unreadRefCorrection(click("f9e206"))!;
    expect(correction).toMatchObject({
      code: "OBSERVATION_NOT_READ",
      nextAction: { arguments: { cursor: page.nextCursor } },
    });
    cache.read(String(page.observationId), Number(page.nextCursor));
    cache.deliverCurrentPage(cache.currentPage());
    expect(cache.staleRef(click("f9e206"))).toBe(false);
    expect(cache.hasDeliveredQuote(String(page.observationId), 0, '"OK"')).toBe(
      true,
    );
    expect(cache.index()[0]?.nextUnreadCursor).toBeNull();
  });

  it("preserves complete reads across equivalent refreshes without exposing the new refs early", () => {
    const cache = new BrowserObservations(undefined, true);
    const { page } = capture(cache, modalContent);
    cache.deliverCurrentPage(cache.currentPage(true));
    capture(cache, modalContent.replaceAll("f9", "f10"));
    const refreshed = cache.currentPage(true);
    expect(refreshed.snapshot).toMatchObject({
      readProgressInheritedFrom: page.observationId,
      nextUnreadCursor: null,
    });
    expect(cache.staleRef(click("f10e206"))).toBe(true);
    cache.deliverCurrentPage(refreshed);
    expect(cache.staleRef(click("f9e206"))).toBe(true);
    expect(cache.staleRef(click("f10e206"))).toBe(false);
  });

  it("delivers the scroll focus without claiming intervening pages were read", () => {
    const cache = new BrowserObservations(undefined, true);
    const content = Array.from(
      { length: 200 },
      (_, i) => `- <div> "选项${i} ${"内容".repeat(30)}" [ref=f2e${i + 1}]\n`,
    ).join("");
    cache.capture(command("page.snapshot"), {
      status: "SUCCEEDED",
      result: { content, focusRef: "f2e180" },
    });
    const view = cache.currentPage();
    expect(view.snapshot?.content).toContain("[ref=f2e180]");
    expect(view.snapshot?.cursor).toBeGreaterThan(0);
    cache.deliverCurrentPage(view);
    expect(cache.staleRef(click("f2e180"))).toBe(false);
    expect(cache.unreadRef(click("f2e1"))).toBe(true);
    expect(cache.currentPage().snapshot?.nextUnreadCursor).toBe(0);
  });

  it("bounds the request index while preserving pinned observations and historical reads", () => {
    const cache = new BrowserObservations();
    const first = capture(cache, "历史选项").page;
    for (let i = 0; i < 180; i++)
      capture(cache, `内容${i} [ref=f${i + 1}e1]`, {
        url: `https://example.com/${"route".repeat(40)}`,
      });
    const current = cache.currentPage().snapshot!;
    cache.read(String(first.observationId));
    const bounded = cache.index(8192);
    expect(jsonBytes(bounded)).toBeLessThanOrEqual(8192);
    expect(bounded.map((item) => item.observationId)).toEqual(
      expect.arrayContaining([first.observationId, current.observationId]),
    );
    expect(bounded.length).toBeLessThan(cache.index().length);
    const context = new ModelContext([
      { role: "system", content: "指令".repeat(1500) },
    ]);
    const base = { tools: [{ description: "schema".repeat(4000) }] };
    expect(() =>
      context.build(
        base,
        { observations: cache.index() },
        undefined,
        cache.currentPage(),
      ),
    ).toThrow(/预算/);
    expect(
      context.build(
        base,
        { observations: bounded },
        undefined,
        cache.currentPage(),
      ).metrics.textRequestBytes,
    ).toBeLessThan(96 * 1024);
    expect(cache.read(String(first.observationId)).content).toBe("历史选项");
  });

  it("blocks two ineffective scrolls across fresh refs, preserving reverse and search recovery", () => {
    const cache = new BrowserObservations();
    const snapshot = (scope: number) =>
      capture(
        cache,
        `- <div scrollY=0/288 atEnd=false> "" [ref=f${scope}e1] [box=0,0,200,256]\n- <div> "首项" [ref=f${scope}e2]`,
      );
    const scroll = (scope: number, deltaY = 192) =>
      command("page.scroll", { target: { ref: `f${scope}e1` }, deltaY });
    snapshot(1);
    for (let i = 1; i <= 2; i++) {
      expect(cache.scrollCorrection(scroll(i))).toBeUndefined();
      cache.capture(scroll(i), {
        status: "SUCCEEDED",
        result: {
          scrolled: false,
          scrollFeedback: { version: 1, status: "NO_MOVEMENT" },
        },
      });
      snapshot(i + 1);
    }
    expect(cache.scrollCorrection(scroll(3, 300))).toMatchObject({
      code: "SCROLL_NO_PROGRESS",
    });
    expect(cache.scrollCorrection(scroll(3, -192))).toBeUndefined();
    cache.capture(
      command("page.fill", { target: { selector: "input" }, text: "旧版" }),
      { status: "SUCCEEDED" },
    );
    snapshot(4);
    expect(cache.scrollCorrection(scroll(4))).toBeUndefined();
  });

  it("does not treat legacy success as measured movement or block after it", () => {
    const cache = new BrowserObservations();
    const scroll = command("page.scroll", {
      target: { selector: "#holder" },
      deltaY: 192,
    });
    for (let i = 0; i < 3; i++) {
      capture(cache, "选项");
      cache.capture(scroll, {
        status: "SUCCEEDED",
        result: { scrolled: true },
      });
    }
    capture(cache, "选项");
    expect(cache.scrollCorrection(scroll)).toBeUndefined();
  });

  it("blocks a measured boundary only while the page and direction remain unchanged", () => {
    const cache = new BrowserObservations();
    const snapshot = (scope: number, row = "末项") =>
      capture(
        cache,
        `- <div scrollY=288/288 atEnd=true> "" [ref=f${scope}e1]\n- <div> "${row}" [ref=f${scope}e2]`,
      );
    const scroll = (scope: number, deltaY = 192) =>
      command("page.scroll", { target: { ref: `f${scope}e1` }, deltaY });
    snapshot(1);
    cache.capture(scroll(1), {
      status: "SUCCEEDED",
      result: { scrollFeedback: { version: 1, status: "AT_BOUNDARY" } },
    });
    snapshot(2);
    expect(cache.scrollCorrection(scroll(2))).toMatchObject({
      code: "SCROLL_NO_PROGRESS",
    });
    expect(cache.scrollCorrection(scroll(2, -192))).toBeUndefined();
    snapshot(3, "异步更新的选项");
    expect(cache.scrollCorrection(scroll(3))).toBeUndefined();
  });
  it.each([false, true])(
    "delivers a requested current tail after a slow model and refresh (page changed=%s)",
    (changed) => {
      vi.useFakeTimers();
      const cache = new BrowserObservations(undefined, true);
      const context = new ModelContext([]);
      const content =
        "DOM viewport scope f9\n" +
        '- text "background"\n'.repeat(700) +
        '- button "新增用户白名单" [ref=f9e206]\n';
      const { page } = capture(cache, content);
      cache.deliverCurrentPage(cache.currentPage());
      vi.setSystemTime(Date.now() + 165_000);
      const args = {
        observationId: String(page.observationId),
        cursor: Number(page.nextCursor),
      };
      const result = cache.read(args.observationId, args.cursor);
      expect(result.content).toContain("新增用户白名单");
      context.completeTurn(
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              id: "read",
              function: {
                name: "read_observation",
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        [
          {
            role: "tool",
            tool_call_id: "read",
            content: JSON.stringify({ result }),
          },
        ],
      );
      expect(cache.needsSnapshot()).toBe(true);
      const requested = cache.requestedPage();
      capture(
        cache,
        changed
          ? '- button "Different page" [ref=f10e1]\n'
          : content.replaceAll("f9", "f10"),
      );
      cache.retainLatestObservation(requested);
      const current = cache.currentPage();
      const view = context.build(
        {},
        { observations: cache.index() },
        undefined,
        current,
      );
      expect(JSON.stringify(view.messages)).toContain("新增用户白名单");
      expect(current.latestObservation).toMatchObject({
        refState: "HISTORICAL",
        content: result.content,
      });
      cache.deliverCurrentPage(current);
      expect(cache.staleRef(click("f9e206"))).toBe(true);
      if (!changed) {
        expect(current.snapshot?.content).toContain("[ref=f10e206]");
        expect(current.snapshot?.readProgressInheritedFrom).toBe(
          page.observationId,
        );
        expect(cache.staleRef(click("f10e206"))).toBe(false);
      } else {
        expect(current.snapshot?.cursor).toBe(0);
        expect(current.snapshot?.readProgressInheritedFrom).toBeUndefined();
      }
    },
  );

  it("keeps read coverage across ref width changes without exposing unread refs", () => {
    const cache = new BrowserObservations(undefined, true);
    const content = Array.from(
      { length: 900 },
      (_, n) => `- button "Item ${n}" [ref=f9e${n}]\n`,
    ).join("");
    const { page } = capture(cache, content);
    const before = cache.currentPage().snapshot!;
    capture(cache, content.replaceAll("f9", "f100"));
    const current = cache.currentPage();
    expect(current.snapshot?.readProgressInheritedFrom).toBe(
      page.observationId,
    );
    expect(current.snapshot?.nextUnreadCursor).not.toBeNull();
    cache.deliverCurrentPage(current);
    expect(cache.staleRef(click("f100e899"))).toBe(true);
    expect(before.content).not.toContain("Item 899");
    // URL changes are a distinct observation, even when the visible text matches.
    capture(cache, content, { url: "https://other.example.com" });
    expect(
      cache.currentPage().snapshot?.readProgressInheritedFrom,
    ).toBeUndefined();
  });

  it("defers new refs until the final decision view is committed, including reads within a multi-call turn", () => {
    const cache = new BrowserObservations(undefined, true);
    const { page } = capture(cache, '- button "New" [ref=e1]\n');
    expect(cache.staleRef(click("e1"))).toBe(true);
    cache.read(String(page.observationId));
    expect(cache.staleRef(click("e1"))).toBe(true);
    const pending = cache.currentPage();
    expect(cache.staleRef(click("e1"))).toBe(true);
    cache.deliverCurrentPage(pending);
    expect(cache.staleRef(click("e1"))).toBe(false);
    capture(cache, '- button "Replaced" [ref=e2]\n');
    expect(cache.staleRef(click("e1"))).toBe(true);
    expect(cache.staleRef(click("e2"))).toBe(true);
  });
  it("keeps a real snapshot addressable and actionable when DOM plus feedback exceeds the envelope budget", () => {
    const cache = new BrowserObservations();
    const content =
      '- button "新增白名单" [ref=f91e130]\n' +
      '- text "列表内容"\n'.repeat(950);
    const feedback = {
      commandId: "search",
      pending: false,
      coverageIncomplete: true,
      requests: [{ responseSummary: "网络诊断".repeat(1450) }],
    };
    const raw = {
      status: "SUCCEEDED",
      result: { content, actionFeedback: feedback },
    };
    cache.capture(command("page.snapshot"), raw);
    const projected = cache.project(raw) as {
      result: {
        observationId: string;
        content: string;
        contentOmitted?: boolean;
        nextCursor: number;
      };
    };
    expect(jsonBytes(projected)).toBeLessThanOrEqual(16 * 1024);
    expect(projected.result.contentOmitted).toBeUndefined();
    expect(projected.result.content).toContain("[ref=f91e130]");
    expect(
      cache
        .index()
        .find(
          (entry) => entry.observationId === projected.result.observationId,
        ),
    ).toMatchObject({ commandType: "page.snapshot", refState: "CURRENT" });
    const view = cache.currentPage();
    cache.deliverCurrentPage(view);
    expect(cache.staleRef(click("f91e130"))).toBe(false);
    expect(cache.unreadRef(click("f91e130"))).toBe(false);
    expect(cache.latestActionFeedback()).toMatchObject({
      summary: { pending: false, coverageIncomplete: true },
      details: { nextAction: { tool: "read_observation" } },
    });
    const next = cache.read(
      projected.result.observationId,
      projected.result.nextCursor,
    );
    expect(cache.currentPage().snapshot).toMatchObject({
      cursor: projected.result.nextCursor,
      content: next.content,
    });
    expect(
      cache
        .index()
        .find(
          (entry) => entry.observationId === projected.result.observationId,
        ),
    ).toMatchObject({ readCursors: [0, projected.result.nextCursor] });
  });

  it("never exposes refs from generic JSON, an undelivered page, or a historical snapshot", () => {
    const cache = new BrowserObservations();
    const { page } = capture(
      cache,
      '- text "padding"\n'.repeat(1000) + '- button "Target" [ref=e900]\n',
    );
    const correction = cache.unreadRefCorrection(click("e900"))!;
    expect(correction).toMatchObject({
      code: "OBSERVATION_NOT_READ",
      nextAction: {
        arguments: {
          observationId: page.observationId,
          cursor: page.nextCursor,
        },
      },
    });
    capture(cache, JSON.stringify({ body: "[ref=e900]" }), { snapshot: false });
    cache.deliverCurrentPage(cache.currentPage());
    expect(cache.staleRef(click("e900"))).toBe(true);
    cache.read(String(page.observationId), Number(page.nextCursor));
    const preview = cache.currentPage();
    cache.invalidate();
    capture(cache, '- button "New" [ref=e42]\n');
    cache.deliverCurrentPage(preview);
    expect(cache.staleRef(click("e900"))).toBe(true);
  });

  it("refreshes after form changes and does not loop automatic reads after a failed snapshot", () => {
    const cache = new BrowserObservations();
    expect(cache.needsSnapshot()).toBe(true);
    cache.capture(command("page.snapshot"), { status: "FAILED" });
    expect(cache.needsSnapshot()).toBe(false);
    capture(cache, '- input "Name" [ref=e1]\n');
    expect(cache.needsSnapshot()).toBe(false);
    cache.capture(
      command("page.fill", { target: { ref: "e1" }, text: "Ada" }),
      { status: "SUCCEEDED", result: { ok: true } },
    );
    expect(cache.needsSnapshot()).toBe(true);
    expect(cache.currentPage().snapshot).toBeNull();
  });

  it("routes a ref back to an earlier delivered page after the current DOM window moves", () => {
    const cache = new BrowserObservations();
    const { page } = capture(
      cache,
      '- button "First" [ref=e1]\n' +
        '- text "padding"\n'.repeat(1000) +
        '- button "Last" [ref=e2]\n',
    );
    cache.read(String(page.observationId), Number(page.nextCursor));
    cache.deliverCurrentPage(cache.currentPage());
    expect(cache.staleRef(click("e1"))).toBe(true);
    expect(cache.unreadRefCorrection(click("e1"))).toMatchObject({
      nextAction: {
        arguments: { observationId: page.observationId, cursor: 0 },
      },
    });
    cache.read(String(page.observationId), 0);
    cache.deliverCurrentPage(cache.currentPage());
    expect(cache.staleRef(click("e1"))).toBe(false);
  });

  it("delivers full historical observation text without making its refs actionable", () => {
    const cache = new BrowserObservations();
    const { page } = capture(
      cache,
      "历史说明".repeat(500) + '\n- input "Order PO-0042" [ref=e1]\n',
    );
    capture(cache, '- button "Current" [ref=e2]\n');
    const historical = cache.read(String(page.observationId));
    const view = cache.currentPage();
    expect(view.latestObservation).toMatchObject({
      content: historical.content,
      refState: "HISTORICAL",
    });
    expect(String(view.latestObservation?.content)).toContain("PO-0042");
    cache.deliverCurrentPage(view);
    expect(cache.staleRef(click("e1"))).toBe(true);
    expect(cache.staleRef(click("e2"))).toBe(false);
    const requestedObservation = view.latestObservation;
    capture(cache, '- button "Refreshed" [ref=e3]\n');
    cache.retainLatestObservation(requestedObservation);
    const refreshed = cache.currentPage();
    expect(refreshed.latestObservation?.content).toBe(historical.content);
    cache.deliverCurrentPage(refreshed);
    expect(cache.staleRef(click("e1"))).toBe(true);
    expect(cache.staleRef(click("e3"))).toBe(false);
  });

  it("retains the latest action feedback independently of observation history and preserves it when paging DOM", () => {
    const cache = new BrowserObservations();
    const actionFeedback = {
      commandId: "save",
      requests: [{ status: 400, responseSummary: "USER_NOT_FOUND" }],
    };
    const raw = { result: { content: "表单\n".repeat(8000), actionFeedback } };
    cache.capture(command("page.snapshot"), raw);
    expect(cache.project(raw)).toMatchObject({ result: { actionFeedback } });
    for (let index = 0; index < 10; index++)
      capture(cache, `读取页面 ${index}`);
    expect(cache.latestActionFeedback()).toEqual(actionFeedback);
    const update = {
      result: { actionFeedback: { ...actionFeedback, pending: false } },
    };
    cache.capture(command("page.network"), update);
    expect(cache.latestActionFeedback()).toEqual(update.result.actionFeedback);
  });
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
    const reread = cache.read(String(first.observationId));
    expect(reread).toMatchObject({
      content: first.content,
      nextCursor: first.nextCursor,
      nextUnreadCursor: null,
    });
    expect(reread).not.toHaveProperty("nextAction");
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
    expect(cache.unreadRefCorrection(click("e1"))).toMatchObject({
      code: "OBSERVATION_CONTENT_OMITTED",
    });
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
      error: { details: { observationId: string } };
      locatorRecovery: {
        snapshot: { result: { observationId: string; content: string } };
      };
    };
    expect(jsonBytes(projected)).toBeLessThanOrEqual(16 * 1_024);
    expect(projected).toMatchObject({
      status: "FAILED",
      locatorRecovery: { recoveryToken: "call-42", exhausted: false },
    });
    expect(projected.locatorRecovery.snapshot.result.content).toBe(
      snapshot.result.content,
    );
    expect(cache.staleRef(click("e42"))).toBe(false);
    let page = cache.read(projected.error.details.observationId);
    let joined = "";
    while (true) {
      joined += page.content;
      if (page.nextCursor === null) break;
      page = cache.read(
        projected.error.details.observationId,
        Number(page.nextCursor),
      );
    }
    expect(JSON.parse(joined)).toEqual(raw.error);
    const snapshotId = projected.locatorRecovery.snapshot.result.observationId;
    cache.read(snapshotId);
    expect(cache.staleRef(click("e42"))).toBe(false);
    expect(raw).toEqual(original);
  });
});
