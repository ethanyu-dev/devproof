import { randomUUID } from "node:crypto";
import type { Page } from "playwright";

/** Coordinates are viewport CSS pixels, tied to the last captured page state. */
export class VisualObservations {
  private readonly current = new WeakMap<
    Page,
    {
      observationId: string;
      capturedAt: string;
      url: string;
      viewport: { width: number; height: number };
      scrollX: number;
      scrollY: number;
    }
  >();

  invalidate(page: Page) {
    this.current.delete(page);
  }

  async capture(page: Page) {
    const state = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      scrollX,
      scrollY,
    }));
    const observation = {
      ...state,
      observationId: randomUUID(),
      capturedAt: new Date().toISOString(),
      url: page.url(),
    };
    this.current.set(page, observation);
    const { url: _url, ...metadata } = observation;
    return metadata;
  }

  async assertPoint(
    page: Page,
    id: string | undefined,
    point: { x: number; y: number },
  ) {
    const observed = this.current.get(page);
    const state = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
    }));
    if (
      !id ||
      !observed ||
      observed.observationId !== id ||
      observed.url !== page.url() ||
      Date.now() - Date.parse(observed.capturedAt) > 120_000 ||
      observed.viewport.width !== state.width ||
      observed.viewport.height !== state.height ||
      observed.scrollX !== state.scrollX ||
      observed.scrollY !== state.scrollY ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= state.width ||
      point.y >= state.height
    ) {
      throw Object.assign(
        new Error(
          "Visual observation is stale or coordinates are outside its viewport; capture page.snapshot or a viewport screenshot again.",
        ),
        {
          code: "STALE_VISUAL_OBSERVATION",
          retryable: true,
        },
      );
    }
  }
}
