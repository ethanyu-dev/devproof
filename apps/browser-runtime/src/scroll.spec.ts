import { chromium, type Browser, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomObservations } from "./dom-observation.js";
import { scrollElement } from "./scroll.js";

let browser: Browser;
let page: Page;
beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
});
afterEach(async () => {
  await browser?.close();
});

function ref(content: string, text: string) {
  const found = content
    .split("\n")
    .find((line) => line.includes(text))
    ?.match(/\[ref=(f\d+e\d+)\]/u)?.[1];
  if (!found) throw new Error(`Missing ref for ${text}`);
  return found;
}

describe("observed container scrolling", () => {
  it.each(["document", "shadow", "iframe"])(
    "renders and selects previously absent virtual rows in %s",
    async (realm) => {
      await page.setContent(
        '<div id="host"></div><iframe style="width:700px;height:500px"></iframe>',
      );
      if (realm !== "iframe")
        await page.locator("iframe").evaluate((node) => {
          node.hidden = true;
        });
      const frame = realm === "iframe" ? page.frames()[1]! : page.mainFrame();
      await frame.evaluate((realm) => {
        const documentForNodes =
          realm === "shadow"
            ? document.querySelector("iframe")!.contentDocument!
            : document;
        const body = documentForNodes.createElement("div");
        body.innerHTML = `<div id="background" style="height:400px;overflow:auto"><div style="height:1200px">
        <div id="holder" style="height:256px;width:240px;overflow:hidden;position:relative">
          <div style="height:544px;overflow:hidden;position:relative">
            <div id="rows" style="position:absolute;inset:0 0 auto 0"></div>
          </div>
        </div><div id="selected"></div>
      </div></div>`;
        if (realm === "shadow")
          document
            .querySelector("#host")!
            .attachShadow({ mode: "open" })
            .append(body);
        else document.body.append(body);
        const holder = body.querySelector("#holder")!;
        const rows = body.querySelector("#rows") as HTMLElement;
        const render = () => {
          const first = Math.floor(holder.scrollTop / 32);
          rows.style.transform = `translateY(${first * 32}px)`;
          rows.replaceChildren(
            ...Array.from({ length: Math.min(10, 17 - first) }, (_, offset) => {
              const item = documentForNodes.createElement("div");
              item.style.cssText = "height:32px;cursor:pointer";
              item.textContent = `类型${first + offset}`;
              item.onclick = () => {
                body.querySelector("#selected")!.textContent =
                  `已选择类型${first + offset}`;
              };
              return item;
            }),
          );
        };
        render();
        holder.addEventListener("scroll", () => setTimeout(render, 40));
        if (realm === "shadow") {
          for (const node of [body, holder, rows]) {
            Object.defineProperty(node, "ownerDocument", {
              get: () => documentForNodes,
            });
            node.getRootNode = () => documentForNodes;
          }
        }
      }, realm);
      const dom = new DomObservations();
      const before = await dom.snapshot(page);
      expect(await frame.locator("#rows > div").count()).toBe(10);
      expect(await frame.getByText("类型16", { exact: true }).count()).toBe(0);
      expect(before.content).not.toContain('"类型9"');
      const holder = ref(before.content, "scrollY=0/288");
      await expect(
        scrollElement(
          dom.locator(page, ref(before.content, '"类型7"')),
          { x: 0, y: 192 },
          1500,
        ),
      ).rejects.toMatchObject({ code: "SCROLL_TARGET_NOT_SCROLLABLE" });
      expect(
        await frame.locator("#background").evaluate((node) => node.scrollTop),
      ).toBe(0);
      dom.focus(page, holder);
      const first = await scrollElement(
        dom.locator(page, holder),
        { x: 0, y: 192 },
        1500,
      );
      expect(first).toMatchObject({
        scrolled: true,
        scrollFeedback: { status: "MOVED", after: { y: 192 }, settled: true },
      });
      const middle = await dom.snapshot(page);
      expect(middle.focusRef).toBe(ref(middle.content, "scrollY=192/288"));
      expect(middle.content).toContain('"类型13"');
      const last = await scrollElement(
        dom.locator(page, middle.focusRef!),
        { x: 0, y: 192 },
        1500,
      );
      expect(last).toMatchObject({
        scrollFeedback: { after: { y: 288 }, atEnd: { y: true } },
      });
      const bottom = await dom.snapshot(page);
      await expect(
        scrollElement(
          dom.locator(page, ref(bottom.content, "scrollY=288/288")),
          { x: 0, y: 100 },
          1500,
        ),
      ).resolves.toMatchObject({
        scrolled: false,
        scrollFeedback: { status: "AT_BOUNDARY" },
      });
      expect(
        await frame.locator("#background").evaluate((node) => node.scrollTop),
      ).toBe(0);
      await dom.locator(page, ref(bottom.content, '"类型16"')).click();
      expect(await frame.locator("#selected").textContent()).toBe(
        "已选择类型16",
      );
      expect(() => dom.locator(page, holder)).toThrow(/expired/);
    },
  );

  it.each(["auto", "scroll", "hidden"])(
    "supports horizontal and reverse movement with overflow %s",
    async (overflow) => {
      await page.setContent(
        `<div id="holder" style="width:100px;height:80px;overflow:${overflow}"><div style="width:400px;height:300px">内容</div></div>`,
      );
      const holder = page.locator("#holder");
      expect(
        await scrollElement(holder, { x: 120, y: 60 }, 1500),
      ).toMatchObject({ scrollFeedback: { after: { x: 120, y: 60 } } });
      expect(
        await scrollElement(holder, { x: -120, y: -60 }, 1500),
      ).toMatchObject({
        scrollFeedback: {
          after: { x: 0, y: 0 },
          atStart: { x: true, y: true },
        },
      });
    },
  );

  it("excludes clip and non-overflowing decorations, rejecting clip actions", async () => {
    await page.setContent(
      '<div id="clip" style="height:80px;overflow:clip"><div style="height:300px">内容</div></div><div style="overflow:hidden">装饰</div>',
    );
    expect((await new DomObservations().snapshot(page)).content).not.toContain(
      "scrollY=",
    );
    await expect(
      scrollElement(page.locator("#clip"), { x: 0, y: 100 }, 1500),
    ).rejects.toMatchObject({ code: "SCROLL_TARGET_NOT_SCROLLABLE" });
  });

  it("reports NO_MOVEMENT when a component resets its position, and fails on replacement", async () => {
    await page.setContent(
      '<div id="holder" style="height:80px;overflow:hidden"><div style="height:300px">内容</div></div>',
    );
    await page.locator("#holder").evaluate((node) =>
      node.addEventListener("scroll", () => {
        node.scrollTop = 0;
      }),
    );
    expect(
      await scrollElement(page.locator("#holder"), { x: 0, y: 100 }, 1500),
    ).toMatchObject({
      scrolled: false,
      scrollFeedback: { status: "NO_MOVEMENT", atEnd: { y: false } },
    });
    await page
      .locator("#holder")
      .evaluate((node) =>
        node.addEventListener("scroll", () => node.remove(), { once: true }),
      );
    await expect(
      scrollElement(page.locator("#holder"), { x: 0, y: 100 }, 1500),
    ).rejects.toMatchObject({ code: "STALE_DOM_REFERENCE" });
  });
});
