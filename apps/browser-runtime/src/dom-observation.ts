import { randomUUID } from "node:crypto";
import { selectors, type Locator, type Page } from "playwright";
import { SCROLL_OVERFLOWS } from "./scroll.js";

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
        const node = globalThis[${JSON.stringify(registryKey)}]?.get(ref);
        if (!node?.isConnected) return null;
        let ancestor = node;
        while (ancestor) {
          if (ancestor === root || Node.prototype.contains.call(root, ancestor)) return node;
          ancestor = Node.prototype.getRootNode.call(ancestor)?.host;
        }
        return null;
      },
      queryAll(root, ref) { const node = this.query(root, ref); return node ? [node] : []; }
    })`,
    { contentScript: false },
  ));
}

// Register before any page creates Playwright's injected selector context.
await register();

export class DomObservations {
  private readonly references = new WeakMap<Page, Map<string, Locator>>();
  private readonly pendingFocus = new WeakMap<Page, string>();

  focus(page: Page, ref: string) {
    this.pendingFocus.set(page, ref);
  }

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
    const previousFocus = this.pendingFocus.get(page);
    this.pendingFocus.delete(page);
    await register();
    const references = new Map<string, Locator>();
    this.references.set(page, references);
    const roots = target
      ? [{ root: target, frame: undefined }]
      : // Microfrontends can put another <body> in an open shadow root. A
        // piercing "body" selector then fails strict resolution for the frame.
        page
          .frames()
          .map((frame) => ({ root: frame.locator(":root > body"), frame }));
    const sections: string[] = [];
    let limited = false;
    let focusRef: string | undefined;
    for (const { root, frame: knownFrame } of roots) {
      if (Date.now() >= deadline) {
        limited = true;
        break;
      }
      const prefix = `f${++nextScope}e`;
      let handle: Awaited<ReturnType<Locator["elementHandle"]>> | null = null;
      try {
        // Resolve the target before replacing its ref registry. New locators must
        // start at its frame, never at a root locator containing an expired ref.
        handle = await root.elementHandle({
          timeout: Math.max(1, deadline - Date.now()),
        });
        if (!handle)
          throw new Error("Snapshot target is no longer attached to a frame.");
        const captured = await handle.evaluate(
          (body, input) => {
            // Use the evaluating frame's realm. Microfrontends can override a
            // connected node's ownerDocument/getRootNode with a sandbox document.
            const view = globalThis;
            const focus = (
              view as unknown as Record<string, Map<string, Element>>
            )[input.key]?.get(input.focusRef ?? "");
            const store = new Map<string, Element>();
            (view as unknown as Record<string, unknown>)[input.key] = store;
            const lines: string[] = [];
            const refs: string[] = [];
            let visited = 0;
            let limited = false;
            let focusRef: string | undefined;
            const text = (value: string | null | undefined) =>
              (value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
            type Clip = {
              top: number;
              right: number;
              bottom: number;
              left: number;
            };
            const walk = (element: Element, depth: number, clip: Clip) => {
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
                Math.min(box.bottom, clip.bottom) >
                  Math.max(box.top, clip.top) &&
                Math.min(box.right, clip.right) > Math.max(box.left, clip.left);
              const scrollY =
                input.scrollOverflows.includes(style.overflowY) &&
                element.clientHeight > 0 &&
                element.scrollHeight > element.clientHeight + 1;
              const scrollX =
                input.scrollOverflows.includes(style.overflowX) &&
                element.clientWidth > 0 &&
                element.scrollWidth > element.clientWidth + 1;
              const ownText = text(
                Array.from(element.childNodes)
                  .filter((node) => node.nodeType === 3)
                  .map((node) => node.textContent)
                  .join(" "),
              );
              const tag = element.tagName.toLowerCase();
              // Adopted microfrontend controls may retain another realm's prototype.
              const control =
                element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
                ["input", "textarea", "select"].includes(tag)
                  ? (element as
                      | HTMLInputElement
                      | HTMLTextAreaElement
                      | HTMLSelectElement)
                  : undefined;
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
                  scrollY ||
                  scrollX ||
                  /^h[1-6]$/.test(tag) ||
                  tag === "img")
              ) {
                const ref = input.prefix + (refs.length + 1);
                refs.push(ref);
                store.set(ref, element);
                if (element === focus) focusRef = ref;
                const attributes: string[] = [];
                for (const axis of ["Y", "X"] as const) {
                  if (!(axis === "Y" ? scrollY : scrollX)) continue;
                  const position =
                    axis === "Y" ? element.scrollTop : element.scrollLeft;
                  const maximum =
                    axis === "Y"
                      ? element.scrollHeight - element.clientHeight
                      : element.scrollWidth - element.clientWidth;
                  attributes.push(
                    `scroll${axis}=${Math.round(position)}/${maximum} atStart=${position <= 1} atEnd=${position >= maximum - 1}`,
                  );
                }
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
                    Array.from(control.labels ?? [])
                      .map((label) => label.textContent)
                      .join(" "),
                  );
                  if (label) attributes.push(`label=${JSON.stringify(label)}`);
                  if (!(tag === "input" && control.type === "password"))
                    attributes.push(
                      `value=${JSON.stringify(text(control.value))}`,
                    );
                  if (tag === "select") {
                    const select = control as HTMLSelectElement;
                    attributes.push(
                      `options=${JSON.stringify(
                        Array.from(select.options)
                          .slice(0, 100)
                          .map((option) => ({
                            text: text(option.text),
                            value: text(option.value),
                            disabled: option.disabled,
                          })),
                      )}`,
                    );
                    if (select.options.length > 100) {
                      attributes.push("optionsTruncated=true");
                      limited = true;
                    }
                  }
                  if (control.disabled) attributes.push("disabled");
                  if (
                    tag !== "select" &&
                    (control as HTMLInputElement).readOnly
                  )
                    attributes.push("readonly");
                  if (
                    tag === "input" &&
                    ["checkbox", "radio"].includes(control.type)
                  )
                    attributes.push(
                      `checked=${(control as HTMLInputElement).checked}`,
                    );
                }
                const coordinates = input.boxes
                  ? ` [box=${[box.x, box.y, box.width, box.height].map(Math.round).join(",")}]`
                  : "";
                const label = text(
                  ownText ||
                    (interactive && !scrollY && !scrollX
                      ? element.textContent
                      : ""),
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
              const childClip = { ...clip };
              if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                childClip.top = Math.max(clip.top, box.top + element.clientTop);
                childClip.bottom = Math.min(
                  clip.bottom,
                  box.top + element.clientTop + element.clientHeight,
                );
              }
              if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                childClip.left = Math.max(
                  clip.left,
                  box.left + element.clientLeft,
                );
                childClip.right = Math.min(
                  clip.right,
                  box.left + element.clientLeft + element.clientWidth,
                );
              }
              for (const child of Array.from(element.children))
                walk(child, depth + 1, childClip);
              if (element.shadowRoot)
                for (const child of Array.from(element.shadowRoot.children))
                  walk(child, depth + 1, childClip);
            };
            walk(body, 0, {
              top: 0,
              left: 0,
              right: view.innerWidth,
              bottom: view.innerHeight,
            });
            return { content: lines.join("\n"), refs, limited, focusRef };
          },
          {
            key: registryKey,
            prefix,
            depth: options.depth ?? 40,
            boxes: options.includeBoxes ?? true,
            scrollOverflows: SCROLL_OVERFLOWS,
            focusRef: previousFocus,
          },
        );
        if (captured.refs.length) {
          // ownerFrame can follow a microfrontend's overridden ownerDocument.
          // Find the actual realm whose registry contains this unique new ref.
          let frame = knownFrame;
          if (!frame) {
            const frames = page.frames();
            const owners = await Promise.all(
              frames.map((frame) =>
                frame
                  .evaluate(
                    ({ key, ref }) =>
                      (
                        globalThis as unknown as Record<
                          string,
                          Map<string, Element>
                        >
                      )[key]?.has(ref) ?? false,
                    { key: registryKey, ref: captured.refs[0]! },
                  )
                  .catch(() => false),
              ),
            );
            frame = frames[owners.indexOf(true)];
          }
          if (!frame) throw new Error("Snapshot frame is no longer available.");
          for (const ref of captured.refs)
            references.set(ref, frame.locator(`devproofdom=${ref}`));
        }
        sections.push(
          `DOM viewport scope ${prefix.slice(0, -1)} (coordinates local to this frame):\n${captured.content}`,
        );
        limited ||= captured.limited;
        focusRef ??= captured.focusRef;
      } catch (error) {
        if (target) throw error;
        limited = true;
        sections.push(
          `Frame DOM unavailable; use the current viewport screenshot. ${String(
            error instanceof Error ? error.message : error,
          )
            .split("\n")[0]!
            .slice(0, 240)}`,
        );
      } finally {
        await handle?.dispose().catch(() => undefined);
      }
    }
    return {
      content:
        "DOM coverage: current viewport and unclipped content only. Scroll containers with atEnd=false have unseen content; absence here does not prove absence from the page or dropdown.\n\n" +
        sections.join("\n\n"),
      captureLimited: limited,
      focusRef,
      format: "dom",
    };
  }
}
