import { ConflictException } from "@nestjs/common";

/** Rollout barrier covers every mutation, not merely the periodic Worker. */
export function recoveryEnabled() {
  return process.env.RUNTIME_SESSION_RECOVERY_ENABLED === "true";
}
export function requireRecoveryEnabled() {
  if (!recoveryEnabled())
    throw new ConflictException({
      code: "SESSION_RECOVERY_DISABLED",
      message:
        "Session recovery is paused until all API and Worker replicas support verified closure.",
    });
}
