import { randomUUID } from "node:crypto";
import { selectors, type Locator, type Page } from "playwright";

// References point to observed DOM nodes, without adding attributes to the site.
// The selector does not consult accessibility roles, names, or ARIA snapshots.
const registryKey = `__devproof_dom_${randomUUID().replaceAll("-", "")}`;
let registration: Promise<void> | undefined;
let nextScope = 0;

function register() {
  return (registration ??= selectors.register(
    "devproofdom",
    `({
      query(root, ref) {
        const doc = root.ownerDocument || root;
        const node = doc.defaultView?.[${JSON.stringify(registryKey)}]?.get(ref);
        if (!node?.isConnected) return null;
        let ancestor = node;
        while (ancestor) {
          if (ancestor === root || root.contains(ancestor)) return node;
          ancestor = ancestor.getRootNode()?.host;
        }
        return null;
      },
      queryAll(root, ref) { const node = this.query(root, ref); return node ? [node] : []; }
    })`,
    { contentScript: false },
  ));
}

export class DomObservations {
  private readonly references = new WeakMap<Page, Map<string, Locator>>();

  locator(page: Page, ref: string): Locator {
    const locator = this.references.get(page)?.get(ref);
    if (!locator) {
      throw Object.assign(
        new Error("DOM reference expired; observe the current page again."),
        {
          code: "STALE_DOM_REFERENCE",
        },
      );
    }
    return locator;
  }

  async snapshot(
    page: Page,
    target?: Locator,
    options: {
      depth?: number | undefined;
      includeBoxes?: boolean | undefined;
      timeout?: number | undefined;
    } = {},
  ) {
    const deadline = Date.now() + (options.timeout ?? 5_000);
    await register();
    const references = new Map<string, Locator>();
    this.references.set(page, references);
    const roots = target
      ? [target]
      : page.frames().map((frame) => frame.locator("body"));
    const sections: string[] = [];
    let limited = false;
    for (const root of roots) {
      if (Date.now() >= deadline) {
        limited = true;
        break;
      }
      const prefix = `f${++nextScope}e`;
      try {
        const captured = await root.evaluate(
          (body, input) => {
            const view = body.ownerDocument.defaultView!;
            const store = new Map<string, Element>();
            (view as unknown as Record<string, unknown>)[input.key] = store;
            const lines: string[] = [];
            const refs: string[] = [];
            let visited = 0;
            let limited = false;
            const text = (value: string | null | undefined) =>
              (value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
            const walk = (element: Element, depth: number) => {
              if (++visited > 20_000 || refs.length >= 1_500) {
                limited = true;
                return;
              }
              if (
                ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD"].includes(
                  element.tagName,
                )
              )
                return;
              const style = view.getComputedStyle(element);
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                element.hasAttribute("hidden")
              )
                return;
              const box = element.getBoundingClientRect();
              const visible =
                box.width > 0 &&
                box.height > 0 &&
                box.bottom > 0 &&
                box.right > 0 &&
                box.top < view.innerHeight &&
                box.left < view.innerWidth;
              const ownText = text(
                Array.from(element.childNodes)
                  .filter((node) => node.nodeType === 3)
                  .map((node) => node.textContent)
                  .join(" "),
              );
              const tag = element.tagName.toLowerCase();
              const control =
                element instanceof HTMLInputElement ||
                element instanceof HTMLTextAreaElement ||
                element instanceof HTMLSelectElement;
              const interactive =
                control ||
                ["button", "a", "summary", "canvas", "iframe"].includes(tag) ||
                (element as HTMLElement).isContentEditable ||
                style.cursor === "pointer" ||
                element.hasAttribute("tabindex");
              if (
                visible &&
                (ownText ||
                  interactive ||
                  /^h[1-6]$/.test(tag) ||
                  tag === "img")
              ) {
                const ref = input.prefix + (refs.length + 1);
                refs.push(ref);
                store.set(ref, element);
                const attributes: string[] = [];
                for (const name of [
                  "type",
                  "placeholder",
                  "title",
                  "alt",
                  "name",
                ]) {
                  const value = text(element.getAttribute(name));
                  if (value)
                    attributes.push(`${name}=${JSON.stringify(value)}`);
                }
                if (control) {
                  const label = text(
                    Array.from(element.labels ?? [])
                      .map((label) => label.textContent)
                      .join(" "),
                  );
                  if (label) attributes.push(`label=${JSON.stringify(label)}`);
                  if (!(
                    element instanceof HTMLInputElement &&
                    element.type === "password"
                  ))
                    attributes.push(
                      `value=${JSON.stringify(text(element.value))}`,
                    );
                  if (element instanceof HTMLSelectElement)
                    attributes.push(
                      `options=${JSON.stringify(
                        Array.from(element.options)
                          .slice(0, 100)
                          .map((option) => ({
                            text: text(option.text),
                            value: text(option.value),
                            disabled: option.disabled,
                          })),
                      )}`,
                    );
                  if (element.disabled) attributes.push("disabled");
                  if (
                    element instanceof HTMLInputElement &&
                    ["checkbox", "radio"].includes(element.type)
                  )
                    attributes.push(`checked=${element.checked}`);
                }
                const coordinates = input.boxes
                  ? ` [box=${[box.x, box.y, box.width, box.height].map(Math.round).join(",")}]`
                  : "";
                const label = text(
                  ownText || (interactive ? element.textContent : ""),
                );
                lines.push(
                  `${"  ".repeat(Math.min(depth, 8))}- <${tag}${attributes.length ? " " + attributes.join(" ") : ""}> ${JSON.stringify(label)} [ref=${ref}]${coordinates}`,
                );
              }
              if (depth >= input.depth) {
                if (element.children.length || element.shadowRoot)
                  limited = true;
                return;
              }
              for (const child of Array.from(element.children))
                walk(child, depth + 1);
              if (element.shadowRoot)
                for (const child of Array.from(element.shadowRoot.children))
                  walk(child, depth + 1);
            };
            walk(body, 0);
            return { content: lines.join("\n"), refs, limited };
          },
          {
            key: registryKey,
            prefix,
            depth: options.depth ?? 40,
            boxes: options.includeBoxes ?? true,
          },
          { timeout: Math.max(1, deadline - Date.now()) },
        );
        for (const ref of captured.refs)
          references.set(ref, root.locator(`devproofdom=${ref}`));
        sections.push(
          `DOM viewport scope ${prefix.slice(0, -1)} (coordinates local to this frame):\n${captured.content}`,
        );
        limited ||= captured.limited;
      } catch (error) {
        if (target) throw error;
        limited = true;
        sections.push(
          "Frame DOM unavailable; use the current viewport screenshot.",
        );
      }
    }
    return {
      content: sections.join("\n\n"),
      captureLimited: limited,
      format: "dom",
    };
  }
}
