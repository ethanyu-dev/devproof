import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { captureHighDensityPreview } from "./preview-screenshot.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chromium", headless: true });
});

afterAll(async () => {
  await browser?.close();
});

async function inspectImage(page: Page, data: Buffer) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      corner: [...context.getImageData(10, 10, 1, 1).data],
    };
  }, data.toString("base64"));
}

describe("high density browser previews", () => {
  it("captures the scrolled viewport at 2x without changing layout, focus, or pointer coordinates", async () => {
    const page = await browser.newPage({
      viewport: { width: 800, height: 400 },
    });
    try {
      await page.setContent(`
        <style>body{margin:0}section{height:400px}input{position:absolute;left:100px;top:450px}</style>
        <section style="background:red"></section>
        <section style="background:blue"><input value="login in progress"/></section>
      `);
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.locator("input").focus();
      const snapshot = () =>
        page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          scrollY,
          dpr: devicePixelRatio,
          focus: document.activeElement?.tagName,
        }));
      const before = await snapshot();
      const data = await captureHighDensityPreview(page, {
        pixelRatio: 2,
        quality: 85,
        maxBytes: 1_250 * 1_024,
      });
      expect(data).toBeDefined();
      const image = await inspectImage(page, data!);
      expect(image).toMatchObject({ width: 1600, height: 800 });
      expect(image.corner[2]).toBeGreaterThan(240);
      expect(image.corner[0]).toBeLessThan(10);
      expect(await snapshot()).toEqual(before);
      await page.mouse.click(120, 65);
      await page.keyboard.insertText(" appended");
      await expect(page.locator("input").inputValue()).resolves.toContain(
        " appended",
      );
    } finally {
      await page.close();
    }
  });

  it("falls back when a high density frame exceeds the transport budget", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<h1>Preview byte budget</h1>");
      await expect(
        captureHighDensityPreview(page, {
          pixelRatio: 2,
          quality: 85,
          maxBytes: 1,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await page.close();
    }
  });

  it("bounds high density raster area on a large viewport", async () => {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
    });
    try {
      await page.setContent("<h1>Large viewport</h1>");
      const data = await captureHighDensityPreview(page, {
        pixelRatio: 2,
        quality: 85,
        maxBytes: 1_250 * 1_024,
      });
      expect(data).toBeDefined();
      const image = await inspectImage(page, data!);
      expect(image.width).toBeGreaterThan(1600);
      expect(image.width * image.height).toBeLessThanOrEqual(6_000_000);
    } finally {
      await page.close();
    }
  });
});
