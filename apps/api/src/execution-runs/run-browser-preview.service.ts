import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { browserConnection } from "../runtime/direct-control-ticket.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { RuntimeHumanControlRelay } from "../runtime/runtime-human-control-relay.service.js";
import type { HumanPreviewEvent } from "../runtime/runtime-human-control-relay.service.js";

@Injectable()
export class RunBrowserPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly relay: RuntimeHumanControlRelay,
  ) {}

  async status(current: AuthContext, runId: string) {
    const { run, session } = await this.context(current, runId);
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
      lifecycle: run.lifecycle,
      ready: unavailableReason === null,
      runId,
      runtimeSession: session
        ? {
            id: session.id,
            profileId: session.userBrowserProfileId ?? null,
            profileMode: session.profileMode,
            runtime: {
              id: session.runtime.id,
              name: session.runtime.name,
              status: session.runtime.status,
            },
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
    const { session } = await this.context(current, runId);
    this.assertPreviewSession(session);
    return this.relay.subscribe(session, emit);
  }

  async connection(current: AuthContext, runId: string) {
    const { run, session } = await this.context(current, runId);
    if (run.lifecycle !== "RUNNING") {
      throw new ConflictException("Run is not running.");
    }
    this.assertPreviewSession(session);
    // Older nodes cannot interpret scoped read-only tickets.
    if (
      !Array.isArray(session.runtime.capabilities) ||
      !session.runtime.capabilities.includes("direct-preview-v1")
    ) {
      return { transport: "relay" as const };
    }
    return browserConnection(current, session, undefined, "preview");
  }

  private assertPreviewSession(
    session: Awaited<
      ReturnType<RunBrowserPreviewService["context"]>
    >["session"],
  ): asserts session is NonNullable<typeof session> {
    if (!session) {
      throw new ConflictException("Browser Runtime session is not available.");
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
  }

  private async context(current: AuthContext, runId: string) {
    const run = await this.prisma.executionRun.findFirst({
      include: {
        browserExecutions: {
          include: {
            runtimeSession: {
              include: {
                runtime: {
                  select: {
                    id: true,
                    name: true,
                    status: true,
                    capabilities: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
      where: { id: runId, teamId: current.team.id },
    });
    if (!run) throw new NotFoundException("Run not found.");

    const sessions = run.browserExecutions.flatMap((execution) =>
      execution.runtimeSession ? [execution.runtimeSession] : [],
    );
    const session =
      sessions.find((candidate) =>
        ["ACTIVE", "HUMAN_CONTROL"].includes(candidate.status),
      ) ??
      sessions[0] ??
      null;
    return { run, session };
  }
}
