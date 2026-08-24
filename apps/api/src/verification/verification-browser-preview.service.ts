import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { RuntimeHumanControlRelay } from "../runtime/runtime-human-control-relay.service.js";
import type { HumanPreviewEvent } from "../runtime/runtime-human-control-relay.service.js";

@Injectable()
export class VerificationBrowserPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: RuntimeHumanControlRelay,
  ) {}

  async status(current: AuthContext, runId: string) {
    const run = await this.context(current, runId);
    const session = run.runtimeSession;
    const unavailableReason = !session
      ? "NO_SESSION"
      : session.protocolMinor < 1
        ? "PROTOCOL_UNSUPPORTED"
        : session.runtime.status !== "ONLINE"
          ? "RUNTIME_OFFLINE"
          : !["ACTIVE", "HUMAN_CONTROL"].includes(session.status)
            ? "SESSION_UNAVAILABLE"
            : null;

    return {
      ready: unavailableReason === null,
      runId,
      runtimeSession: session
        ? {
            id: session.id,
            profileId: session.userBrowserProfileId ?? null,
            profileMode: session.profileMode,
            runtime: session.runtime,
            status: session.status,
          }
        : null,
      unavailableReason,
    };
  }

  async stream(
    current: AuthContext,
    runId: string,
    emit: (event: HumanPreviewEvent) => void,
  ) {
    const run = await this.context(current, runId);
    const session = run.runtimeSession;
    if (!session) {
      throw new ConflictException(
        "This verification is not attached to a Browser Runtime session.",
      );
    }
    if (session.protocolMinor < 1) {
      throw new ConflictException(
        "Browser Runtime must be restarted with preview protocol support.",
      );
    }
    if (session.runtime.status !== "ONLINE") {
      throw new ConflictException("Browser Runtime is offline.");
    }
    if (!["ACTIVE", "HUMAN_CONTROL"].includes(session.status)) {
      throw new ConflictException("Browser Runtime session is not available.");
    }
    return this.relay.subscribe(session, emit);
  }

  private async context(current: AuthContext, runId: string) {
    const run = await this.prisma.verificationRun.findFirst({
      include: {
        runtimeSession: {
          include: {
            runtime: { select: { id: true, name: true, status: true } },
          },
        },
      },
      where: { id: runId, teamId: current.team.id },
    });
    if (!run) throw new NotFoundException("Verification was not found.");
    return run;
  }
}
