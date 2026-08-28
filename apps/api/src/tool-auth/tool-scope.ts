import { ForbiddenException } from "@nestjs/common";
import type { ToolCredentialScope } from "@devproof/contracts";

import type { ToolAuthContext } from "./tool-auth.types.js";

export function requireToolScope(
  current: ToolAuthContext,
  scope: ToolCredentialScope,
) {
  if (!current.credential.scopes.includes(scope)) {
    throw new ForbiddenException(`Tool credential requires ${scope} scope.`);
  }
}

export function requireAgentRuntimeIdentity(current: ToolAuthContext) {
  if (
    current.credential.kind !== "AGENT_RUNTIME" ||
    !current.credential.scopes.includes("runtime:lease")
  ) {
    throw new ForbiddenException(
      "A registered Agent Runtime credential is required.",
    );
  }
}

export function requireAgentRuntimePool(
  current: ToolAuthContext,
  pool: "SPEC_ANALYSIS" | "BROWSER_EXECUTION" | "POST_RUN_ANALYSIS",
) {
  requireAgentRuntimeIdentity(current);
  const credentialPool = current.credential.pool ?? "MIXED";
  if (credentialPool === "MIXED") {
    throw new ForbiddenException(
      "Legacy MIXED Agent Runtime credentials are disabled; provision a pool-specific credential.",
    );
  }
  if (credentialPool !== pool) {
    throw new ForbiddenException(
      `This Agent Runtime credential is not authorized for the ${pool} pool.`,
    );
  }
}
