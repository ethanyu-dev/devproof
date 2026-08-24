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
import { HitlCoordinator } from "./hitl-coordinator.service.js";

const CONTROL_TTL_MS = 20_000;
const CONTROL_SESSION_TTL_SECONDS = 15 * 60;
const MAX_INPUT_EVENTS_PER_SECOND = 120;

@Injectable()
export class VerificationHitlBrowserService {
  private readonly inputWindows = new Map<
    string,
    { count: number; startedAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: RuntimeSessionsService,
    private readonly relay: RuntimeHumanControlRelay,
    private readonly hitl: HitlCoordinator,
  ) {}

  async status(current: AuthContext, runId: string, checkpointId: string) {
    const context = await this.context(current, runId, checkpointId);
    const session = context.run.runtimeSession;
    const lease = await this.prisma.browserHumanControlLease.findUnique({
      where: { checkpointId },
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
      checkpointId,
      control:
        lease && leaseIsActive
          ? {
              controlledByMe,
              expiresAt: lease.expiresAt,
              ...(controlledByMe ? { id: lease.id } : {}),
            }
          : null,
      expiresAt: context.expiresAt,
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

  async claim(current: AuthContext, runId: string, checkpointId: string) {
    const context = await this.context(current, runId, checkpointId);
    const session = this.supportedSession(context.run.runtimeSession);
    await this.prisma.browserHumanControlLease.deleteMany({
      where: { checkpointId, expiresAt: { lte: new Date() } },
    });
    const existing = await this.prisma.browserHumanControlLease.findUnique({
      where: { checkpointId },
    });
    if (existing) {
      if (existing.controllerUserId === current.user.id) {
        const expiresAt = new Date(Date.now() + CONTROL_TTL_MS);
        const lease = await this.prisma.browserHumanControlLease.update({
          data: { expiresAt },
          where: { id: existing.id },
        });
        return { expiresAt: lease.expiresAt, id: lease.id };
      }
      throw new ConflictException(
        "This browser handoff is already controlled in another window.",
      );
    }

    if (session.status === "ACTIVE") {
      await this.sessions.takeover(current, session.id, {
        ttlSeconds: CONTROL_SESSION_TTL_SECONDS,
      });
    } else if (session.humanControllerUserId !== current.user.id) {
      throw new ConflictException(
        "This browser session is controlled by another user.",
      );
    }

    try {
      const lease = await this.prisma.browserHumanControlLease.create({
        data: {
          checkpointId,
          controllerUserId: current.user.id,
          expiresAt: new Date(Date.now() + CONTROL_TTL_MS),
          sessionId: session.id,
          teamId: current.team.id,
        },
      });
      return { expiresAt: lease.expiresAt, id: lease.id };
    } catch (error) {
      if (session.status === "ACTIVE") {
        await this.sessions.release(current, session.id).catch(() => undefined);
      }
      throw error;
    }
  }

  async heartbeat(
    current: AuthContext,
    runId: string,
    checkpointId: string,
    controlId: string,
  ) {
    await this.context(current, runId, checkpointId);
    const expiresAt = new Date(Date.now() + CONTROL_TTL_MS);
    const updated = await this.prisma.browserHumanControlLease.updateMany({
      data: { expiresAt },
      where: {
        checkpointId,
        controllerUserId: current.user.id,
        expiresAt: { gt: new Date() },
        id: controlId,
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
    checkpointId: string,
    controlId: string,
    events: BrowserHumanInputEvent[],
  ) {
    const session = await this.controlledSession(
      current,
      runId,
      checkpointId,
      controlId,
    );
    this.consumeInputBudget(controlId, events.length);
    await this.relay.dispatch(session, events);
    return { accepted: true };
  }

  async stream(
    current: AuthContext,
    runId: string,
    checkpointId: string,
    emit: (event: HumanPreviewEvent) => void,
  ) {
    const lease = await this.prisma.browserHumanControlLease.findFirst({
      where: {
        checkpointId,
        controllerUserId: current.user.id,
        expiresAt: { gt: new Date() },
        teamId: current.team.id,
      },
    });
    if (!lease) throw new GoneException("Browser control lease has expired.");
    const session = await this.controlledSession(
      current,
      runId,
      checkpointId,
      lease.id,
    );
    return this.relay.subscribe(session, emit);
  }

  async release(
    current: AuthContext,
    runId: string,
    checkpointId: string,
    controlId: string,
  ) {
    const session = await this.controlledSession(
      current,
      runId,
      checkpointId,
      controlId,
      true,
    );
    await this.prisma.browserHumanControlLease.deleteMany({
      where: { id: controlId, controllerUserId: current.user.id },
    });
    this.inputWindows.delete(controlId);
    await this.sessions.release(current, session.id);
    return { released: true };
  }

  async complete(
    current: AuthContext,
    runId: string,
    checkpointId: string,
    input: {
      controlId: string;
      note: string;
      resolution: "continue" | "cancel";
    },
  ) {
    await this.release(current, runId, checkpointId, input.controlId);
    const checkpoint = await this.hitl.resolve(current, checkpointId, {
      response: {
        approved: input.resolution === "continue",
        browserAssistance: true,
        note: input.note,
        resolution: input.resolution,
      },
    });
    return { checkpoint, resolution: input.resolution };
  }

  private async context(
    current: AuthContext,
    runId: string,
    checkpointId: string,
  ) {
    const checkpoint = await this.prisma.verificationCheckpoint.findFirst({
      include: { run: { include: { runtimeSession: true } } },
      where: { id: checkpointId, runId, teamId: current.team.id },
    });
    if (!checkpoint) {
      throw new NotFoundException("HITL checkpoint was not found.");
    }
    if (checkpoint.status !== "PENDING") {
      throw new GoneException("HITL checkpoint is no longer pending.");
    }
    if (checkpoint.run.status !== "WAITING_HUMAN") {
      throw new ConflictException(
        "Verification is not waiting for human input.",
      );
    }
    return checkpoint;
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
        "This checkpoint is not attached to a Browser Runtime session.",
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
    checkpointId: string,
    controlId: string,
    allowExpired = false,
  ) {
    const context = await this.context(current, runId, checkpointId);
    const session = this.supportedSession(context.run.runtimeSession);
    const lease = await this.prisma.browserHumanControlLease.findFirst({
      where: {
        checkpointId,
        controllerUserId: current.user.id,
        id: controlId,
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
    return session;
  }

  private consumeInputBudget(controlId: string, count: number) {
    const now = Date.now();
    const current = this.inputWindows.get(controlId);
    const window =
      !current || now - current.startedAt >= 1000
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
