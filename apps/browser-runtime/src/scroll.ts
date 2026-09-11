import { createHash } from "node:crypto";
import type { Locator } from "playwright";

// `hidden` suppresses the scrollbar, but still permits programmatic scrolling.
// `clip` does not create a scroll container. Keep observation and action in sync.
export const SCROLL_OVERFLOWS = ["auto", "scroll", "hidden"];

export async function scrollElement(
  locator: Locator,
  delta: { x: number; y: number },
  timeout: number,
) {
  const observed = await locator.evaluate(
    async (element, input) => {
      const geometry = (node: Element) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const visible =
          box.width > 0 &&
          box.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !node.hasAttribute("hidden");
        return {
          position: { x: node.scrollLeft, y: node.scrollTop },
          extent: {
            x: Math.max(0, node.scrollWidth - node.clientWidth),
            y: Math.max(0, node.scrollHeight - node.clientHeight),
          },
          viewport: { width: node.clientWidth, height: node.clientHeight },
          axes: {
            x:
              visible &&
              node.clientWidth > 0 &&
              input.overflows.includes(style.overflowX),
            y:
              visible &&
              node.clientHeight > 0 &&
              input.overflows.includes(style.overflowY),
          },
        };
      };
      const parent = (node: Element): Element | null =>
        node.parentElement ??
        (Node.prototype.getRootNode.call(node) as ShadowRoot).host ??
        null;
      const path: string[] = [];
      for (
        let node: Element | null = element;
        node && path.length < 40;
        node = parent(node)
      ) {
        path.unshift(
          `${node.tagName}:${node.id}:${Array.from(node.parentElement?.children ?? []).indexOf(node)}`,
        );
      }
      const identity = { frame: location.href, path };
      const before = geometry(element);
      const supports = (state: typeof before) =>
        (!input.delta.x || state.axes.x) && (!input.delta.y || state.axes.y);
      if (!supports(before)) {
        let nearest;
        for (
          let node = parent(element), depth = 0;
          node && depth < 40;
          node = parent(node), depth++
        ) {
          const state = geometry(node);
          if (supports(state) && (state.extent.x > 1 || state.extent.y > 1)) {
            nearest = { tag: node.tagName.toLowerCase(), ...state };
            break;
          }
        }
        return { error: { target: before, nearestScrollContainer: nearest } };
      }
      // Override CSS smooth scrolling so one command has a bounded physical effect.
      element.scrollBy({
        left: input.delta.x,
        top: input.delta.y,
        behavior: "instant",
      });
      const started = performance.now();
      const settled = await new Promise<boolean>((resolve) => {
        let frame = 0;
        let stable = 0;
        let previous = "";
        const finish = (value: boolean) => {
          clearTimeout(timer);
          cancelAnimationFrame(frame);
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), input.waitMs);
        const sample = () => {
          if (!element.isConnected) return finish(false);
          // Position alone can settle before a virtual list renders its new rows.
          const signature = JSON.stringify([
            geometry(element),
            element.textContent?.slice(0, 4096),
          ]);
          stable = signature === previous ? stable + 1 : 0;
          previous = signature;
          if (stable >= 2 && performance.now() - started >= 100)
            return finish(true);
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
      });
      if (!element.isConnected) return { detached: true };
      const after = geometry(element);
      const moved =
        Math.abs(after.position.x - before.position.x) > 0.5 ||
        Math.abs(after.position.y - before.position.y) > 0.5;
      const atStart = { x: after.position.x <= 1, y: after.position.y <= 1 };
      const atEnd = {
        x: after.position.x >= after.extent.x - 1,
        y: after.position.y >= after.extent.y - 1,
      };
      const boundary =
        (input.delta.x !== 0 || input.delta.y !== 0) &&
        (!input.delta.x || (input.delta.x > 0 ? atEnd.x : atStart.x)) &&
        (!input.delta.y || (input.delta.y > 0 ? atEnd.y : atStart.y));
      return {
        identity,
        scrolled: moved,
        scrollFeedback: {
          version: 1 as const,
          status: moved
            ? ("MOVED" as const)
            : boundary
              ? ("AT_BOUNDARY" as const)
              : ("NO_MOVEMENT" as const),
          before: before.position,
          after: after.position,
          extentBefore: before.extent,
          extent: after.extent,
          viewport: after.viewport,
          atStart,
          atEnd,
          settled,
        },
      };
    },
    {
      delta,
      overflows: SCROLL_OVERFLOWS,
      waitMs: Math.max(1, Math.min(1000, timeout - 100)),
    },
    { timeout },
  );
  if (observed.error)
    throw Object.assign(
      new Error(
        "Scroll target is not a scroll container. Observe again and use a container ref with scrollY/scrollX; scrolling an option does not scroll its parent.",
      ),
      {
        code: "SCROLL_TARGET_NOT_SCROLLABLE",
        retryable: true,
        details: observed.error,
      },
    );
  if (observed.detached)
    throw Object.assign(
      new Error("Scroll target was replaced; observe the current page again."),
      {
        code: "STALE_DOM_REFERENCE",
        retryable: true,
      },
    );
  return {
    scrolled: observed.scrolled,
    scrollFeedback: {
      ...observed.scrollFeedback,
      targetKey: createHash("sha256")
        .update(JSON.stringify(observed.identity))
        .digest("hex"),
    },
  };
}
