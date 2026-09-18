import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type {
  ObservedNode,
  StructuredObservation,
} from "@devproof/runtime-protocol";
import { focusedObservation } from "./observation-view.js";

function fixture(ref: string, epoch = "open-1"): StructuredObservation {
  const text = `dialog New\n[${ref}] button Save\n${"Background table records. ".repeat(100)}`;
  const node = (
    nodeId: string,
    extra: Partial<ObservedNode>,
  ): ObservedNode => ({
    nodeId,
    frameId: "frame",
    documentEpoch: "doc",
    tag: "div",
    visible: true,
    attributes: {},
    relations: [],
    textLocation: { start: 0, end: 0 },
    ...extra,
  });
  return {
    version: 2,
    captureId: randomUUID(),
    capturedFrom: new Date().toISOString(),
    capturedUntil: new Date().toISOString(),
    pageIdentity: "fixture",
    frames: [{ frameId: "frame", documentEpoch: "doc" }],
    nodes: [
      node("dialog", {
        tag: "dialog",
        ref: "d",
        textLocation: { start: 0, end: 10 },
      }),
      node("save", {
        tag: "button",
        ref,
        parentId: "dialog",
        enabled: true,
        textLocation: { start: 11, end: text.indexOf("\n", 11) },
      }),
    ],
    renderedText: text,
    regions: [
      {
        nodeId: "dialog",
        epoch,
        phaseProven: true,
        reopened: false,
        modifiedNodeIds: [],
      },
    ],
    consistency: "VERIFIED",
    coverage: {
      scope: "VIEWPORT",
      completeWithinScope: true,
      truncated: false,
      unavailableFrames: [],
    },
  };
}
it("uses current refs in delta and resets the baseline when the dialog reopens", () => {
  const first = focusedObservation(fixture("old"))!;
  expect(first.mode).toBe("REGION");
  const next = focusedObservation(fixture("fresh"), first)!;
  expect(next.mode).toBe("DELTA");
  expect(next.content).toContain("[fresh]");
  expect(next.content).not.toContain("[old]");
  expect(focusedObservation(fixture("reopened", "open-2"), next)?.mode).toBe(
    "REGION",
  );
});
it("falls back to full observation for truncation or ambiguous dialogs", () => {
  const input = fixture("fresh");
  input.coverage.truncated = true;
  expect(focusedObservation(input)).toBeUndefined();
  input.coverage.truncated = false;
  input.nodes.push({ ...input.nodes[0]!, nodeId: "other" });
  expect(focusedObservation(input)).toBeUndefined();
});

function dropdownFixture(inDialog = false) {
  const input = fixture("save");
  const template = input.nodes[0]!;
  const node = (nodeId: string, extra: Partial<ObservedNode>) => ({
    ...template,
    nodeId,
    tag: "div",
    ref: nodeId,
    ...extra,
  });
  input.nodes = [
    ...(inDialog ? input.nodes : []),
    node("search", {
      tag: "input",
      role: "combobox",
      name: "Type",
      value: "query",
      ...(inDialog ? { parentId: "dialog" } : {}),
      attributes: { "aria-expanded": "true", "aria-controls": "choices" },
    }),
    node("popup", {}),
    node("aria-list", {
      parentId: "popup",
      role: "listbox",
      visible: false,
      attributes: { id: "choices" },
    }),
    node("option", {
      parentId: "popup",
      text: "Observed option",
      attributes: { "aria-selected": "false" },
    }),
    node("background", { text: "Background records ".repeat(150) }),
  ];
  let offset = 0;
  input.renderedText = input.nodes
    .map((n) => {
      const line = `- ${n.role ?? n.tag} ${n.text ?? n.name ?? ""} [ref=${n.ref}]`;
      n.textLocation = { start: offset, end: offset + line.length };
      offset += line.length + 1;
      return line;
    })
    .join("\n");
  return input;
}

it.each([false, true])(
  "includes the owned virtualized popup, including portalled dialog options (%s)",
  (inDialog) => {
    const input = dropdownFixture(inDialog);
    const focused = focusedObservation(input)!;
    expect(focused.content).toContain("Observed option");
    expect(focused.content).toContain("[ref=search]");
    expect(focused.content).not.toContain("Background records");
    if (inDialog) expect(focused.content).toContain("[ref=save]");
    const next = structuredClone(input);
    next.captureId = randomUUID();
    next.nodes.find((n) => n.nodeId === "option")!.ref = "fresh-option";
    next.renderedText = next.renderedText.replace(
      "ref=option",
      "ref=fresh-option",
    );
    const option = next.nodes.find((n) => n.nodeId === "option")!;
    option.textLocation.end += "fresh-".length;
    const delta = focusedObservation(next, focused)!;
    expect(delta.mode).toBe("DELTA");
    expect(delta.content).toContain("[ref=fresh-option]");
    expect(delta.content).not.toContain("[ref=option]");
  },
);

it.each([
  "missing owner",
  "duplicate id",
  "other frame",
  "ambiguous owner",
  "incomplete",
  "unavailable frame",
])("keeps the full page when popup ownership is unsafe: %s", (reason) => {
  const input = dropdownFixture(true);
  const owner = input.nodes.find((n) => n.nodeId === "search")!;
  const list = input.nodes.find((n) => n.nodeId === "aria-list")!;
  if (reason === "missing owner") delete owner.attributes["aria-controls"];
  if (reason === "duplicate id")
    input.nodes.push({ ...list, nodeId: "duplicate" });
  if (reason === "other frame") list.frameId = "foreign";
  if (reason === "ambiguous owner")
    input.nodes.push({ ...owner, nodeId: "second" });
  if (reason === "incomplete") input.coverage.completeWithinScope = false;
  if (reason === "unavailable frame")
    input.coverage.unavailableFrames = ["foreign"];
  expect(focusedObservation(input)).toBeUndefined();
});
