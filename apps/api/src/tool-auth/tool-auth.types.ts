import type { ToolCredentialScope } from "@devproof/contracts";

export interface ToolAuthContext {
  credential: {
    id: string;
    kind?: "AGENT_RUNTIME" | "TOOL";
    name: string;
    pool?: "SPEC_ANALYSIS" | "BROWSER_EXECUTION" | "MIXED";
    scopes: ToolCredentialScope[];
  };
  team: {
    id: string;
    name: string;
    slug: string;
  };
}
