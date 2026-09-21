import { expect, it } from "vitest";
import { observedValueMatches } from "./observed-value.js";

it("only normalizes declared UI display differences, preserving values and JSON", () => {
  for (const [actual, expected] of [
    ["周 一", "周一"],
    ["全 选", "全选"],
    ["周 末", "周末"],
    ["周一, 周五 09:00 – 18:00", "周一, 周五 09:00–18:00"],
  ]) {
    expect(observedValueMatches(actual!, expected!)).toBe(false);
    expect(observedValueMatches(actual!, expected!, "DISPLAY_TEXT")).toBe(true);
  }
  for (const [actual, expected] of [
    ["周六", "周日"],
    ["09:00–19:00", "09:00–18:00"],
    ["sku a", "skua"],
    ['{"value":"周 一"}', '{"value":"周一"}'],
    [
      "第 1 个与第 2 个时段存在重叠。",
      "第 {{a}} 个与第 {{b}} 个时段存在重叠。",
    ],
  ])
    expect(observedValueMatches(actual!, expected!, "DISPLAY_TEXT")).toBe(
      false,
    );
});
