import type { Locator } from "playwright";

/** Some selects put their label over a transparent search input. Click only the
 * same control's small wrapper; never force through a modal or unrelated overlay. */
export async function comboboxClickTarget(locator: Locator): Promise<Locator> {
  const depth = await locator
    .evaluate((node) => {
      if (
        node.tagName.toLowerCase() !== "input" ||
        node.getAttribute("role") !== "combobox" ||
        node.getAttribute("aria-expanded") === "true"
      )
        return 0;
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height) return 0;
      const x = rect.left + rect.width / 2,
        y = rect.top + rect.height / 2;
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (!hit || hit === node || node.contains(hit)) return 0;
      let parent = node.parentElement;
      for (
        let depth = 1;
        parent && depth <= 3;
        depth++, parent = parent.parentElement
      ) {
        const box = parent.getBoundingClientRect();
        if (
          box.height > Math.max(64, rect.height * 2) ||
          parent.querySelectorAll('input[role="combobox"]').length !== 1 ||
          parent.querySelector('button,a,[role="button"]')
        )
          return 0;
        if (
          parent.contains(hit) &&
          !hit.closest('button,a,[role="button"],input,textarea,select')
        )
          return depth;
      }
      return 0;
    })
    .catch(() => 0);
  let target = locator;
  for (let i = 0; i < depth; i++) target = target.locator("..");
  return target;
}
