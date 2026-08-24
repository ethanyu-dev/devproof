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
