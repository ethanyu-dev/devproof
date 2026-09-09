import { chromium, type Browser, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomObservations } from "./dom-observation.js";
import { VisualObservations } from "./visual-observation.js";

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
