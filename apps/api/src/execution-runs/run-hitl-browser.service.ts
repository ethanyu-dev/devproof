import {
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { BrowserHumanInputEvent } from "@devproof/runtime-protocol";

import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { RuntimeHumanControlRelay } from "../runtime/runtime-human-control-relay.service.js";
import type { HumanPreviewEvent } from "../runtime/runtime-human-control-relay.service.js";
import { RuntimeSessionsService } from "../runtime/runtime-sessions.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { ExecutionRunService } from "./execution-run.service.js";

const CONTROL_TTL_MS = 20_000;
const CONTROL_SESSION_TTL_SECONDS = 15 * 60;
const MAX_INPUT_EVENTS_PER_SECOND = 120;

@Injectable()
export class RunHitlBrowserService {
  private readonly inputWindows = new Map<
    string,
    { count: number; startedAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: RuntimeSessionsService,
    private readonly relay: RuntimeHumanControlRelay,
    private readonly runs: ExecutionRunService,
  ) {}

  async status(current: AuthContext, runId: string, interventionId: string) {
    const context = await this.context(current, runId, interventionId);
    const session = context.attempt.browserExecution?.runtimeSession;
    const lease = await this.prisma.browserHumanControlLease.findUnique({
      where: { interventionId },
    });
    const leaseIsActive = Boolean(
      lease && lease.expiresAt.getTime() > Date.now(),
    );
    const controlledByMe = Boolean(
      leaseIsActive && lease?.controllerUserId === current.user.id,
    );
    const unavailableReason = !session
      ? "NO_SESSION"
      : session.protocolMinor < 1
        ? "PROTOCOL_UNSUPPORTED"
        : !["ACTIVE", "HUMAN_CONTROL"].includes(session.status)
          ? "SESSION_UNAVAILABLE"
          : null;
    return {
      control:
        lease && leaseIsActive
          ? {
              controlledByMe,
              expiresAt: lease.expiresAt,
              ...(controlledByMe ? { id: lease.id } : {}),
            }
          : null,
      expiresAt: context.expiresAt ?? context.run.deadlineAt,
      interventionId,
      prompt: context.prompt,
      ready: unavailableReason === null,
      runId,
      runtimeSession: session
        ? {
            id: session.id,
            profileId: session.userBrowserProfileId ?? null,
            profileMode: session.profileMode,
            status: session.status,
          }
        : null,
      unavailableReason,
    };
  }

  async claim(current: AuthContext, runId: string, interventionId: string) {
    const context = await this.context(current, runId, interventionId);
    const execution = context.attempt.browserExecution;
    const session = this.supportedSession(execution?.runtimeSession ?? null);
    await this.prisma.browserHumanControlLease.deleteMany({
      where: { interventionId, expiresAt: { lte: new Date() } },
    });
    const existing = await this.prisma.browserHumanControlLease.findUnique({
      where: { interventionId },
    });
    if (existing) {
      if (existing.controllerUserId === current.user.id) {
        const lease = await this.prisma.browserHumanControlLease.update({
          data: { expiresAt: new Date(Date.now() + CONTROL_TTL_MS) },
          where: { id: existing.id },
        });
        return { expiresAt: lease.expiresAt, id: lease.id };
      }
      throw new ConflictException(
        "This browser handoff is already controlled in another window.",
      );
    }

    const wasActive = session.status === "ACTIVE";
    if (wasActive) {
      await this.sessions.takeover(current, session.id, {
        ttlSeconds: CONTROL_SESSION_TTL_SECONDS,
      });
    } else if (session.humanControllerUserId !== current.user.id) {
      throw new ConflictException(
        "This browser session is controlled by another user.",
      );
    }

    try {
      const lease = await this.prisma.$transaction(async (tx) => {
        const created = await tx.browserHumanControlLease.create({
          data: {
            controllerUserId: current.user.id,
            expiresAt: new Date(Date.now() + CONTROL_TTL_MS),
            interventionId,
            sessionId: session.id,
            teamId: current.team.id,
          },
        });
        if (execution) {
          await tx.browserExecution.update({
            data: { status: "HUMAN_CONTROL" },
            where: { id: execution.id },
          });
        }
        await tx.runEvent.create({
          data: {
            actor: "HUMAN",
            attemptId: context.attemptId,
            kind: "human.browser_control.started",
            payload: { interventionId, runtimeSessionId: session.id },
            runId,
            taskId: context.taskId,
            teamId: current.team.id,
          },
        });
        return created;
      });
      return { expiresAt: lease.expiresAt, id: lease.id };
    } catch (error) {
      if (wasActive) {
        await this.sessions.release(current, session.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async heartbeat(
    current: AuthContext,
    runId: string,
    interventionId: string,
    controlId: string,
  ) {
    await this.context(current, runId, interventionId);
    const expiresAt = new Date(Date.now() + CONTROL_TTL_MS);
    const updated = await this.prisma.browserHumanControlLease.updateMany({
      data: { expiresAt },
      where: {
        controllerUserId: current.user.id,
        expiresAt: { gt: new Date() },
        id: controlId,
        interventionId,
        teamId: current.team.id,
      },
    });
    if (updated.count !== 1) {
      throw new GoneException("Browser control lease has expired.");
    }
    return { controlId, expiresAt };
  }

  async input(
    current: AuthContext,
    runId: string,
    interventionId: string,
    controlId: string,
    events: BrowserHumanInputEvent[],
  ) {
    const { session } = await this.controlledSession(
      current,
      runId,
      interventionId,
      controlId,
    );
    this.consumeInputBudget(controlId, events.length);
    await this.relay.dispatch(session, events);
    return { accepted: true };
  }

  async stream(
    current: AuthContext,
    runId: string,
    interventionId: string,
    emit: (event: HumanPreviewEvent) => void,
  ) {
    const lease = await this.prisma.browserHumanControlLease.findFirst({
      where: {
        controllerUserId: current.user.id,
        expiresAt: { gt: new Date() },
        interventionId,
        teamId: current.team.id,
      },
    });
    if (!lease) throw new GoneException("Browser control lease has expired.");
    const { session } = await this.controlledSession(
      current,
      runId,
      interventionId,
      lease.id,
    );
    return this.relay.subscribe(session, emit);
  }

  async release(
    current: AuthContext,
    runId: string,
    interventionId: string,
    controlId: string,
  ) {
    const { context, session } = await this.controlledSession(
      current,
      runId,
      interventionId,
      controlId,
      true,
    );
    const browserExecutionId = context.attempt.browserExecution?.id;
    if (!browserExecutionId) {
      throw new ConflictException("Browser execution is no longer available.");
    }
    await this.prisma.browserHumanControlLease.deleteMany({
      where: { controllerUserId: current.user.id, id: controlId },
    });
    this.inputWindows.delete(controlId);
    await this.sessions.release(current, session.id);
    await this.prisma.$transaction([
      this.prisma.browserExecution.updateMany({
        data: { status: "ACTIVE" },
        where: {
          id: browserExecutionId,
          status: "HUMAN_CONTROL",
        },
      }),
      this.prisma.runEvent.create({
        data: {
          actor: "HUMAN",
          attemptId: context.attemptId,
          kind: "human.browser_control.released",
          payload: { interventionId, runtimeSessionId: session.id },
          runId,
          taskId: context.taskId,
          teamId: current.team.id,
        },
      }),
    ]);
    return { released: true };
  }

  async complete(
    current: AuthContext,
    runId: string,
    interventionId: string,
    input: {
      controlId: string;
      note: string;
      resolution: "continue" | "cancel";
    },
  ) {
    await this.release(current, runId, interventionId, input.controlId);
    const intervention = await this.runs.resolveIntervention(
      asToolContext(current),
      runId,
      interventionId,
      {
        response: {
          approved: input.resolution === "continue",
          browserAssistance: true,
          note: input.note,
          resolution: input.resolution,
        },
      },
    );
    return { intervention, resolution: input.resolution };
  }

  private async context(
    current: AuthContext,
    runId: string,
    interventionId: string,
  ) {
    const intervention = await this.prisma.humanIntervention.findFirst({
      include: {
        attempt: {
          include: {
            browserExecution: { include: { runtimeSession: true } },
          },
        },
        run: true,
      },
      where: { id: interventionId, runId, teamId: current.team.id },
    });
    if (!intervention) {
      throw new NotFoundException("Human intervention was not found.");
    }
    if (intervention.status !== "PENDING") {
      throw new GoneException("Human intervention is no longer pending.");
    }
    if (intervention.expiresAt && intervention.expiresAt <= new Date()) {
      throw new GoneException("Human intervention has expired.");
    }
    if (intervention.run.lifecycle !== "WAITING_HUMAN") {
      throw new ConflictException("Run is not waiting for human input.");
    }
    return intervention;
  }

  private supportedSession<
    T extends null | {
      humanControllerUserId: string | null;
      id: string;
      protocolMinor: number;
      status: string;
    },
  >(session: T): Exclude<T, null> {
    if (!session) {
      throw new ConflictException(
        "This intervention is not attached to a Browser Runtime session.",
      );
    }
    if (session.protocolMinor < 1) {
      throw new ConflictException(
        "Browser Runtime must be restarted with human input protocol support.",
      );
    }
    if (!["ACTIVE", "HUMAN_CONTROL"].includes(session.status)) {
      throw new ConflictException("Browser Runtime session is not available.");
    }
    return session as Exclude<T, null>;
  }

  private async controlledSession(
    current: AuthContext,
    runId: string,
    interventionId: string,
    controlId: string,
    allowExpired = false,
  ) {
    const context = await this.context(current, runId, interventionId);
    const session = this.supportedSession(
      context.attempt.browserExecution?.runtimeSession ?? null,
    );
    const lease = await this.prisma.browserHumanControlLease.findFirst({
      where: {
        controllerUserId: current.user.id,
        id: controlId,
        interventionId,
        sessionId: session.id,
        teamId: current.team.id,
        ...(allowExpired ? {} : { expiresAt: { gt: new Date() } }),
      },
    });
    if (!lease) throw new GoneException("Browser control lease has expired.");
    if (
      session.status !== "HUMAN_CONTROL" ||
      session.humanControllerUserId !== current.user.id
    ) {
      throw new GoneException("Browser control is no longer active.");
    }
    return { context, session };
  }

  private consumeInputBudget(controlId: string, count: number) {
    const now = Date.now();
    const current = this.inputWindows.get(controlId);
    const window =
      !current || now - current.startedAt >= 1_000
        ? { count: 0, startedAt: now }
        : current;
    window.count += count;
    this.inputWindows.set(controlId, window);
    if (window.count > MAX_INPUT_EVENTS_PER_SECOND) {
      throw new HttpException(
        "Browser input rate limit exceeded.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function asToolContext(current: AuthContext): ToolAuthContext {
  return {
    credential: {
      id: current.user.id,
      name: current.user.name ?? current.user.email ?? "Console user",
      scopes: ["run:read", "run:write", "run:cancel"],
    },
    team: current.team,
  };
}
