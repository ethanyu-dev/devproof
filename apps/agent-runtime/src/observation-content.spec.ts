import { expect, it } from "vitest";
import {
  normalizeObservationContent,
  observationContentKey,
} from "./observation-content.js";

it("ignores capture-scoped dialog references but preserves business text and values", () => {
  const content = (n: number, text = "GPU Instance") =>
    `DOM viewport scope f${n}\n- <span scopeRef="f${n}e198" title="${text}"> "${text}" [ref=f${n}e229]`;
  expect(observationContentKey(content(8))).toBe(
    observationContentKey(content(10)),
  );
  expect(observationContentKey(content(8))).not.toBe(
    observationContentKey(content(10, "Model API")),
  );
  const literal = "- <span> 'scopeRef=\"f8e198\"' [ref=f8e1]";
  expect(normalizeObservationContent(literal)).toContain('scopeRef="f8e198"');
});
