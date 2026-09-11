import type { Page } from "playwright";

const MAX_PREVIEW_PIXELS = 6_000_000;

/** Capture more raster pixels without resizing the page or changing input coordinates. */
export async function captureHighDensityPreview(
  page: Page,
  options: { pixelRatio: number; quality: number; maxBytes: number },
): Promise<Buffer | undefined> {
  const viewport = page.viewportSize();
  if (!viewport) return;
  const scale = Math.min(
    2,
    options.pixelRatio,
    Math.sqrt(MAX_PREVIEW_PIXELS / (viewport.width * viewport.height)),
  );
  if (scale <= 1) return;

  const cdp = await page.context().newCDPSession(page);
  try {
    const { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics");
    const { data } = await cdp.send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      clip: {
        x: cssVisualViewport.pageX,
        y: cssVisualViewport.pageY,
        width: viewport.width,
        height: viewport.height,
        scale,
      },
      format: "jpeg",
      quality: options.quality,
    });
    const bytes = Buffer.from(data, "base64");
    // Keep the existing transport budget; the caller can retry at CSS resolution.
    return bytes.byteLength <= options.maxBytes ? bytes : undefined;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}
