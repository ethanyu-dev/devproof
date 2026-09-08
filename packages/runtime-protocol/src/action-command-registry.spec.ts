import { describe, expect, it } from "vitest";
import {
  getRuntimeActionCommandSchema,
  runtimeActionCommandInputSchema,
  runtimeCommandTypeSchema,
} from "./index.js";

const target = { ref: "f12e533" };
const fixtures: Array<[string, Record<string, unknown>]> = [
  ["page.open", { url: "https://example.com" }],
  ["page.navigate", { url: "https://example.com" }],
  ["page.back", {}],
  ["page.forward", {}],
  ["page.reload", {}],
  ["page.snapshot", { target, depth: "8" }],
  ["page.get_text", { target }],
  ["page.get_url", {}],
  ["page.get_title", {}],
  ["page.errors", {}],
  ["page.screenshot", {}],
  ["page.dom", {}],
  ["page.console", {}],
  ["page.network", { includeResponseBodies: true, urlIncludes: "/api" }],
  ["page.click", { target }],
  ["page.fill", { target, text: "测试" }],
  ["page.type", { target, text: "测试" }],
  ["page.press", { key: "Enter" }],
  ["page.check", { target }],
  ["page.uncheck", { target }],
  ["page.select", { target, values: ["test"] }],
  ["page.scroll", { deltaY: 120 }],
  ["page.hover", { target }],
  ["page.drag", { source: target, target: { ref: "e1" } }],
  ["page.resize", { width: "1280", height: "720" }],
  ["page.wait", { kind: "text", text: "已完成" }],
  ["tab.new", {}],
  ["tab.list", {}],
  ["tab.switch", { index: "0" }],
  ["tab.close", {}],
  ["frame.snapshot", { frame: { selector: "iframe" } }],
  ["frame.click", { frame: { selector: "iframe" }, target }],
  ["frame.fill", { frame: { selector: "iframe" }, target, text: "测试" }],
  ["element.state", { target }],
  ["locator.count", { target }],
  [
    "network.arm",
    { action: "PAUSE", policyId: "test", urlPattern: "**/api/**" },
  ],
  ["network.wait_for_hit", { policyId: "test" }],
  ["network.status", {}],
  ["network.release", { policyId: "test" }],
];

describe("command-specific action validation", () => {
  it("covers all action commands and excludes lifecycle operations", () => {
    const registered = runtimeCommandTypeSchema.options.filter(
      getRuntimeActionCommandSchema,
    );
    expect(fixtures.map(([name]) => name).sort()).toEqual(
      [...registered].sort(),
    );
    expect(registered).toHaveLength(39);
    for (const name of [
      "session.open",
      "session.close",
      "profile.purge",
      "profile.snapshot",
      "human.takeover",
      "human.release",
      "constructor",
      "__proto__",
      "page.content",
    ])
      expect(getRuntimeActionCommandSchema(name)).toBeUndefined();
  });

  it.each(fixtures)(
    "preserves %s payloads, defaults, and coercion",
    (commandType, payload) => {
      const command = { commandType, payload, timeoutSeconds: "30" };
      const schema = getRuntimeActionCommandSchema(commandType)!;
      expect(schema.parse(command)).toEqual(
        runtimeActionCommandInputSchema.parse(command),
      );
      for (const invalid of [
        { ...command, extra: true },
        { ...command, payload: { ...payload, extra: true } },
        { ...command, timeoutSeconds: 0 },
        { ...command, timeoutSeconds: 301 },
      ]) {
        expect(schema.safeParse(invalid).success).toBe(false);
        expect(runtimeActionCommandInputSchema.safeParse(invalid).success).toBe(
          false,
        );
      }
    },
  );

  it.each([
    { commandType: "page.navigate", payload: { url: "file:///private/data" } },
    {
      commandType: "page.navigate",
      payload: { url: "https://user:password@example.com" },
    },
    { commandType: "page.click", payload: { target: { ref: "f1" } } },
    { commandType: "page.network", payload: { includeResponseBodies: true } },
  ])("keeps semantic restrictions for $commandType", (command) => {
    expect(
      getRuntimeActionCommandSchema(command.commandType)!.safeParse(command)
        .success,
    ).toBe(false);
    expect(runtimeActionCommandInputSchema.safeParse(command).success).toBe(
      false,
    );
  });
});
