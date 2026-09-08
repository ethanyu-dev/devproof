import {
  getRuntimeActionCommandSchema,
  runtimeActionCommandInputSchema,
  runtimeCommandTypeSchema,
} from "@devproof/runtime-protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BrowserToolCatalog,
  browserToolGroupNames,
  browserToolGroups,
  coreBrowserCommands,
  enableBrowserToolsInputSchema,
} from "./browser-tool-catalog.js";
import { openAiFunctionSchema } from "./model-tool-schema.js";

interface CommandSchema {
  properties: Record<string, unknown> & { commandType: { const: string } };
  [key: string]: unknown;
}
const variants = (catalog: BrowserToolCatalog) =>
  (catalog.parameters() as { anyOf: CommandSchema[] }).anyOf;

describe("browser tool catalog", () => {
  it("covers every canonical action exactly once, with page.open as the only omitted alias", () => {
    const canonical = runtimeCommandTypeSchema.options.filter((name) =>
      getRuntimeActionCommandSchema(name),
    );
    const names = [
      ...coreBrowserCommands,
      ...browserToolGroupNames.flatMap(
        (group) => browserToolGroups[group].commands,
      ),
      "page.open",
    ];
    expect(canonical).toHaveLength(39);
    expect(coreBrowserCommands).toHaveLength(15);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...canonical].sort());
    const catalog = new BrowserToolCatalog([]);
    expect(
      variants(catalog).map((schema) => schema.properties.commandType.const),
    ).toEqual(coreBrowserCommands);
    catalog.enable(browserToolGroupNames);
    expect(variants(catalog)).toHaveLength(38);
  });

  it("emits the same canonical payload constraints for every selected command", () => {
    const catalog = new BrowserToolCatalog([]);
    catalog.enable(browserToolGroupNames);
    for (const variant of variants(catalog)) {
      const commandName = variant.properties.commandType.const;
      const expected = openAiFunctionSchema(
        getRuntimeActionCommandSchema(commandName)!,
      ) as Record<string, unknown>;
      delete expected.$schema;
      const emitted = structuredClone(variant);
      expect(emitted.properties.locatorRecoveryToken).toEqual({
        type: "string",
        minLength: 1,
        maxLength: 240,
      });
      delete emitted.properties.locatorRecoveryToken;
      expect(emitted).toEqual(expected);
    }
    expect(JSON.stringify(catalog.parameters())).not.toContain('"format":');
    expect(JSON.stringify(catalog.parameters())).not.toContain('"$ref":');
    expect(JSON.stringify(catalog.parameters())).not.toContain('"$defs":');
  });

  it("describes every optional group without putting its schema in the enable result", () => {
    const catalog = new BrowserToolCatalog([]);
    const description = catalog.discoveryTools()[0]!.description;
    for (const [group, definition] of Object.entries(browserToolGroups)) {
      expect(description).toContain(group);
      for (const command of definition.commands)
        expect(description).toContain(command);
    }
    const initialSchema = catalog.parameters();
    expect(catalog.enable(["frames", "tabs", "frames"])).toEqual({
      enabledGroups: ["tabs", "frames"],
    });
    expect(initialSchema).not.toBe(catalog.parameters());
    expect(variants(catalog)).toHaveLength(22);
    const enabledSchema = catalog.parameters();
    expect(catalog.enable(["frames", "tabs"])).toEqual({
      enabledGroups: ["tabs", "frames"],
    });
    expect(catalog.parameters()).toBe(enabledSchema);
  });

  it.each(["NETWORK", "CONSOLE"])(
    "pre-enables diagnostics for explicit %s evidence requirements",
    (kind) => {
      const catalog = new BrowserToolCatalog([
        { requiredEvidenceKinds: [kind] },
      ]);
      expect(catalog.activeGroups()).toEqual(["diagnostics"]);
      expect(catalog.commandNames()).toContain("page.network");
      expect(catalog.commandNames()).not.toContain("network.arm");
      expect(
        new BrowserToolCatalog([
          { requiredEvidenceKinds: ["SCREENSHOT"] },
        ]).activeGroups(),
      ).toEqual([]);
    },
  );

  it.each(browserToolGroupNames)(
    "gates %s commands against the current round even after enabling",
    (group) => {
      const catalog = new BrowserToolCatalog([]);
      const advertised = catalog.activeGroups();
      catalog.enable([group]);
      for (const command of browserToolGroups[group].commands) {
        const correction = catalog.correctionFor(command, advertised);
        expect(correction).toMatchObject({
          accepted: false,
          code: "TOOL_GROUP_REQUIRED",
          requiredGroup: group,
          nextAction: expect.stringContaining("enable_browser_tools"),
        });
        expect(
          Buffer.byteLength(JSON.stringify(correction)),
        ).toBeLessThanOrEqual(2_048);
        expect(
          catalog.correctionFor(command, catalog.activeGroups()),
        ).toBeNull();
      }
    },
  );

  it.each([
    { groups: [] },
    { groups: ["tabs", "made_up"] },
    { groups: [1] },
    { groups: ["tabs"], command: "page.click" },
  ])("rejects invalid enable input atomically: %j", (input) => {
    expect(enableBrowserToolsInputSchema.safeParse(input).success).toBe(false);
  });

  it("distinguishes platform-only commands from an alias or an unknown action", () => {
    const catalog = new BrowserToolCatalog([]);
    for (const command of runtimeCommandTypeSchema.options.filter(
      (name) => !getRuntimeActionCommandSchema(name),
    )) {
      expect(catalog.correctionFor(command, [])).toMatchObject({
        code: "COMMAND_NOT_ALLOWED",
      });
      expect(catalog.commandNames()).not.toContain(command);
    }
    expect(catalog.correctionFor("page.open", [])).toMatchObject({
      code: "INVALID_ARGUMENTS",
      suggestions: ["page.navigate"],
    });
    expect(catalog.correctionFor("page.unknown", [])).toBeNull();
  });

  it("can restore the complete legacy schema without discovery", () => {
    const catalog = new BrowserToolCatalog(
      [{ requiredEvidenceKinds: ["NETWORK"] }],
      "LEGACY",
    );
    expect(catalog.discoveryTools()).toEqual([]);
    expect(catalog.activeGroups()).toEqual([]);
    expect(catalog.commandNames()).toHaveLength(39);
    expect(catalog.correctionFor("page.open", [])).toBeNull();
    expect(catalog.correctionFor("network.arm", [])).toBeNull();
    const actual = structuredClone(catalog.parameters()) as {
      anyOf: CommandSchema[];
    };
    for (const variant of actual.anyOf) {
      expect(variant.properties.locatorRecoveryToken).toHaveProperty(
        "description",
      );
      delete variant.properties.locatorRecoveryToken;
    }
    expect(actual).toEqual(
      openAiFunctionSchema(runtimeActionCommandInputSchema),
    );
    expect(z.toJSONSchema(runtimeActionCommandInputSchema)).toHaveProperty(
      "anyOf",
    );
  });
});
