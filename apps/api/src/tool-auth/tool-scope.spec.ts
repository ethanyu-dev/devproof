import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { requireAgentRuntimeIdentity } from "./tool-scope.js";

const team = { id: "team-1", name: "Team", slug: "default" };

describe("Agent Runtime identity authorization", () => {
  it("rejects an ordinary tool credential even with a forged Runtime scope", () => {
    expect(() =>
      requireAgentRuntimeIdentity({
        credential: {
          id: "tool-1",
          kind: "TOOL",
          name: "Forged Runtime",
          scopes: ["runtime:lease"],
        },
        team,
      }),
    ).toThrow(ForbiddenException);
  });

  it("accepts only a registered Agent Runtime identity", () => {
    expect(() =>
      requireAgentRuntimeIdentity({
        credential: {
          id: "runtime-1",
          kind: "AGENT_RUNTIME",
          name: "Production Runtime",
          scopes: ["runtime:lease"],
        },
        team,
      }),
    ).not.toThrow();
  });
});
