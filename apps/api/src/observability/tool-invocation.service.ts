import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../database/prisma.service.js";
import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { MetricsService } from "./metrics.service.js";
import {
  ObservabilityService,
  summarizeValue,
} from "./observability.service.js";

interface InvocationInput {
  arguments: unknown;
  clientName?: string;
  clientVersion?: string;
  current: ToolAuthContext;
  mcpRequestId?: string;
  requestId?: string;
  runId?: string;
  probe?: boolean;
  toolName: string;
  transport: "MCP" | "HTTP";
}

function terminalStatus(
  code: string,
  aborted: boolean,
): "FAILED" | "CANCELLED" | "TIMED_OUT" {
  if (aborted || code === "ABORT_ERR" || code === "CANCELLED")
    return "CANCELLED";
  if (code.includes("TIMEOUT") || code === "ABORTERROR") return "TIMED_OUT";
  return "FAILED";
}

@Injectable()
export class ToolInvocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly observability: ObservabilityService,
    private readonly metrics: MetricsService,
  ) {}

  async run<T>(
    input: InvocationInput,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (input.probe) {
      return this.runProbe(input, operation, signal);
    }
    const started = Date.now();
    const requestContext =
      this.observability.current() ??
      this.observability.root(
        input.requestId ? { requestId: input.requestId } : {},
      );
    let runId = input.runId;
    let traceId = requestContext.traceId;
    if (runId) {
      const run = await this.prisma.verificationRun.findFirst({
        select: { traceId: true },
        where: { id: runId, teamId: input.current.team.id },
      });
      if (run) traceId = run.traceId;
      else runId = undefined;
    }
    const context = this.observability.childSpan({
      credentialId: input.current.credential.id,
      ...(runId ? { runId } : {}),
      traceId,
    });
    const invocation = await this.prisma.toolInvocation.create({
      data: {
        ...(input.clientName ? { clientName: input.clientName } : {}),
        ...(input.clientVersion ? { clientVersion: input.clientVersion } : {}),
        credentialId: input.current.credential.id,
        inputSummary: summarizeValue(input.arguments) as Prisma.InputJsonValue,
        ...(input.mcpRequestId ? { mcpRequestId: input.mcpRequestId } : {}),
        requestId: input.requestId ?? context.requestId,
        ...(runId ? { runId } : {}),
        spanId: context.spanId,
        teamId: input.current.team.id,
        toolName: input.toolName,
        traceId,
        transport: input.transport,
      },
    });
    context.toolInvocationId = invocation.id;
    return this.observability.run(context, async () => {
      this.observability.log("info", "tool.invocation.started", {
        invocationId: invocation.id,
        toolName: input.toolName,
        transport: input.transport,
      });

      let output: T;
      try {
        output = await operation();
      } catch (error) {
        const classified = this.observability.classifyError(error);
        const status = terminalStatus(
          classified.code,
          signal?.aborted ?? false,
        );
        const durationMs = Date.now() - started;
        await this.prisma.toolInvocation
          .update({
            data: {
              completedAt: new Date(),
              durationMs,
              errorCode: classified.code,
              errorMessage: classified.message,
              status,
            },
            where: { id: invocation.id },
          })
          .catch((auditError: unknown) => {
            this.logAuditFailure(input, invocation.id, status, auditError);
          });
        this.recordMetrics(input, status, durationMs);
        this.observability.log(
          "error",
          "tool.invocation.failed",
          {
            durationMs,
            invocationId: invocation.id,
            status,
            toolName: input.toolName,
          },
          error,
        );
        throw error;
      }

      const durationMs = Date.now() - started;
      await this.finalizeSuccess(
        input,
        invocation.id,
        output,
        runId,
        durationMs,
      ).catch((auditError: unknown) => {
        this.logAuditFailure(input, invocation.id, "SUCCEEDED", auditError);
      });
      this.recordMetrics(input, "SUCCEEDED", durationMs);
      this.observability.log("info", "tool.invocation.completed", {
        durationMs,
        invocationId: invocation.id,
        status: "SUCCEEDED",
        toolName: input.toolName,
      });
      return output;
    });
  }

  private async finalizeSuccess<T>(
    input: InvocationInput,
    invocationId: string,
    output: T,
    runId: string | undefined,
    durationMs: number,
  ) {
    const resolvedRunId = await this.resolveOutputRunId(
      output,
      runId,
      input.current.team.id,
    );
    await this.prisma.toolInvocation.update({
      data: {
        completedAt: new Date(),
        durationMs,
        outputSummary: summarizeValue(output) as Prisma.InputJsonValue,
        ...(resolvedRunId
          ? { runId: resolvedRunId.id, traceId: resolvedRunId.traceId }
          : {}),
        status: "SUCCEEDED",
      },
      where: { id: invocationId },
    });
  }

  private logAuditFailure(
    input: InvocationInput,
    invocationId: string,
    operationStatus: string,
    error: unknown,
  ) {
    this.observability.log(
      "error",
      "tool.invocation.audit_finalize_failed",
      { invocationId, operationStatus, toolName: input.toolName },
      error,
    );
  }

  private async runProbe<T>(
    input: InvocationInput,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const started = Date.now();
    try {
      const output = await operation();
      const durationMs = Date.now() - started;
      this.metrics.increment(
        "devproof_integration_probes_total",
        "Integration readiness probes by transport and terminal status.",
        { status: "succeeded", transport: input.transport.toLowerCase() },
      );
      this.metrics.observe(
        "devproof_integration_probe_duration_seconds",
        "Integration readiness probe duration in seconds.",
        durationMs / 1_000,
        { transport: input.transport.toLowerCase() },
      );
      this.observability.log("debug", "integration.probe.completed", {
        durationMs,
        status: "SUCCEEDED",
        transport: input.transport,
      });
      return output;
    } catch (error) {
      const status = terminalStatus(
        this.observability.classifyError(error).code,
        signal?.aborted ?? false,
      );
      this.metrics.increment(
        "devproof_integration_probes_total",
        "Integration readiness probes by transport and terminal status.",
        {
          status: status.toLowerCase(),
          transport: input.transport.toLowerCase(),
        },
      );
      this.observability.log(
        "warn",
        "integration.probe.failed",
        { status, transport: input.transport },
        error,
      );
      throw error;
    }
  }

  private recordMetrics(
    input: InvocationInput,
    status: string,
    durationMs: number,
  ) {
    const labels = {
      status: status.toLowerCase(),
      tool: input.toolName,
      transport: input.transport.toLowerCase(),
    };
    this.metrics.increment(
      "devproof_tool_invocations_total",
      "Tool invocations by tool, transport and terminal status.",
      labels,
    );
    this.metrics.observe(
      "devproof_tool_invocation_duration_seconds",
      "Tool invocation duration in seconds.",
      durationMs / 1_000,
      { tool: input.toolName, transport: input.transport.toLowerCase() },
    );
  }

  private async resolveOutputRunId(
    output: unknown,
    existing: string | undefined,
    teamId: string,
  ) {
    if (existing) return undefined;
    const envelope =
      output &&
      typeof output === "object" &&
      "structuredContent" in output &&
      output.structuredContent &&
      typeof output.structuredContent === "object"
        ? (output.structuredContent as Record<string, unknown>)
        : output && typeof output === "object"
          ? (output as Record<string, unknown>)
          : undefined;
    const candidate =
      envelope && typeof envelope.id === "string"
        ? envelope.id
        : envelope?.verification &&
            typeof envelope.verification === "object" &&
            "id" in envelope.verification &&
            typeof envelope.verification.id === "string"
          ? envelope.verification.id
          : undefined;
    if (!candidate) return undefined;
    return this.prisma.verificationRun.findFirst({
      select: { id: true, traceId: true },
      where: { id: candidate, teamId },
    });
  }
}
