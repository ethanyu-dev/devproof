import {
  STRUCTURED_OBSERVATION_MAX_NODES,
  STRUCTURED_OBSERVATION_MAX_REGIONS,
  type ObservationLimitEvent,
  type ObservedNode,
  type StructuredObservation,
} from "@devproof/runtime-protocol";
import { randomUUID } from "node:crypto";
import { selectors, type Locator, type Page } from "playwright";
import {
  observationLimitEvent,
  trimObservation,
} from "./observation-budget.js";
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

  async markAction(page: Page, commandId: string, targetRef?: string) {
    for (const frame of page.frames())
      await frame
        .evaluate(
          ({ key, commandId, targetRef }) => {
            const global = globalThis as unknown as Record<string, any>;
            const state = global[key + "_structure"];
            if (!state) return;
            state.commandId = commandId;
            const target = global[key]?.get(targetRef ?? "");
            if (!target && targetRef)
              for (const region of state.regions.values())
                if (region.open) region.proven = false;
            if (target) {
              const contains = (root: Element, node: Element) => {
                let current: Element | null = node;
                while (current) {
                  if (current === root) return true;
                  current =
                    current.parentElement ??
                    (Node.prototype.getRootNode.call(current) as ShadowRoot)
                      .host ??
                    null;
                }
                return false;
              };
              const id = state.ids.get(target);
              if (id)
                for (const region of state.regions.values())
                  if (
                    region.open &&
                    (contains(region.element, target) ||
                      contains(target, region.element))
                  )
                    region.modified.add(id);
            }
          },
          { key: registryKey, commandId, targetRef },
        )
        .catch(() => undefined);
  }

  async invalidatePhases(page: Page) {
    for (const frame of page.frames())
      await frame
        .evaluate((key) => {
          const state = (globalThis as unknown as Record<string, any>)[
            key + "_structure"
          ];
          if (state) {
            state.initialized = false;
            for (const region of state.regions.values()) region.proven = false;
          }
        }, registryKey)
        .catch(() => undefined);
  }

  async verifyCapture(page: Page, observation: StructuredObservation) {
    observation.consistencyIssues = [];
    observation.verifiedScopeNodeIds = [];
    for (const frameInfo of observation.frames) {
      let found = false;
      for (const frame of page.frames()) {
        const result = await frame
          .evaluate(
            ({ key, frameInfo, nodes }) => {
              const state = (globalThis as unknown as Record<string, any>)[
                key + "_structure"
              ];
              if (state?.epoch !== frameInfo.documentEpoch) return null;
              state.recordMutations(state.observer.takeRecords());
              const revision = frameInfo.mutationRevision ?? -1;
              const mutations = state.mutations.filter(
                (m: any) => m.revision > revision,
              );
              const changed = state.mutationRevision !== revision;
              const lostHistory =
                changed &&
                (!mutations.length || mutations[0].revision > revision + 1);
              const contains = (parent: Node, child: Node) => {
                let current: Node | null = child;
                while (current) {
                  if (Node.prototype.contains.call(parent, current))
                    return true;
                  current =
                    (Node.prototype.getRootNode.call(current) as ShadowRoot)
                      .host ?? null;
                }
                return false;
              };
              const scopeNodes = nodes.filter(
                (n) =>
                  n.visible &&
                  (["form", "tr", "dialog"].includes(n.tag) ||
                    ["form", "row", "dialog", "alertdialog"].includes(
                      n.role ?? "",
                    )),
              );
              const element = (
                n: (typeof nodes)[number],
              ): Element | undefined => state.elements.get(n.nodeId);
              const checkNode = (n: (typeof nodes)[number]) => {
                const el = element(n);
                if (!el?.isConnected) return "NODE_DETACHED";
                const box = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                if (
                  n.visible &&
                  (box.width <= 0 ||
                    box.height <= 0 ||
                    style.display === "none" ||
                    style.visibility === "hidden")
                )
                  return "NODE_HIDDEN";
                if (
                  n.visible &&
                  n.box &&
                  ["x", "y", "width", "height"].some(
                    (k) => Math.abs(box[k as "x"] - n.box![k as "x"]) > 1,
                  )
                )
                  return "GEOMETRY_CHANGED";
                if (
                  n.enabled !== undefined &&
                  !(
                    el.matches(":disabled") ||
                    el.hasAttribute("disabled") ||
                    el.getAttribute("aria-disabled") === "true"
                  ) !== n.enabled
                )
                  return "ENABLED_CHANGED";
                if (
                  n.checked !== undefined &&
                  (["checkbox", "radio"].includes((el as HTMLInputElement).type)
                    ? (el as HTMLInputElement).checked
                    : (el.getAttribute("aria-checked") ??
                        el.getAttribute("aria-pressed")) === "true") !==
                    n.checked
                )
                  return "CHECKED_CHANGED";
                if (
                  n.value !== undefined &&
                  !n.truncatedProperties?.includes("VALUE") &&
                  (el as HTMLInputElement).value !== n.value
                )
                  return "VALUE_CHANGED";
                if (n.selectedLabel !== undefined) {
                  const label =
                    el.tagName.toLowerCase() === "select"
                      ? Array.from((el as HTMLSelectElement).selectedOptions)
                          .map((o) => o.text)
                          .join(" ")
                      : n.relations
                          .filter((r) => r.kind === "SELECTED_DISPLAY")
                          .map(
                            (r) =>
                              state.elements.get(r.targetNodeId)?.textContent ??
                              "",
                          )
                          .join(" ");
                  if (label.replace(/\s+/g, " ").trim() !== n.selectedLabel)
                    return "SELECTED_LABEL_CHANGED";
                }
                return null;
              };
              const issues: Array<{ code: string; nodeId?: string }> = [];
              if (changed) {
                for (const m of mutations.slice(0, 10)) {
                  const anchor = nodes.find(
                    (n) =>
                      element(n) === m.target ||
                      element(n) === m.target.parentElement,
                  );
                  issues.push({
                    code: "DOCUMENT_MUTATED",
                    ...(anchor ? { nodeId: anchor.nodeId } : {}),
                  });
                }
                if (lostHistory)
                  issues.push({ code: "MUTATION_HISTORY_UNAVAILABLE" });
              }
              const invalidNodes = new Set<string>();
              for (const n of nodes) {
                const code = checkNode(n);
                if (code) {
                  invalidNodes.add(n.nodeId);
                  if (issues.length < 20)
                    issues.push({ code, nodeId: n.nodeId });
                }
              }
              const byId = new Map(nodes.map((n) => [n.nodeId, n]));
              const withinCapture = (nodeId: string, scopeId: string) => {
                let id: string | undefined = nodeId;
                const seen = new Set<string>();
                while (id && !seen.has(id)) {
                  if (id === scopeId) return true;
                  seen.add(id);
                  id = byId.get(id)?.parentId;
                }
                return false;
              };
              const verified = scopeNodes
                .filter((scope) => {
                  const el = element(scope);
                  if (!el?.isConnected || lostHistory) return false;
                  if (
                    mutations.some((m: any) => {
                      const target = m.target as Node;
                      const parent =
                        target.nodeType === 1
                          ? (target as Element)
                          : target.parentElement;
                      return (
                        contains(el, target) ||
                        contains(target, el) ||
                        Boolean(
                          parent?.closest("style,head,link[rel=stylesheet]"),
                        )
                      );
                    })
                  )
                    return false;
                  return !nodes.some(
                    (n) =>
                      invalidNodes.has(n.nodeId) &&
                      (n.nodeId === scope.nodeId ||
                        (element(n) && contains(el, element(n)!)) ||
                        withinCapture(n.nodeId, scope.nodeId)),
                  );
                })
                .map((n) => n.nodeId);
              return { issues, verified };
            },
            {
              key: registryKey,
              frameInfo,
              nodes: observation.nodes.filter(
                (n) => n.frameId === frameInfo.frameId,
              ),
            },
          )
          .catch(() => ({
            issues: [{ code: "FRAME_UNAVAILABLE" }],
            verified: [] as string[],
          }));
        if (result !== null) {
          found = true;
          observation.verifiedScopeNodeIds.push(...result.verified);
          observation.consistencyIssues.push(
            ...result.issues.map((issue) => ({
              ...issue,
              frameId: frameInfo.frameId,
            })),
          );
          break;
        }
      }
      if (!found)
        observation.consistencyIssues.push({
          code: "DOCUMENT_REPLACED",
          frameId: frameInfo.frameId,
        });
    }
    observation.consistencyIssues = [
      ...new Map(
        observation.consistencyIssues.map(
          (issue) => [JSON.stringify(issue), issue] as const,
        ),
      ).values(),
    ].slice(0, 20);
    const limit = observationLimitEvent(observation);
    if (limit) trimObservation(observation, limit);
    return observation.consistencyIssues.length === 0;
  }

  private async activeRegion(page: Page): Promise<Locator | undefined> {
    for (const selector of [
      "dialog:visible,[role=dialog]:visible,[role=alertdialog]:visible",
      "form:visible,[role=form]:visible",
    ]) {
      const candidates: Locator[] = [];
      for (const frame of page.frames()) {
        const locator = frame.locator(selector);
        const count = await locator.count().catch(() => 0);
        for (let index = 0; index < Math.min(count, 2); index++)
          candidates.push(locator.nth(index));
      }
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) return undefined;
    }
    return undefined;
  }

  async snapshot(
    page: Page,
    target?: Locator,
    options: {
      depth?: number | undefined;
      includeBoxes?: boolean | undefined;
      timeout?: number | undefined;
    } = {},
  ): Promise<{
    structured: StructuredObservation;
    content: string;
    captureLimited: boolean;
    focusRef: string | undefined;
    format: string;
  }> {
    const structured: StructuredObservation = {
      version: 2,
      captureId: randomUUID(),
      capturedFrom: new Date().toISOString(),
      capturedUntil: new Date().toISOString(),
      pageIdentity: page.url(),
      frames: [],
      nodes: [],
      renderedText: "",
      regions: [],
      consistency: "DOM_ONLY",
      coverage: {
        scope: target ? "REGION" : "VIEWPORT",
        completeWithinScope: true,
        truncated: false,
        unavailableFrames: [],
      },
    };
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
    const captureLimits = new Set<ObservationLimitEvent["exceeded"][number]>();
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
            const globals = view as unknown as Record<string, any>;
            const state = (globals[input.key + "_structure"] ??= {
              epoch: input.epoch,
              ids: new WeakMap<Element, string>(),
              elements: new Map<string, Element>(),
              nextId: 0,
              regions: new Map<string, any>(),
              initialized: false,
              commandId: undefined,
            });
            if (!state.observer) {
              state.mutationRevision = 0;
              state.mutations = [];
              state.recordMutations = (records: MutationRecord[]) => {
                for (const record of records)
                  state.mutations.push({
                    revision: ++state.mutationRevision,
                    target: record.target,
                  });
                state.mutations = state.mutations.slice(-2000);
              };
              state.observer = new MutationObserver(state.recordMutations);
              state.observer.observe(view.document, {
                subtree: true,
                attributes: true,
                childList: true,
                characterData: true,
              });
            }
            state.recordMutations(state.observer.takeRecords());
            state.elements = new Map<string, Element>();
            const nodes: ObservedNode[] = [];
            const capturedNodes = new Map<Element, ObservedNode>();
            const nodeId = (el: Element) => {
              let id = state.ids.get(el);
              if (!id) {
                id = state.epoch + ":" + ++state.nextId;
                state.ids.set(el, id);
              }
              state.elements.set(id, el);
              return id as string;
            };
            const lines: string[] = [];
            let textOffset = 0;
            const refs: string[] = [];
            let visited = 0;
            let limited = false;
            const limitReasons = new Set<
              ObservationLimitEvent["exceeded"][number]
            >();
            let focusRef: string | undefined;
            const text = (value: string | null | undefined) =>
              (value ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
            const factText = (
              node: ObservedNode,
              value: string | null | undefined,
              property: "NAME" | "TEXT" | "VALUE" | "SELECTED_LABEL",
            ) => {
              const full =
                property === "VALUE"
                  ? (value ?? "")
                  : (value ?? "").replace(/\s+/g, " ").trim();
              if (full.length > 500)
                node.truncatedProperties = [
                  ...new Set([...(node.truncatedProperties ?? []), property]),
                ];
              return full.slice(0, 500);
            };
            type Clip = {
              top: number;
              right: number;
              bottom: number;
              left: number;
            };
            const walk = (
              element: Element,
              depth: number,
              clip: Clip,
              parentId?: string,
            ) => {
              if (
                ++visited > 40_000 ||
                refs.length >= input.maxNodes ||
                nodes.length >= input.maxNodes
              ) {
                limited = true;
                if (visited > 40_000) limitReasons.add("VISITS");
                if (refs.length >= input.maxNodes) limitReasons.add("REFS");
                if (nodes.length >= input.maxNodes) limitReasons.add("NODES");
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
              const fullOwnText = Array.from(element.childNodes)
                // React separates interpolated text with comments. Preserve the
                // actual characters, but do not join text across child elements.
                .map((node) =>
                  node.nodeType === 3
                    ? node.textContent
                    : node.nodeType === 8
                      ? ""
                      : " ",
                )
                .join("");
              const ownText = text(fullOwnText);
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
              const identity = nodeId(element);
              const rawRole = text(element.getAttribute("role"));
              const observed: ObservedNode = {
                nodeId: identity,
                ...(parentId ? { parentId } : {}),
                frameId: state.epoch,
                documentEpoch: state.epoch,
                tag,
                ...(rawRole ? { role: rawRole } : {}),
                text: ownText,
                visible,
                attributes: {},
                relations: [],
                textLocation: { start: 0, end: 0 },
                box: {
                  x: box.x,
                  y: box.y,
                  width: box.width,
                  height: box.height,
                },
              };
              observed.text = factText(observed, fullOwnText, "TEXT");
              for (const key of [
                "id",
                "aria-controls",
                "aria-owns",
                "type",
                "aria-checked",
                "aria-disabled",
                "aria-selected",
                "aria-expanded",
                "aria-busy",
                "aria-label",
                "title",
                "placeholder",
              ])
                if (element.hasAttribute(key)) {
                  const value = element.getAttribute(key)!;
                  // Ownership identifiers must be exact. A clipped id can
                  // accidentally associate a combobox with a different popup.
                  if (["id", "aria-controls", "aria-owns"].includes(key)) {
                    if (value.length <= 500) observed.attributes[key] = value;
                  } else observed.attributes[key] = text(value);
                }
              const checked =
                element.getAttribute("aria-checked") ??
                element.getAttribute("aria-pressed");
              if (checked === "true" || checked === "false")
                observed.checked = checked === "true";
              if (control) {
                if (!(tag === "input" && control.type === "password"))
                  observed.value = factText(observed, control.value, "VALUE");
                if (
                  tag === "input" &&
                  ["checkbox", "radio"].includes(control.type)
                )
                  observed.checked = (control as HTMLInputElement).checked;
                if (tag === "select") {
                  observed.selectedLabel = factText(
                    observed,
                    Array.from((control as HTMLSelectElement).selectedOptions)
                      .map((o) => o.text)
                      .join(" "),
                    "SELECTED_LABEL",
                  );
                  observed.selectedLabelSource = "NATIVE_SELECT";
                }
              }
              if (control || interactive || rawRole)
                observed.enabled = !(
                  element.matches(":disabled") ||
                  element.hasAttribute("disabled") ||
                  element.getAttribute("aria-disabled") === "true"
                );
              nodes.push(observed);
              capturedNodes.set(element, observed);
              if (
                visible &&
                (ownText ||
                  interactive ||
                  scrollY ||
                  scrollX ||
                  /^h[1-6]$/.test(tag) ||
                  ["tr", "form", "dialog"].includes(tag) ||
                  ["row", "form", "dialog", "alertdialog"].includes(rawRole) ||
                  tag === "img")
              ) {
                const ref = input.prefix + (refs.length + 1);
                observed.ref = ref;
                refs.push(ref);
                store.set(ref, element);
                if (element === focus) focusRef = ref;
                const attributes: string[] = [];
                // Explicit scope links survive deep, flattened DOM indentation.
                let ancestor = element.parentElement;
                while (ancestor) {
                  const parent = capturedNodes.get(ancestor);
                  if (
                    parent?.ref &&
                    (["tr", "form", "dialog"].includes(parent.tag) ||
                      ["row", "form", "dialog", "alertdialog"].includes(
                        parent.role ?? "",
                      ))
                  ) {
                    attributes.push(`scopeRef=${JSON.stringify(parent.ref)}`);
                    break;
                  }
                  ancestor = ancestor.parentElement;
                }
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
                  "role",
                  "aria-label",
                  "aria-checked",
                  "aria-pressed",
                  "aria-expanded",
                  "aria-selected",
                  "aria-disabled",
                ]) {
                  const value = text(element.getAttribute(name));
                  if (value)
                    attributes.push(`${name}=${JSON.stringify(value)}`);
                }
                if (
                  control &&
                  (style.opacity === "0" || style.pointerEvents === "none")
                )
                  attributes.push(`pointerHint="use visible control wrapper"`);
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
                observed.textLocation.start = textOffset;
                lines.push(
                  `${"  ".repeat(Math.min(depth, 8))}- <${tag}${attributes.length ? " " + attributes.join(" ") : ""}> ${JSON.stringify(label)} [ref=${ref}]${coordinates}`,
                );
                observed.textLocation.end =
                  textOffset + lines[lines.length - 1]!.length;
                textOffset = observed.textLocation.end + 1;
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
                walk(child, depth + 1, childClip, identity);
              if (element.shadowRoot)
                state.observer.observe(element.shadowRoot, {
                  subtree: true,
                  attributes: true,
                  childList: true,
                  characterData: true,
                });
              if (element.shadowRoot)
                for (const child of Array.from(element.shadowRoot.children))
                  walk(child, depth + 1, childClip, identity);
            };
            walk(body, 0, {
              top: 0,
              left: 0,
              right: view.innerWidth,
              bottom: view.innerHeight,
            });
            const byElement = new Map(
              nodes.map((n) => [state.elements.get(n.nodeId) as Element, n]),
            );
            const isControl = (el: Element) =>
              /^(input|textarea|select|button)$/.test(
                el.tagName.toLowerCase(),
              ) ||
              ["switch", "checkbox", "combobox"].includes(
                el.getAttribute("role") ?? "",
              );
            for (const node of nodes) {
              const element = state.elements.get(node.nodeId) as Element;
              const aria = (element.getAttribute("aria-label") ?? "").trim();
              const labelled = (element.getAttribute("aria-labelledby") ?? "")
                .split(/\s+/)
                .filter(Boolean)
                .flatMap((id) => {
                  const root = Node.prototype.getRootNode.call(element) as
                    Document | ShadowRoot;
                  const label = root.querySelector?.(
                    `[id="${CSS.escape(id)}"]`,
                  );
                  return label ? [label] : [];
                });
              const nativeLabels = Array.from(
                (element as HTMLInputElement).labels ?? [],
              );
              const forLabels = element.id
                ? Array.from(document.querySelectorAll("label")).filter(
                    (l) => l.htmlFor === element.id,
                  )
                : [];
              let labels = [
                ...new Set([...labelled, ...nativeLabels, ...forLabels]),
              ];
              if (!labels.length && isControl(element)) {
                let parent = element.parentElement;
                for (
                  let i = 0;
                  parent &&
                  i < 16 &&
                  !["BODY", "HTML"].includes(parent.tagName);
                  i++, parent = parent.parentElement
                ) {
                  const candidates = Array.from(
                    parent.querySelectorAll("label"),
                  );
                  const controls = Array.from(
                    parent.querySelectorAll(
                      "input,textarea,select,button,[role=switch],[role=combobox]",
                    ),
                  );
                  if (candidates.length === 1 && controls.length === 1) {
                    labels = candidates;
                    break;
                  }
                  if (controls.length > 1) break;
                  if (
                    parent.matches(
                      "form,dialog,[role=dialog],[role=alertdialog]",
                    )
                  )
                    break;
                }
              }
              for (const label of labels)
                if (byElement.has(label))
                  node.relations.push({
                    kind: "LABELLED_BY",
                    targetNodeId: byElement.get(label)!.nodeId,
                  });
              const labelText = (el: Element): string =>
                Array.from(el.childNodes)
                  .map((child) =>
                    child.nodeType === 3
                      ? (child.textContent ?? "")
                      : child.nodeType === 1 && !isControl(child as Element)
                        ? labelText(child as Element)
                        : "",
                  )
                  .join(" ");
              const label = labels.map(labelText).join(" ").trim();
              const ownName =
                aria ||
                label ||
                element.getAttribute("title") ||
                (isControl(element) ? element.textContent : node.text);
              if (ownName) {
                node.name = factText(node, ownName, "NAME");
                if (
                  !aria &&
                  !label &&
                  !element.hasAttribute("title") &&
                  node.truncatedProperties?.includes("TEXT")
                )
                  node.truncatedProperties = [
                    ...new Set([...node.truncatedProperties, "NAME" as const]),
                  ];
                node.nameSource = aria
                  ? "ARIA"
                  : label
                    ? "LABEL"
                    : element.hasAttribute("title")
                      ? "TITLE"
                      : "TEXT";
              }
              if (node.role === "combobox" && node.tag !== "select") {
                let parent = element.parentElement;
                for (
                  let i = 0;
                  parent && i < 4;
                  i++, parent = parent.parentElement
                ) {
                  if (
                    parent.querySelectorAll("[role=combobox],select").length !==
                    1
                  )
                    break;
                  const displays = Array.from(
                    parent.querySelectorAll("span,[aria-selected=true]"),
                  ).filter((el) => {
                    const n = byElement.get(el);
                    return (
                      n?.visible &&
                      Boolean(n.text) &&
                      (el.getAttribute("title") === n.text ||
                        el.getAttribute("aria-selected") === "true") &&
                      !el.contains(element) &&
                      !labels.some((l) => l.contains(el)) &&
                      !el.closest("[role=listbox],[role=option]") &&
                      !el.querySelector("span")
                    );
                  });
                  if (displays.length === 1) {
                    const display = byElement.get(displays[0]!)!;
                    node.selectedLabel = display.text;
                    if (display.truncatedProperties?.includes("TEXT"))
                      node.truncatedProperties = [
                        ...new Set([
                          ...(node.truncatedProperties ?? []),
                          "SELECTED_LABEL" as const,
                        ]),
                      ];
                    node.selectedLabelSource = "DISPLAY_RELATION";
                    node.relations.push({
                      kind: "SELECTED_DISPLAY",
                      targetNodeId: display.nodeId,
                    });
                    break;
                  }
                  if (displays.length > 1) break;
                }
              }
            }
            const regions: StructuredObservation["regions"] = [];
            // Rendered regions remain open outside the viewport. Scrolling or
            // clipping must not create a new opening epoch or erase edits.
            const renderedIds = new Set(nodes.map((n) => n.nodeId));
            // Replacing an edited scope between captures is not a confirmed
            // close/open cycle. Do not certify replacement containers as fresh.
            const replacesEditedScope = [...state.regions.entries()].some(
              ([id, region]: [string, any]) =>
                region.open &&
                region.modified.size > 0 &&
                !renderedIds.has(id) &&
                (region.element.matches(
                  "dialog,form,tr,body,[role=dialog],[role=alertdialog],[role=form],[role=row],[role=menu],[role=listbox]",
                ) ||
                  region.element.querySelector("h1,h2,h3,h4,h5,h6,label")),
            );
            for (const node of nodes.filter(
              (n) =>
                !["input", "textarea", "select", "span", "label"].includes(
                  n.tag,
                ),
            )) {
              const previous = state.regions.get(node.nodeId);
              const opened = !previous?.open;
              const region = opened
                ? {
                    epoch: node.nodeId + ":" + ((previous?.count ?? 0) + 1),
                    count: (previous?.count ?? 0) + 1,
                    proven:
                      state.initialized &&
                      Boolean(state.commandId) &&
                      !replacesEditedScope,
                    openedBy: state.commandId,
                    modified: new Set<string>(),
                    open: true,
                    element: state.elements.get(node.nodeId),
                  }
                : previous;
              region.open = true;
              state.regions.set(node.nodeId, region);
              // Only structural regions need phase records and actionable scope refs.
              if (
                node.visible &&
                ([
                  "dialog",
                  "alertdialog",
                  "form",
                  "row",
                  "menu",
                  "listbox",
                ].includes(node.role ?? "") ||
                  ["dialog", "form", "tr", "body"].includes(node.tag) ||
                  (state.elements.get(node.nodeId) as Element).querySelector(
                    "h1,h2,h3,h4,h5,h6,label",
                  ))
              ) {
                if (regions.length >= input.maxRegions) {
                  limited = true;
                  limitReasons.add("REGIONS");
                  continue;
                }
                if (!node.ref && refs.length < input.maxNodes) {
                  node.ref = input.prefix + (refs.length + 1);
                  refs.push(node.ref);
                  store.set(node.ref, state.elements.get(node.nodeId));
                  const line = `- <${node.tag}${node.role ? ` role=${JSON.stringify(node.role)}` : ""}> ${JSON.stringify(node.name ?? node.text ?? "")} [ref=${node.ref}]`;
                  node.textLocation = {
                    start: textOffset,
                    end: textOffset + line.length,
                  };
                  lines.push(line);
                  textOffset += line.length + 1;
                }
                regions.push({
                  nodeId: node.nodeId,
                  epoch: region.epoch,
                  phaseProven: region.proven,
                  reopened: region.count > 1,
                  modifiedNodeIds: [...region.modified].slice(
                    0,
                    1000,
                  ) as string[],
                  ...(region.openedBy
                    ? { openedByCommandId: region.openedBy }
                    : {}),
                });
              }
            }
            // An incomplete walk cannot prove that an omitted region closed.
            if (!input.scoped && !limited)
              for (const [id, region] of state.regions)
                if (!renderedIds.has(id)) region.open = false;
            if (state.regions.size > 4000)
              for (const [id, region] of state.regions)
                if (!region.open) state.regions.delete(id);
            // A partial read cannot revoke the history established by an earlier
            // complete capture. Explicit invalidation still clears this flag.
            state.initialized ||= !limited && !input.scoped;
            return {
              content: lines.join("\n"),
              refs,
              limited,
              limitReasons: [...limitReasons],
              focusRef,
              nodes,
              regions,
              epoch: state.epoch as string,
              mutationRevision: state.mutationRevision as number,
              commandId: state.commandId as string | undefined,
            };
          },
          {
            key: registryKey,
            epoch: randomUUID(),
            scoped: Boolean(target),
            prefix,
            depth: options.depth ?? 40,
            boxes: options.includeBoxes ?? true,
            scrollOverflows: SCROLL_OVERFLOWS,
            focusRef: previousFocus,
            maxNodes: STRUCTURED_OBSERVATION_MAX_NODES,
            maxRegions: STRUCTURED_OBSERVATION_MAX_REGIONS,
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
        const sectionHeader = `DOM viewport scope ${prefix.slice(0, -1)} (coordinates local to this frame):\n`;
        const offset =
          sections.join("\n\n").length +
          (sections.length ? 2 : 0) +
          sectionHeader.length;
        for (const node of captured.nodes)
          if (node.textLocation.end > node.textLocation.start) {
            node.textLocation.start += offset;
            node.textLocation.end += offset;
          }
        structured.frames.push({
          frameId: captured.epoch,
          documentEpoch: captured.epoch,
          mutationRevision: captured.mutationRevision,
        });
        structured.nodes.push(...captured.nodes);
        structured.regions.push(...captured.regions);
        if (captured.commandId) structured.sourceCommandId = captured.commandId;
        sections.push(
          `DOM viewport scope ${prefix.slice(0, -1)} (coordinates local to this frame):\n${captured.content}`,
        );
        limited ||= captured.limited;
        for (const reason of captured.limitReasons) captureLimits.add(reason);
        focusRef ??= captured.focusRef;
      } catch (error) {
        if (target) throw error;
        structured.coverage.unavailableFrames.push(prefix);
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
    structured.capturedUntil = new Date().toISOString();
    structured.renderedText = sections.join("\n\n");
    structured.coverage.completeWithinScope = !limited;
    structured.coverage.truncated = limited;
    const event = observationLimitEvent(structured, [...captureLimits]);
    if (event) {
      // One retry only, using a fresh capture of a unique active dialog or form.
      // Never replay the action that caused the oversized observation.
      if (!target && Date.now() < deadline) {
        const active = await this.activeRegion(page);
        if (active && Date.now() < deadline) {
          const scoped = await this.snapshot(page, active, {
            ...options,
            timeout: deadline - Date.now(),
          });
          scoped.structured.coverage.limitEvents = [
            { ...event, action: "SCOPED_RECAPTURE" },
            ...(scoped.structured.coverage.limitEvents ?? []),
          ];
          const combinedLimit = observationLimitEvent(scoped.structured);
          if (combinedLimit) {
            trimObservation(scoped.structured, combinedLimit);
            scoped.captureLimited = true;
            scoped.content =
              "DOM coverage: incomplete region; narrow the snapshot target before verifying.\n\n" +
              scoped.structured.renderedText;
          }
          return scoped;
        }
      }
      trimObservation(structured, event);
      limited = true;
    }
    return {
      structured,
      content:
        "DOM coverage: current viewport and unclipped content only. Scroll containers with atEnd=false have unseen content; absence here does not prove absence from the page or dropdown.\n\n" +
        (event ? structured.renderedText : sections.join("\n\n")),
      captureLimited: limited,
      focusRef,
      format: "dom",
    };
  }
}
