import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type RunEvent } from "@prisma/client";
import {
  splitStepContext,
  type ExecutionContextAttempt,
  type ExecutionContextDetail,
  type StepContextCall,
  type StepContextContent,
} from "@devproof/contracts";
import { PrismaService } from "../database/prisma.service.js";
import { readStepContext } from "./step-context-archive.js";

const attemptSelect = {
  id: true,
  runId: true,
  number: true,
  status: true,
  createdAt: true,
  finishedAt: true,
  run: {
    select: {
      goal: true,
      taskExecutionId: true,
      taskCaseExecution: {
        select: { executionOrdinal: true, caseId: true, deploymentId: true },
      },
    },
  },
  _count: { select: { stepContexts: true } },
} satisfies Prisma.RunAttemptSelect;
type Attempt = Prisma.RunAttemptGetPayload<{ select: typeof attemptSelect }>;

function presentAttempt(a: Attempt): ExecutionContextAttempt {
  return {
    id: `${a.runId}+${a.number}`,
    runId: a.runId,
    attemptId: a.id,
    attemptNumber: a.number,
    goal: a.run.goal,
    status: a.status,
    executionOrdinal: a.run.taskCaseExecution?.executionOrdinal ?? null,
    createdAt: a.createdAt.toISOString(),
    finishedAt: a.finishedAt?.toISOString() ?? null,
    capturedCalls: a._count.stepContexts,
  };
}

export function contextSearch(
  teamId: string,
  q = "",
  caseId?: string,
): Prisma.RunAttemptWhereInput {
  const match = q
    .trim()
    .match(
      /^([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?:\+([1-9]\d{0,8}))?$/iu,
    );
  return {
    ...(match?.[2] ? { number: Number(match[2]) } : {}),
    run: {
      teamId,
      ...(caseId ? { taskCaseExecution: { caseId } } : {}),
      ...(match
        ? { id: match[1]! }
        : q.trim()
          ? { goal: { contains: q.trim(), mode: "insensitive" } }
          : {}),
    },
  };
}

@Injectable()
export class ExecutionContextService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    teamId: string,
    query: {
      q?: string | undefined;
      caseId?: string | undefined;
      status?: string | undefined;
      page: number;
    },
  ) {
    const pageSize = 30;
    const where = contextSearch(teamId, query.q, query.caseId);
    if (query.status)
      where.status = query.status as Exclude<
        Prisma.RunAttemptWhereInput["status"],
        undefined
      >;
    const [attempts, total] = await Promise.all([
      this.prisma.runAttempt.findMany({
        where,
        select: attemptSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.runAttempt.count({ where }),
    ]);
    return {
      items: attempts.map(presentAttempt),
      total,
      page: query.page,
      pageSize,
    };
  }

  private async attempt(teamId: string, runId: string, number: number) {
    const attempt = await this.prisma.runAttempt.findFirst({
      where: { runId, number, run: { teamId } },
      select: attemptSelect,
    });
    if (!attempt) throw new NotFoundException("Execution attempt not found.");
    return attempt;
  }

  private events(attemptId: string, teamId: string) {
    return this.prisma.runEvent.findMany({
      where: {
        teamId,
        attemptId,
        kind: {
          in: [
            "agent.model.started",
            "agent.model.completed",
            "agent.model.failed",
            "agent.tool.started",
            "agent.tool.completed",
            "agent.tool.failed",
          ],
        },
      },
      orderBy: { sequence: "asc" },
    });
  }

  async detail(
    teamId: string,
    runId: string,
    number: number,
  ): Promise<ExecutionContextDetail> {
    const attempt = await this.attempt(teamId, runId, number);
    const peer = attempt.run.taskCaseExecution;
    const [events, relatedAttempts, captures] = await Promise.all([
      this.events(attempt.id, teamId),
      this.prisma.runAttempt.findMany({
        where: {
          run: {
            teamId,
            ...(peer
              ? {
                  taskExecutionId: attempt.run.taskExecutionId,
                  taskCaseExecution: {
                    caseId: peer.caseId,
                    deploymentId: peer.deploymentId,
                  },
                }
              : { id: runId }),
          },
        },
        select: attemptSelect,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
      }),
      this.prisma.runStepContext.findMany({
        where: { teamId, attemptId: attempt.id },
        select: { id: true },
      }),
    ]);
    const fullIds = new Set(captures.map((c) => c.id));
    const steps: ExecutionContextDetail["steps"] = [];
    const byStep = new Map<string, ExecutionContextDetail["steps"][number]>();
    for (const start of events.filter(
      (e) => e.kind === "agent.model.started",
    )) {
      const payload = obj(start.payload);
      const key = `${payload.segmentId}:${payload.step}`;
      let step = byStep.get(key);
      if (!step) {
        step = {
          number: steps.length + 1,
          segmentId: String(payload.segmentId ?? "legacy"),
          localStep: Number(payload.step ?? 0),
          calls: [],
        };
        steps.push(step);
        byStep.set(key, step);
      }
      step.calls.push(
        presentCall(start, events, fullIds, !!attempt.finishedAt),
      );
    }
    return {
      attempt: presentAttempt(attempt),
      relatedAttempts: relatedAttempts.map(presentAttempt),
      caseId: peer?.caseId ?? null,
      steps,
    };
  }

  async content(
    teamId: string,
    runId: string,
    number: number,
    callId: string,
  ): Promise<StepContextContent> {
    const attempt = await this.attempt(teamId, runId, number);
    const events = await this.events(attempt.id, teamId);
    const start = events.find(
      (e) => e.kind === "agent.model.started" && modelId(e) === callId,
    );
    if (!start)
      throw new NotFoundException("Step context not found in this attempt.");
    const capture = await this.prisma.runStepContext.findFirst({
      where: { id: callId, teamId, runId, attemptId: attempt.id },
    });
    const completed = completion(start, events);
    const decision =
      obj(completed?.payload).decisionOutput ??
      obj(completed?.payload).outputPreview ??
      null;
    const preview = obj(obj(start.payload).inputPreview);
    const archived = capture ? readStepContext(capture.requestGzip) : null;
    const request = archived?.request ?? {
      messages: preview.input ?? [],
      tools: null,
    };
    const next = events.find(
      (e) => e.kind === "agent.model.started" && e.sequence > start.sequence,
    );
    const toolEvents = events.filter(
      (e) =>
        e.kind === "agent.tool.started" &&
        e.sequence > start.sequence &&
        (!next || e.sequence < next.sequence),
    );
    return {
      completeness: capture ? "FULL" : "LEGACY_PREVIEW",
      sha256: capture?.requestSha256 ?? null,
      byteLength: capture?.requestBytes ?? null,
      sections: splitStepContext(request),
      request,
      metrics: archived?.metrics ?? preview.context ?? null,
      decision,
      modelError:
        typeof obj(completed?.payload).errorMessage === "string"
          ? String(obj(completed?.payload).errorMessage)
          : null,
      redactedPaths: archived?.redactedPaths ?? [],
      tools: toolEvents.map((event) => {
        const p = obj(event.payload);
        const end = events.find(
          (e) =>
            ["agent.tool.completed", "agent.tool.failed"].includes(e.kind) &&
            obj(e.payload).callId === p.callId,
        );
        return {
          name: String(p.name),
          status: end ? String(obj(end.payload).status ?? "FAILED") : "RUNNING",
          input: p.inputPreview,
          output:
            obj(end?.payload).outputPreview ??
            obj(end?.payload).errorMessage ??
            null,
        };
      }),
    };
  }
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function modelId(event: RunEvent) {
  return String(obj(event.payload).modelCallId ?? event.id);
}
function completion(start: RunEvent, events: RunEvent[]) {
  const p = obj(start.payload);
  const next = events.find(
    (e) => e.kind === "agent.model.started" && e.sequence > start.sequence,
  );
  return events.find((e) => {
    const value = obj(e.payload);
    return (
      ["agent.model.completed", "agent.model.failed"].includes(e.kind) &&
      e.sequence > start.sequence &&
      (p.modelCallId
        ? value.modelCallId === p.modelCallId
        : value.segmentId === p.segmentId &&
          value.step === p.step &&
          (!next || e.sequence < next.sequence))
    );
  });
}

export function presentCall(
  start: RunEvent,
  events: RunEvent[],
  fullIds: Set<string>,
  terminal: boolean,
): StepContextCall {
  const p = obj(start.payload),
    end = completion(start, events),
    output = obj(
      obj(end?.payload).decisionOutput ?? obj(end?.payload).outputPreview,
    );
  const calls = Array.isArray(output.tool_calls) ? output.tool_calls : [];
  const intents = calls.flatMap((c) => {
    try {
      const value = JSON.parse(String(obj(obj(c).function).arguments));
      return typeof value.stepIntent === "string" ? [value.stepIntent] : [];
    } catch {
      return [];
    }
  });
  const metrics = obj(obj(p.inputPreview).context);
  const usage = obj(obj(end?.payload).usage);
  return {
    id: modelId(start),
    model: String(p.model ?? "unknown"),
    status: end
      ? end.kind === "agent.model.failed"
        ? "FAILED"
        : "SUCCEEDED"
      : terminal
        ? "INTERRUPTED"
        : "RUNNING",
    startedAt: start.occurredAt.toISOString(),
    durationMs:
      typeof obj(end?.payload).durationMs === "number"
        ? Number(obj(end?.payload).durationMs)
        : null,
    intent: intents.length ? intents.join("；") : null,
    hasFullContext: fullIds.has(modelId(start)),
    requestBytes: nonnegativeNumber(metrics.requestBytes),
    inputTokens:
      nonnegativeNumber(usage.prompt_tokens) ??
      nonnegativeNumber(usage.input_tokens),
    toolNames: calls.map((c) => String(obj(obj(c).function).name)),
  };
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
