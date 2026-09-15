import { chromium, type Browser, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { comboboxClickTarget } from "./combobox-click.js";
let browser: Browser;
let page: Page;
beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});
afterEach(async () => {
  await browser?.close();
});
const control = `<div id="selector" style="position:relative;width:240px;height:32px" onclick="document.querySelector('input').setAttribute('aria-expanded','true')"><span><input role="combobox" aria-expanded="false" style="width:230px;height:30px;opacity:0"></span><span style="position:absolute;inset:0;cursor:pointer">合规模型映射</span></div>`;
describe("combobox click target", () => {
  it("opens a select covered by its own selected label", async () => {
    await page.setContent(control);
    const target = await comboboxClickTarget(page.locator("input"));
    await target.click();
    expect(await page.locator("input").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });
  it("does not redirect clicks through an unrelated overlay", async () => {
    await page.setContent(
      `${control}<div style="position:fixed;inset:0;background:white">另一个弹窗</div>`,
    );
    const original = page.locator("input");
    const target = await comboboxClickTarget(original);
    expect(target).toBe(original);
    expect(await page.locator("input").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });
  it("keeps an uncovered input unchanged", async () => {
    await page.setContent('<input role="combobox" aria-expanded="false">');
    const target = page.locator("input");
    expect(await comboboxClickTarget(target)).toBe(target);
  });
});
