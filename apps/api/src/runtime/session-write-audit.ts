import type { Prisma } from "@prisma/client";

const SAFE_OBSERVATION_COMMANDS = [
  "page.snapshot",
  "page.get_text",
  "page.get_url",
  "page.get_title",
  "page.errors",
  "page.screenshot",
  "page.dom",
  "page.console",
  "page.network",
  "tab.list",
  "frame.snapshot",
  "element.state",
  "locator.count",
  "network.status",
];

/** All sources matter: a Console operation or human takeover can also write. */
export const potentialWriteCommandWhere: Prisma.BrowserRuntimeCommandWhereInput =
  {
    commandType: { notIn: [...SAFE_OBSERVATION_COMMANDS, "session.close"] },
    NOT: {
      AND: [
        { commandType: "session.open" },
        { source: "SYSTEM" },
        {
          session: {
            protocolMinor: { gte: 13 },
            purpose: "EXECUTION",
            // Only an admitted execution opens under a network-disabled STARTUP permit.
            browserExecutions: { some: {} },
          },
        },
      ],
    },
  };
