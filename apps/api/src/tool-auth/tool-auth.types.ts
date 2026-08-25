import type { ToolCredentialScope } from "@devproof/contracts";

export interface ToolAuthContext {
  credential: {
    id: string;
    kind?: "AGENT_RUNTIME" | "TOOL";
    name: string;
    scopes: ToolCredentialScope[];
  };
  team: {
    id: string;
    name: string;
    slug: string;
  };
}
