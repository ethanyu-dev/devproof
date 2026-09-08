import type { RuntimePool } from "@devproof/agent-runtime-protocol";
import type { ToolCredentialScope } from "@devproof/contracts";

export interface ToolAuthContext {
  credential: {
    id: string;
    kind?: "AGENT_RUNTIME" | "TOOL";
    name: string;
    pool?: RuntimePool;
    scopes: ToolCredentialScope[];
  };
  team: {
    id: string;
    name: string;
    slug: string;
  };
}
