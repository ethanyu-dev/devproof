import { describe, expect, it, vi } from "vitest";

import { MetricsService } from "./metrics.service.js";
import { ObservabilityService } from "./observability.service.js";
import { ToolInvocationService } from "./tool-invocation.service.js";

const current = {
  credential: { id: "credential-1" },
  team: { id: "team-1" },
} as never;

function fixture() {
  const prisma = {
    toolInvocation: {
      create: vi.fn().mockResolvedValue({ id: "invocation-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    verificationRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: "run-1",
        traceId: "11111111111111111111111111111111",
      }),
    },
  };
  const observability = new ObservabilityService();
  const metrics = new MetricsService();
  return {
    metrics,
    observability,
    prisma,
    service: new ToolInvocationService(prisma as never, observability, metrics),
  };
}

describe("ToolInvocationService", () => {
  it("persists caller identity, summaries, correlation and success timing", async () => {
    const { metrics, observability, prisma, service } = fixture();
    const context = observability.root({ requestId: "request-1" });
    const value = await observability.run(context, () =>
      service.run(
        {
          arguments: { authorization: "Bearer hidden", runId: "run-1" },
          current,
          runId: "run-1",
          toolName: "get_verification",
          transport: "MCP",
        },
        async () => ({ id: "run-1", status: "RUNNING" }),
      ),
    );

    expect(value).toMatchObject({ status: "RUNNING" });
    expect(prisma.toolInvocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        credentialId: "credential-1",
        requestId: "request-1",
        runId: "run-1",
        toolName: "get_verification",
        traceId: "11111111111111111111111111111111",
      }),
    });
    expect(
      JSON.stringify(prisma.toolInvocation.create.mock.calls[0]?.[0]),
    ).not.toContain("Bearer hidden");
    expect(prisma.toolInvocation.update).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "SUCCEEDED" }),
      where: { id: "invocation-1" },
    });
    expect(metrics.render()).toContain(
      'devproof_tool_invocations_total{status="succeeded",tool="get_verification",transport="mcp"} 1',
    );
  });

  it("records a classified terminal failure before rethrowing", async () => {
    const { prisma, service } = fixture();
    await expect(
      service.run(
        {
          arguments: {},
          current,
          toolName: "list_verifications",
          transport: "HTTP",
        },
        async () => {
          throw Object.assign(new Error("upstream failed"), {
            code: "UPSTREAM_FAILED",
          });
        },
      ),
    ).rejects.toThrow("upstream failed");

    expect(prisma.toolInvocation.update).toHaveBeenCalledWith({
      data: expect.objectContaining({
        errorCode: "UPSTREAM_FAILED",
        errorMessage: "upstream failed",
        status: "FAILED",
      }),
      where: { id: "invocation-1" },
    });
  });

  it("does not turn a successful operation into a failure when audit finalization fails", async () => {
    const { prisma, service } = fixture();
    prisma.toolInvocation.update.mockRejectedValueOnce(
      new Error("audit database unavailable"),
    );

    await expect(
      service.run(
        {
          arguments: {},
          current,
          toolName: "list_verifications",
          transport: "HTTP",
        },
        async () => ({ ok: true }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(prisma.toolInvocation.update).toHaveBeenCalledOnce();
  });

  it("preserves the original operation error when failure audit persistence fails", async () => {
    const { prisma, service } = fixture();
    prisma.toolInvocation.update.mockRejectedValueOnce(
      new Error("audit database unavailable"),
    );
    const operationError = new Error("operation failed");

    await expect(
      service.run(
        {
          arguments: {},
          current,
          toolName: "list_verifications",
          transport: "HTTP",
        },
        async () => {
          throw operationError;
        },
      ),
    ).rejects.toBe(operationError);
  });
});
