import { createHash } from "node:crypto";

/** Capture identities are not page changes; preserve all business text and values. */
export function normalizeObservationContent(content: string) {
  return content
    .replace(/[ \t]*\[ref=(?:f\d+)?e\d+\]/gu, "")
    .replace(/DOM viewport scope f\d+/gu, "DOM viewport scope");
}

export function observationContentKey(content: string, url?: string) {
  return createHash("sha256")
    .update(JSON.stringify([url ?? null, normalizeObservationContent(content)]))
    .digest("hex");
}
