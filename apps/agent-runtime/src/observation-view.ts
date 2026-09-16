import type {
  StructuredObservation,
  ObservedNode,
} from "@devproof/runtime-protocol";

export interface ObservationView {
  captureId: string;
  scopeIdentity: string;
  content: string;
  nodes: ObservedNode[];
  mode: "REGION" | "DELTA";
  baselineCaptureId?: string;
}

/** Derived views never change canonical evidence or reuse a baseline's action refs. */
export function focusedObservation(
  observation: StructuredObservation,
  baseline?: ObservationView,
): ObservationView | undefined {
  if (
    observation.coverage.truncated ||
    !observation.coverage.completeWithinScope ||
    observation.coverage.unavailableFrames.length
  )
    return;
  const byId = new Map(observation.nodes.map((n) => [n.nodeId, n]));
  const dialogs = observation.nodes.filter(
    (n) =>
      n.visible &&
      (["dialog", "alertdialog"].includes(n.role ?? "") || n.tag === "dialog"),
  );
  if (dialogs.length > 1) return;
  const within = (node: ObservedNode, root: ObservedNode) => {
    if (
      node.frameId !== root.frameId ||
      node.documentEpoch !== root.documentEpoch
    )
      return false;
    const seen = new Set<string>();
    let current: ObservedNode | undefined = node;
    while (current && !seen.has(current.nodeId)) {
      if (current.nodeId === root.nodeId) return true;
      seen.add(current.nodeId);
      current = byId.get(current.parentId ?? "");
    }
    return false;
  };
  const expanded = observation.nodes.filter(
    (n) =>
      n.visible &&
      n.role === "combobox" &&
      n.attributes["aria-expanded"] === "true",
  );
  if (expanded.length > 1) return;
  const owner = expanded[0];
  const roots = [...dialogs];
  if (owner) {
    // The popup may be portalled outside the dialog. Only follow explicit DOM
    // ownership in the same frame/document; nearby matching text is not enough.
    const ids = [
      ...new Set(
        `${owner.attributes["aria-controls"] ?? ""} ${owner.attributes["aria-owns"] ?? ""}`
          .trim()
          .split(/\s+/u)
          .filter(Boolean),
      ),
    ];
    if (!ids.length || ids.length > 4) return;
    for (const id of ids) {
      const matches = observation.nodes.filter(
        (n) =>
          n.attributes.id === id &&
          n.frameId === owner.frameId &&
          n.documentEpoch === owner.documentEpoch,
      );
      if (matches.length !== 1) return;
      let root: ObservedNode | undefined = matches[0]!;
      let popup: ObservedNode | undefined;
      // Virtualized selects can control an invisible ARIA list beside the
      // rendered options. Find the smallest bounded container owning both.
      for (
        let depth = 0;
        root && depth < 4;
        depth++, root = byId.get(root.parentId ?? "")
      ) {
        if (
          ["html", "body", "form", "dialog"].includes(root.tag) ||
          ["dialog", "form"].includes(root.role ?? "")
        )
          break;
        const children = observation.nodes.filter((n) => within(n, root!));
        if (
          children.some((n) => n.role === "combobox") ||
          children.filter((n) => ["listbox", "menu"].includes(n.role ?? ""))
            .length > 1
        )
          break;
        if (
          children.some(
            (n) =>
              n.visible &&
              n.ref &&
              ([
                "option",
                "menuitem",
                "menuitemcheckbox",
                "menuitemradio",
              ].includes(n.role ?? "") ||
                "aria-selected" in n.attributes),
          )
        ) {
          popup = root;
          break;
        }
      }
      if (!popup) return;
      roots.push(popup);
    }
  }
  if (!roots.length) return;
  const nodes = observation.nodes.filter(
    (n) =>
      n.visible &&
      (n === owner ||
        roots.some((root) => within(n, root)) ||
        owner?.relations.some(
          (r) => r.kind === "LABELLED_BY" && r.targetNodeId === n.nodeId,
        )),
  );
  const scopeIdentity = [
    owner?.nodeId ?? "",
    ...roots.map(
      (root) =>
        `${root.nodeId}:${observation.regions.find((r) => r.nodeId === root.nodeId)?.epoch ?? root.documentEpoch}`,
    ),
  ].join("|");
  const previous =
    baseline?.scopeIdentity === scopeIdentity
      ? new Map(baseline.nodes.map((n) => [n.nodeId, n]))
      : undefined;
  const semantic = (n: ObservedNode) =>
    JSON.stringify([
      n.parentId,
      n.tag,
      n.role,
      n.name,
      n.text,
      n.value,
      n.selectedLabel,
      n.checked,
      n.enabled,
      n.visible,
    ]);
  const interactive = (n: ObservedNode) =>
    n.enabled !== undefined ||
    ["a", "button", "input", "select", "textarea"].includes(n.tag) ||
    ["combobox", "switch", "checkbox", "option"].includes(n.role ?? "") ||
    "aria-selected" in n.attributes;
  const retained = previous
    ? nodes.filter(
        (n) =>
          roots.some((root) => n.nodeId === root.nodeId) ||
          interactive(n) ||
          !previous.has(n.nodeId) ||
          semantic(n) !== semantic(previous.get(n.nodeId)!),
      )
    : nodes;
  const lines = retained
    .filter((n) => n.ref && n.textLocation.end > n.textLocation.start)
    .map((n) =>
      observation.renderedText.slice(n.textLocation.start, n.textLocation.end),
    );
  if (!lines.length) return;
  const removed = previous
    ? [...previous.keys()].filter((id) => !nodes.some((n) => n.nodeId === id))
    : [];
  const content = `Observation scope: ${owner ? "expanded combobox and its owned popup" : "active dialog"}${owner && dialogs.length ? ", including the active dialog" : ""}; background and offscreen content omitted. Full observation remains available via read_observation.\n${previous ? `Delta from ${baseline!.captureId}; unchanged descriptive text omitted. Only refs printed below are current. Removed nodes: ${removed.join(", ") || "none"}.\n` : ""}${lines.join("\n")}`;
  if (Buffer.byteLength(content) >= Buffer.byteLength(observation.renderedText))
    return;
  return {
    captureId: observation.captureId,
    scopeIdentity,
    content,
    nodes,
    mode: previous ? "DELTA" : "REGION",
    ...(previous ? { baselineCaptureId: baseline!.captureId } : {}),
  };
}
