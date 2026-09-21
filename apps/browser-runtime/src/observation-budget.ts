import {
  STRUCTURED_OBSERVATION_MAX_BYTES,
  STRUCTURED_OBSERVATION_MAX_NODES,
  STRUCTURED_OBSERVATION_MAX_REGIONS,
  STRUCTURED_OBSERVATION_MAX_TEXT_CHARACTERS,
  type ObservationLimitEvent,
  type StructuredObservation,
} from "@devproof/runtime-protocol";

export function observationLimitEvent(
  observation: StructuredObservation,
  captureLimits: ObservationLimitEvent["exceeded"] = [],
): ObservationLimitEvent | undefined {
  const measured = {
    bytes: Buffer.byteLength(JSON.stringify(observation)),
    nodes: observation.nodes.length,
    regions: observation.regions.length,
    textCharacters: observation.renderedText.length,
  };
  const limits = {
    bytes: STRUCTURED_OBSERVATION_MAX_BYTES,
    nodes: STRUCTURED_OBSERVATION_MAX_NODES,
    regions: STRUCTURED_OBSERVATION_MAX_REGIONS,
    textCharacters: STRUCTURED_OBSERVATION_MAX_TEXT_CHARACTERS,
  };
  const exceeded = new Set(captureLimits);
  if (measured.bytes > limits.bytes) exceeded.add("BYTES");
  if (measured.nodes > limits.nodes) exceeded.add("NODES");
  if (measured.regions > limits.regions) exceeded.add("REGIONS");
  if (measured.textCharacters > limits.textCharacters) exceeded.add("TEXT");
  return exceeded.size
    ? {
        scope: observation.coverage.scope,
        measured,
        limits,
        exceeded: [...exceeded],
        action: "TRIMMED",
      }
    : undefined;
}

/** Keep a bounded, linked prefix for diagnostics; partial captures cannot prove absence. */
export function trimObservation(
  observation: StructuredObservation,
  event: ObservationLimitEvent,
) {
  observation.coverage.completeWithinScope = false;
  observation.coverage.truncated = true;
  observation.coverage.limitEvents = [
    ...(observation.coverage.limitEvents ?? []).slice(0, 1),
    event,
  ];
  const text = observation.renderedText.slice(
    0,
    STRUCTURED_OBSERVATION_MAX_TEXT_CHARACTERS,
  );
  const candidates = observation.nodes.slice(
    0,
    STRUCTURED_OBSERVATION_MAX_NODES,
  );
  const regions = observation.regions;
  const verified = observation.verifiedScopeNodeIds;
  const apply = (count: number) => {
    const nodes = candidates.slice(0, count);
    const ids = new Set(nodes.map((n) => n.nodeId));
    observation.nodes = nodes.map((n) => ({
      ...n,
      relations: n.relations.filter((r) => ids.has(r.targetNodeId)),
      ...(n.textLocation.end > text.length
        ? { textLocation: { start: 0, end: 0 } }
        : {}),
    }));
    if (verified)
      observation.verifiedScopeNodeIds = verified.filter((id) => ids.has(id));
    observation.regions = regions
      .filter((r) => ids.has(r.nodeId))
      .slice(0, STRUCTURED_OBSERVATION_MAX_REGIONS);
    observation.renderedText = text;
  };
  // Leave room for the outer capture's diagnostic when this is a scoped retry.
  let low = 0,
    high = candidates.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    apply(mid);
    if (
      Buffer.byteLength(JSON.stringify(observation)) <=
      STRUCTURED_OBSERVATION_MAX_BYTES - 4096
    )
      low = mid;
    else high = mid - 1;
  }
  apply(low);
  const byRef = new Map(
    observation.nodes.filter((n) => n.ref).map((n) => [n.ref!, n]),
  );
  const lines: string[] = [];
  let offset = 0;
  for (const node of observation.nodes)
    node.textLocation = { start: 0, end: 0 };
  for (const line of text.split("\n")) {
    const ref = line.match(/\[ref=([^\]]+)\]/u)?.[1];
    if (ref && !byRef.has(ref)) continue;
    if (ref)
      byRef.get(ref)!.textLocation = {
        start: offset,
        end: offset + line.length,
      };
    lines.push(line);
    offset += line.length + 1;
  }
  observation.renderedText = lines.join("\n");
}
