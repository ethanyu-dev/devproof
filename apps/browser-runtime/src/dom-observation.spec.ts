import { chromium, type Browser, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actionTarget } from "./action-feedback.js";
import { DomObservations } from "./dom-observation.js";
import { VisualObservations } from "./visual-observation.js";
import {
  STRUCTURED_OBSERVATION_MAX_BYTES,
  structuredObservationSchema,
} from "@devproof/runtime-protocol";

let browser: Browser;
let page: Page;
beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 2,
  });
});
afterEach(async () => {
  await browser?.close();
});

function ref(content: string, label: string) {
  const found = content
    .split("\n")
    .find((line) => line.includes(label))
    ?.match(/\[ref=(f\d+e\d+)\]/u)?.[1];
  if (!found) throw new Error(`Missing DOM ref for ${label}: ${content}`);
  return found;
}

describe("DOM + visual observation without ARIA", () => {
  it("does not arbitrarily choose between two dialogs on overflow", async () => {
    await page.setContent(
      Array.from({ length: 3000 }, () => `<p>${"x".repeat(500)}</p>`).join("") +
        '<div role="dialog" style="position:fixed;top:0">First</div><div role="dialog" style="position:fixed;top:20px">Second</div>',
    );
    const result = await new DomObservations().snapshot(page, undefined, {
      timeout: 15000,
    });
    expect(result.structured.coverage.scope).toBe("VIEWPORT");
    expect(result.structured.coverage.limitEvents?.[0].action).toBe("TRIMMED");
    expect(result.structured.coverage.truncated).toBe(true);
    expect(result.structured.nodes.length).toBeGreaterThan(0);
  }, 20000);
  it("retains structured captures above the old byte and region limits", async () => {
    await page.setContent(
      "<style>form{position:absolute;top:0}</style>" +
        Array.from(
          { length: 250 },
          (_, i) => `<form><label>Field ${i}</label></form>`,
        ).join("") +
        Array.from({ length: 1000 }, () => `<p>${"x".repeat(350)}</p>`).join(
          "",
        ),
    );
    const observed = await new DomObservations().snapshot(page, undefined, {
      timeout: 15000,
    });
    expect(
      Buffer.byteLength(JSON.stringify(observed.structured)),
    ).toBeGreaterThan(512 * 1024);
    expect(observed.structured.regions.length).toBeGreaterThan(200);
    expect(observed.structured.coverage.truncated).toBe(false);
    expect(
      structuredObservationSchema.safeParse(observed.structured).success,
    ).toBe(true);
  }, 20000);

  it("recaptures a unique active dialog when the background exceeds the byte budget", async () => {
    await page.setContent(
      Array.from({ length: 3000 }, () => `<p>${"x".repeat(500)}</p>`).join("") +
        '<div role="dialog" style="position:fixed;top:0"><button aria-pressed="true">周 一</button></div>',
    );
    const dom = new DomObservations();
    const observed = await dom.snapshot(page, undefined, { timeout: 15000 });
    expect(observed.structured.coverage).toMatchObject({
      scope: "REGION",
      truncated: false,
      completeWithinScope: true,
    });
    expect(observed.structured.coverage.limitEvents?.[0]).toMatchObject({
      action: "SCOPED_RECAPTURE",
      exceeded: expect.arrayContaining(["BYTES"]),
    });
    const button = observed.structured.nodes.find((n) => n.tag === "button")!;
    expect(button.checked).toBe(true);
    expect(await dom.locator(page, button.ref!).count()).toBe(1);
    expect(await dom.verifyCapture(page, observed.structured)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(observed.structured))).toBeLessThan(
      STRUCTURED_OBSERVATION_MAX_BYTES,
    );
  }, 20000);

  it("keeps partial data when an explicitly scoped region is oversized, without recursive retries", async () => {
    await page.setContent(
      '<div role="dialog">' +
        Array.from({ length: 3000 }, () => `<p>${"x".repeat(500)}</p>`).join(
          "",
        ) +
        "</div>",
    );
    const observed = await new DomObservations().snapshot(
      page,
      page.getByRole("dialog"),
      { timeout: 15000 },
    );
    expect(observed.structured.nodes.length).toBeGreaterThan(0);
    expect(observed.captureLimited).toBe(true);
    expect(observed.structured.coverage).toMatchObject({
      completeWithinScope: false,
      truncated: true,
    });
    expect(observed.structured.coverage.limitEvents).toHaveLength(1);
    expect(observed.structured.coverage.limitEvents?.[0].action).toBe(
      "TRIMMED",
    );
    expect(Buffer.byteLength(JSON.stringify(observed.structured))).toBeLessThan(
      STRUCTURED_OBSERVATION_MAX_BYTES,
    );
    expect(
      structuredObservationSchema.safeParse(observed.structured).success,
    ).toBe(true);
  }, 20000);
  it("preserves interpolated text and captures toggle-button state", async () => {
    await page.setContent(
      '<div id="period"></div><button aria-pressed="true">周 一</button>',
    );
    await page.locator("#period").evaluate((element) => {
      for (const value of ["周一, 周五 ", "09:00", "–", "18:00"])
        element.append(
          document.createTextNode(value),
          document.createComment("react"),
        );
    });
    const dom = new DomObservations();
    const first = await dom.snapshot(page);
    expect(first.content).toContain('"周一, 周五 09:00–18:00"');
    expect(
      first.structured.nodes.find((n) => n.tag === "button")?.checked,
    ).toBe(true);
    await page
      .locator("button")
      .evaluate((button) => button.setAttribute("aria-pressed", "false"));
    const second = await dom.snapshot(page);
    expect(
      second.structured.nodes.find((n) => n.tag === "button")?.checked,
    ).toBe(false);
    expect(second.content).toContain('"周 一"');
  });
  it("exposes custom switch state and changes the action fingerprint after toggling", async () => {
    await page.setContent(
      `<button role="switch" aria-checked="true" onclick="this.setAttribute('aria-checked',this.getAttribute('aria-checked')==='true'?'false':'true')"><span>启用禁用</span></button>`,
    );
    const dom = new DomObservations();
    expect((await dom.snapshot(page)).content).toContain('aria-checked="true"');
    const target = page.locator("button span");
    const before = await actionTarget(target);
    await target.click();
    expect((await dom.snapshot(page)).content).toContain(
      'aria-checked="false"',
    );
    const after = await actionTarget(target);
    expect(after.targetKey).toBe(before.targetKey);
    expect(after.stateKey).not.toBe(before.stateKey);
  });
  it.each([false, true])(
    "keeps scoped refs usable after clearing the old root registry (iframe=%s)",
    async (inFrame) => {
      const html =
        '<div tabindex="0">Dialog<button onclick="this.textContent=\'Saved\'">OK</button></div>';
      await page.setContent(
        inFrame ? "<button>OK</button><iframe></iframe>" : html,
      );
      if (inFrame) await page.frames()[1]!.setContent(html);
      const dom = new DomObservations();
      const full = await dom.snapshot(page);
      const oldRoot = ref(full.content, '"Dialog"');
      const scoped = await dom.snapshot(page, dom.locator(page, oldRoot));
      expect(() => dom.locator(page, oldRoot)).toThrow(/expired/);
      const button = ref(scoped.content, '"OK"');
      expect(await dom.locator(page, button).count()).toBe(1);
      const nested = await dom.snapshot(page, dom.locator(page, button));
      await dom.locator(page, ref(nested.content, '"OK"')).click();
      const frame = inFrame ? page.frames()[1]! : page.mainFrame();
      expect(await frame.getByText("Saved", { exact: true }).count()).toBe(1);
      if (inFrame)
        expect(await page.getByText("OK", { exact: true }).count()).toBe(1);
    },
  );

  it("exposes adopted controls with distinct refs and redacts cross-realm password values", async () => {
    await page.setContent(
      '<input placeholder="请输入用户账号"><div id="host"></div><iframe hidden></iframe>',
    );
    await page.locator("#host").evaluate((host) => {
      const virtualDocument =
        document.querySelector("iframe")!.contentDocument!;
      const body = virtualDocument.createElement("div");
      body.innerHTML =
        '<label>弹窗账号<input placeholder="请输入用户账号"></label><input type="password" value="must-not-leak"><input type="checkbox" checked><textarea readonly>说明</textarea><select><option value="legacy">旧版类型</option></select>';
      host.attachShadow({ mode: "open" }).append(body);
      for (const node of [body, ...body.querySelectorAll("*")]) {
        Object.defineProperty(node, "ownerDocument", {
          get: () => virtualDocument,
        });
        node.getRootNode = () => virtualDocument;
      }
      if (body.querySelector("input") instanceof HTMLInputElement)
        throw new Error("Fixture must retain the other realm's prototype");
    });
    const dom = new DomObservations();
    const observed = await dom.snapshot(page);
    expect(
      observed.content.match(/placeholder="请输入用户账号"/gu),
    ).toHaveLength(2);
    expect(observed.content).not.toContain("must-not-leak");
    expect(observed.content).toContain("checked=true");
    expect(observed.content).toContain("readonly");
    expect(observed.content).toContain('"value":"legacy"');
    await dom
      .locator(page, ref(observed.content, 'label="弹窗账号"'))
      .fill("test-user");
    expect(await page.locator(":root > body > input").inputValue()).toBe("");
    expect(await page.locator("#host input").first().inputValue()).toBe(
      "test-user",
    );
  });
  it("resolves connected microfrontend nodes whose document and root are virtualized", async () => {
    await page.setContent(
      '<div id="microfrontend"></div><iframe hidden></iframe>',
    );
    await page.locator("#microfrontend").evaluate((host) => {
      const iframe = document.querySelector("iframe")!;
      const virtualDocument = iframe.contentDocument!;
      const shadow = host.attachShadow({ mode: "open" });
      const body = virtualDocument.createElement("body");
      const button = virtualDocument.createElement("button");
      button.textContent = "Whitelist settings";
      button.addEventListener("click", () => {
        button.textContent = "Opened";
      });
      body.append(button);
      shadow.append(body);
      // Microfrontends such as Wujie expose their sandbox document instead of
      // the native shadow root / owner document, without replacing the node.
      for (const node of [body, button]) {
        Object.defineProperty(node, "ownerDocument", {
          get: () => virtualDocument,
        });
        node.getRootNode = () => virtualDocument;
      }
    });
    const dom = new DomObservations();
    const observed = await dom.snapshot(page);
    const target = ref(observed.content, "Whitelist settings");
    expect(await page.getByText("Whitelist settings").count()).toBe(1);
    expect(await dom.locator(page, target).count()).toBe(1);
    await dom.locator(page, target).click();
    expect(await page.getByText("Opened").count()).toBe(1);
    const scoped = await dom.snapshot(page, page.getByText("Opened"));
    expect(await dom.locator(page, ref(scoped.content, "Opened")).count()).toBe(
      1,
    );
  });

  it("observes a microfrontend with a body inside an open shadow root", async () => {
    await page.setContent('<div id="microfrontend"></div>');
    await page.locator("#microfrontend").evaluate((host) => {
      const body = document.createElement("body");
      body.innerHTML =
        "<button onclick=\"this.textContent='已选择'\">旧版类型</button>";
      host.attachShadow({ mode: "open" }).append(body);
    });
    const dom = new DomObservations();
    const observed = await dom.snapshot(page);
    expect(observed.captureLimited).toBe(false);
    await dom.locator(page, ref(observed.content, "旧版类型")).click();
    expect(await page.getByText("已选择").count()).toBe(1);
  });

  it("reports scroll coverage and excludes options clipped by the dropdown", async () => {
    await page.setContent(`<div id="options" style="height:80px;width:200px;overflow:auto">
      ${Array.from({ length: 12 }, (_, index) => `<div style="height:40px">类型${index}</div>`).join("")}
      <div style="height:40px" onclick="this.textContent='已选择'">旧版类型</div>
    </div>`);
    const dom = new DomObservations();
    const first = await dom.snapshot(page);
    expect(first.content).toContain("atEnd=false");
    expect(first.content).not.toContain("旧版类型");
    const containerRef = ref(first.content, "scrollY=");
    await dom
      .locator(page, containerRef)
      .evaluate((element) => element.scrollBy(0, 1000));
    const last = await dom.snapshot(page);
    expect(last.content).toContain("atEnd=true");
    expect(last.content).not.toContain('"类型0"');
    await dom.locator(page, ref(last.content, "旧版类型")).click();
    expect(await page.getByText("已选择").count()).toBe(1);
  });

  it("observes the updated result only after a delayed query's loading indicator disappears", async () => {
    await page.setContent(`<button id="search" onclick="document.querySelector('#loading').hidden=false">搜索</button>
      <div id="loading" hidden>正在加载</div><div id="rows">合规模型映射记录</div>`);
    const dom = new DomObservations();
    await page.locator("#search").click();
    const inFlight = await dom.snapshot(page);
    expect(inFlight.content).toContain("正在加载");
    expect(inFlight.content).toContain("合规模型映射记录");
    // Resolve the query after its intermediate state has actually been read.
    await page.evaluate(() => {
      document.querySelector("#rows")!.textContent = "旧版类型记录";
      (document.querySelector("#loading") as HTMLElement).hidden = true;
    });
    await dom
      .locator(page, ref(inFlight.content, "正在加载"))
      .waitFor({ state: "hidden" });
    const settled = await dom.snapshot(page);
    expect(settled.content).toContain("旧版类型记录");
    expect(settled.content).not.toContain("合规模型映射记录");
    expect(settled.content).not.toContain("正在加载");
  });

  it("observes and selects a portalled div option, excluding the hidden duplicate", async () => {
    const dom = new DomObservations();
    await page.setContent(`<div id="toggle" onclick="document.querySelector('#options').hidden=false">白名单类型</div>
      <div hidden>合规模型映射白名单</div>
      <div id="options" hidden><div onclick="document.querySelector('#toggle').textContent=this.textContent;this.parentElement.hidden=true">合规模型映射白名单</div></div>`);
    const before = await dom.snapshot(page);
    expect(before.content).not.toContain("合规模型映射白名单");
    const oldRef = ref(before.content, "白名单类型");
    await dom.locator(page, oldRef).click();
    const opened = await dom.snapshot(page);
    expect(opened.content.match(/合规模型映射白名单/gu)).toHaveLength(1);
    expect(() => dom.locator(page, oldRef)).toThrow(/expired/u);
    await dom.locator(page, ref(opened.content, "合规模型映射白名单")).click();
    expect(await page.locator("#toggle").innerText()).toBe(
      "合规模型映射白名单",
    );
    expect(
      await page.locator("[role], [aria-label], [data-devproof-ref]").count(),
    ).toBe(0);
  });

  it("preserves node identity across rerenders and exposes open shadows and frames", async () => {
    const dom = new DomObservations();
    await page.setContent(
      '<div id="replace">旧选项</div><div id="host"></div><iframe srcdoc="<button>Frame action</button>"></iframe>',
    );
    await page.locator("#host").evaluate((element) => {
      element.attachShadow({ mode: "open" }).innerHTML =
        "<button>Shadow action</button>";
    });
    const first = await dom.snapshot(page);
    const old = dom.locator(page, ref(first.content, "旧选项"));
    await page.locator("#replace").evaluate((element) => {
      element.outerHTML = '<div id="replace">新选项</div>';
    });
    expect(await old.count()).toBe(0); // Never silently redirects a stale ref.
    await dom.locator(page, ref(first.content, "Shadow action")).click();
    await dom.locator(page, ref(first.content, "Frame action")).click();
    const fresh = await dom.snapshot(page);
    await dom.locator(page, ref(fresh.content, "新选项")).click();
  });

  it("binds coordinates to the current tab, viewport, scroll and observation generation", async () => {
    const visual = new VisualObservations();
    await page.setContent(
      '<canvas width="300" height="100"></canvas><div style="height:2000px"></div>',
    );
    const first = await visual.capture(page);
    expect(first.viewport).toEqual({ width: 800, height: 600 });
    await visual.assertPoint(page, first.observationId, { x: 20, y: 30 });
    await expect(
      visual.assertPoint(page, first.observationId, { x: 800, y: 30 }),
    ).rejects.toMatchObject({ code: "STALE_VISUAL_OBSERVATION" });
    await page.evaluate(() => scrollTo(0, 100));
    await expect(
      visual.assertPoint(page, first.observationId, { x: 20, y: 30 }),
    ).rejects.toMatchObject({ code: "STALE_VISUAL_OBSERVATION" });
    const second = await visual.capture(page);
    await expect(
      visual.assertPoint(page, first.observationId, { x: 20, y: 30 }),
    ).rejects.toThrow(/stale/u);
    await page.setViewportSize({ width: 900, height: 600 });
    await expect(
      visual.assertPoint(page, second.observationId, { x: 20, y: 30 }),
    ).rejects.toThrow(/stale/u);
    const other = await browser.newPage();
    await expect(
      visual.assertPoint(other, second.observationId, { x: 20, y: 30 }),
    ).rejects.toThrow(/stale/u);
    const third = await visual.capture(page);
    visual.invalidate(page);
    await expect(
      visual.assertPoint(page, third.observationId, { x: 20, y: 30 }),
    ).rejects.toThrow(/stale/u);
  });
});
