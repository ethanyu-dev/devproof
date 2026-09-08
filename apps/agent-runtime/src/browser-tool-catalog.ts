import {
  getRuntimeActionCommandSchema,
  runtimeActionCommandInputSchema,
  runtimeCommandTypeSchema,
} from "@devproof/runtime-protocol";
import { z } from "zod";
import { openAiFunctionSchema } from "./model-tool-schema.js";
import { toolCorrection, type ToolCorrection } from "./tool-correction.js";

type CommandName = z.infer<
  typeof runtimeActionCommandInputSchema
>["commandType"];
export type BrowserToolSurfaceMode = "GROUPED" | "LEGACY";

export const coreBrowserCommands = [
  "page.navigate",
  "page.snapshot",
  "page.get_text",
  "page.get_url",
  "page.get_title",
  "page.click",
  "page.fill",
  "page.press",
  "page.check",
  "page.uncheck",
  "page.select",
  "page.scroll",
  "page.wait",
  "page.screenshot",
  "page.dom",
] as const satisfies readonly CommandName[];

export const browserToolGroups = {
  navigation: {
    description: "后退、前进和刷新页面",
    commands: ["page.back", "page.forward", "page.reload"],
  },
  input: {
    description: "逐字输入、悬停和拖拽",
    commands: ["page.type", "page.hover", "page.drag"],
  },
  tabs: {
    description: "列出、新建、切换和关闭标签页",
    commands: ["tab.list", "tab.new", "tab.switch", "tab.close"],
  },
  frames: {
    description: "观察和操作 iframe",
    commands: ["frame.snapshot", "frame.click", "frame.fill"],
  },
  diagnostics: {
    description: "页面错误、控制台和网络证据",
    commands: ["page.errors", "page.console", "page.network"],
  },
  inspection: {
    description: "检查元素状态和匹配数量",
    commands: ["element.state", "locator.count"],
  },
  viewport: { description: "调整页面视口尺寸", commands: ["page.resize"] },
  network_faults: {
    description: "设置网络故障、等待命中、查询和释放策略",
    commands: [
      "network.arm",
      "network.wait_for_hit",
      "network.status",
      "network.release",
    ],
  },
} as const satisfies Record<
  string,
  { description: string; commands: readonly CommandName[] }
>;

export type BrowserToolGroup = keyof typeof browserToolGroups;
export const browserToolGroupNames = Object.keys(
  browserToolGroups,
) as BrowserToolGroup[];
export const enableBrowserToolsInputSchema = z
  .object({
    groups: z
      .array(z.enum(browserToolGroupNames))
      .min(1)
      .max(browserToolGroupNames.length),
  })
  .strict();
const platformCommands = new Set<string>(
  runtimeCommandTypeSchema.options.filter(
    (name) => !getRuntimeActionCommandSchema(name),
  ),
);

/** Discovery is segment-local presentation state, not browser authorization. */
export class BrowserToolCatalog {
  private readonly enabled = new Set<BrowserToolGroup>();
  private schema: unknown;
  readonly grouped: boolean;

  constructor(
    criteria: ReadonlyArray<{ requiredEvidenceKinds: readonly string[] }>,
    mode: BrowserToolSurfaceMode = "GROUPED",
  ) {
    this.grouped = mode !== "LEGACY";
    if (
      this.grouped &&
      criteria.some((criterion) =>
        criterion.requiredEvidenceKinds.some(
          (kind) => kind === "NETWORK" || kind === "CONSOLE",
        ),
      )
    )
      this.enabled.add("diagnostics");
  }

  activeGroups(): BrowserToolGroup[] {
    return browserToolGroupNames.filter((group) => this.enabled.has(group));
  }

  commandNames(): CommandName[] {
    if (!this.grouped)
      return [
        ...coreBrowserCommands,
        ...browserToolGroupNames.flatMap(
          (group) => browserToolGroups[group].commands,
        ),
        "page.open",
      ];
    return [
      ...coreBrowserCommands,
      ...this.activeGroups().flatMap(
        (group) => browserToolGroups[group].commands,
      ),
    ];
  }

  enable(groups: readonly BrowserToolGroup[]) {
    for (const group of groups) {
      if (this.enabled.has(group)) continue;
      this.enabled.add(group);
      this.schema = undefined;
    }
    return { enabledGroups: this.activeGroups() };
  }

  correctionFor(
    commandName: unknown,
    advertisedGroups: readonly BrowserToolGroup[],
  ): ToolCorrection | null {
    if (typeof commandName === "string" && platformCommands.has(commandName))
      return toolCorrection("该命令由平台管理，Agent 不能调用。", {
        code: "COMMAND_NOT_ALLOWED",
        nextAction:
          "会话生命周期和人工接管状态由平台管理；请使用本轮公布的浏览器操作。",
      });
    if (!this.grouped) return null;
    if (commandName === "page.open")
      return toolCorrection("page.open 是导航别名；请使用 page.navigate。", {
        suggestions: ["page.navigate"],
      });
    const group = browserToolGroupNames.find((name) =>
      (browserToolGroups[name].commands as readonly unknown[]).includes(
        commandName,
      ),
    );
    if (!group || advertisedGroups.includes(group)) return null;
    return toolCorrection("该命令所属的工具模块尚未在本轮公布。", {
      code: "TOOL_GROUP_REQUIRED",
      requiredGroup: group,
      nextAction: `调用 enable_browser_tools，设置 groups=["${group}"]；收到下一轮工具定义后再提交操作。`,
    });
  }

  parameters(): unknown {
    if (this.schema !== undefined) return this.schema;
    const schema = this.grouped
      ? z.union(
          this.commandNames().map((name) => {
            const variant = getRuntimeActionCommandSchema(name);
            if (!variant)
              throw new Error(
                `Missing canonical browser command schema: ${name}`,
              );
            return variant;
          }),
        )
      : runtimeActionCommandInputSchema;
    this.schema = addLocatorRecoveryToken(
      openAiFunctionSchema(schema),
      !this.grouped,
    );
    return this.schema;
  }

  discoveryTools() {
    return this.grouped
      ? [
          {
            type: "function",
            name: "enable_browser_tools",
            strict: false,
            description:
              "启用本执行段的浏览器工具模块；仅扩展下一轮工具定义，不操作浏览器，也不授予权限。可用模块：\n" +
              browserToolGroupNames
                .map(
                  (group) =>
                    `${group}：${browserToolGroups[group].description}（${browserToolGroups[group].commands.join("、")}）`,
                )
                .join("\n"),
            parameters: openAiFunctionSchema(enableBrowserToolsInputSchema),
          },
        ]
      : [];
  }
}

function addLocatorRecoveryToken(
  value: unknown,
  describeToken: boolean,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => addLocatorRecoveryToken(item, describeToken));
  if (!value || typeof value !== "object") return value;
  const mapped = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      addLocatorRecoveryToken(child, describeToken),
    ]),
  );
  if (
    mapped.properties &&
    typeof mapped.properties === "object" &&
    !Array.isArray(mapped.properties) &&
    "commandType" in mapped.properties &&
    "payload" in mapped.properties
  ) {
    mapped.properties = {
      ...mapped.properties,
      locatorRecoveryToken: {
        ...(describeToken
          ? {
              description:
                "仅在恢复 LOCATOR_AMBIGUOUS 时填写；必须原样复制最近一次 locatorRecovery.recoveryToken。",
            }
          : {}),
        maxLength: 240,
        minLength: 1,
        type: "string",
      },
    };
  }
  return mapped;
}
