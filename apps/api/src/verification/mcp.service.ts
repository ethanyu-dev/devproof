import { Injectable, Optional } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  runInterventionResolveInputSchema,
  taskDeploymentTargetInputSchema,
  taskExecutionCreateInputSchema,
  taskExecutionStageTypeSchema,
  taskStageRetryInputSchema,
  type ToolCredentialScope,
} from "@devproof/contracts";

import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { requireToolScope } from "../tool-auth/tool-scope.js";
import { env } from "../config/env.js";
import { ToolInvocationService } from "../observability/tool-invocation.service.js";
import { ExecutionRunService } from "../execution-runs/execution-run.service.js";
import { TaskExecutionService } from "../task-executions/task-execution.service.js";

const TASK_TOOL_GUIDE = {
  controlPlane: "Task Execution",
  preferredTools: [
    "create_task",
    "get_task",
    "list_tasks",
    "set_task_deployment_target",
    "retry_task_stage",
    "cancel_task",
    "get_run",
    "resolve_run_intervention",
    "read_run_evidence",
  ],
  rules: [
    "Callers create and observe Task executions; DevProof owns Spec analysis, Case dispatch, Run attempts, browser commands, evidence and cleanup.",
    "Do not acquire, release or directly command Browser Runtime sessions from MCP.",
    "Use read_run_evidence for artifact:// references returned by get_run.",
    "Resolve a pending human intervention only after browser human control has been released.",
  ],
} as const;

const MCP_TOOL_SCOPES: Readonly<Partial<Record<string, ToolCredentialScope>>> =
  {
    cancel_task: "run:cancel",
    create_task: "run:write",
    get_run: "run:read",
    get_task: "run:read",
    list_tasks: "run:read",
    read_run_evidence: "run:read",
    resolve_run_intervention: "run:write",
    retry_task_stage: "run:write",
    set_task_deployment_target: "run:write",
  };

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => !["downloadUrl", "storageKey", "tokenHash"].includes(key),
        )
        .map(([key, item]) => [key, jsonSafe(item)]),
    );
  }
  return value;
}

function result(value: unknown) {
  const safe = jsonSafe(value);
  const structuredContent =
    safe && typeof safe === "object" && !Array.isArray(safe)
      ? (safe as Record<string, unknown>)
      : { value: safe };
  return {
    content: [{ text: JSON.stringify(safe), type: "text" as const }],
    structuredContent,
  };
}

@Injectable()
export class VerificationMcpService {
  constructor(
    private readonly invocations: ToolInvocationService,
    @Optional() private readonly runs?: ExecutionRunService,
    @Optional() private readonly tasks?: TaskExecutionService,
  ) {}

  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    current: ToolAuthContext,
  ) {
    const clientName =
      typeof request.headers["x-devproof-client-name"] === "string"
        ? request.headers["x-devproof-client-name"]
        : request.headers["user-agent"];
    const clientVersion =
      typeof request.headers["x-devproof-client-version"] === "string"
        ? request.headers["x-devproof-client-version"]
        : undefined;
    const server = this.createServer(current, {
      ...(clientName ? { name: clientName } : {}),
      ...(clientVersion ? { version: clientVersion } : {}),
    });
    const apiHost = new URL(env().API_PUBLIC_URL).host;
    const transport = new StreamableHTTPServerTransport({
      allowedHosts: [apiHost],
      allowedOrigins: [env().WEB_ORIGIN],
      enableDnsRebindingProtection: true,
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    } as never);
    reply.hijack();
    try {
      await server.connect(transport as never);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await Promise.allSettled([transport.close(), server.close()]);
    }
  }

  private createServer(
    current: ToolAuthContext,
    client: { name?: string; version?: string },
  ) {
    const server = new McpServer(
      { name: "devproof-control-plane", version: "0.5.0" },
      { capabilities: { logging: {} } },
    );
    this.instrumentServer(server, current, client);

    if (current.credential.scopes.includes("run:read")) {
      server.registerResource(
        "devproof-task-tool-guide",
        "devproof://task-tools",
        {
          description:
            "Read-only guide for the unified Task control plane. Browser lifecycle is internal to DevProof.",
          mimeType: "application/json",
          title: "DevProof Task Tool Guide",
        },
        (uri) => ({
          contents: [
            {
              mimeType: "application/json",
              text: JSON.stringify(TASK_TOOL_GUIDE),
              uri: uri.href,
            },
          ],
        }),
      );
    }

    server.registerTool(
      "get_integration_status",
      {
        description:
          "Report the authenticated machine credential scopes used by this MCP connection.",
        inputSchema: { probe: z.boolean().optional() },
      },
      async () =>
        result({
          authenticated: true,
          scopes: current.credential.scopes,
          transport: "MCP",
        }),
    );

    server.registerTool(
      "create_task",
      {
        description:
          "Create one durable user-visible task. Issue tasks run tracked analysis and execution stages; direct tasks wrap one Run v2.",
        inputSchema: { request: taskExecutionCreateInputSchema },
      },
      async ({ request }) => {
        requireToolScope(current, "run:write");
        return result(await this.taskService().create(current, request));
      },
    );

    server.registerTool(
      "list_tasks",
      {
        description:
          "List user-visible task executions with their current stage, Case progress and aggregate result.",
        inputSchema: {},
      },
      async () => {
        requireToolScope(current, "run:read");
        return result(await this.taskService().list(current));
      },
    );

    server.registerTool(
      "get_task",
      {
        description:
          "Get a task with Spec analysis attempts, immutable generated Cases and linked Run v2 summaries.",
        inputSchema: { taskId: z.string().uuid() },
      },
      async ({ taskId }) => {
        requireToolScope(current, "run:read");
        return result(await this.taskService().detail(current, taskId));
      },
    );

    server.registerTool(
      "set_task_deployment_target",
      {
        description:
          "Provide the HTTP(S) deployment target for an Issue task waiting to start Spec execution.",
        inputSchema: {
          taskId: z.string().uuid(),
          ...taskDeploymentTargetInputSchema.shape,
        },
      },
      async ({ taskId, url }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.taskService().setDeploymentTarget(current, taskId, url),
        );
      },
    );

    server.registerTool(
      "retry_task_stage",
      {
        description:
          "Retry a failed Spec analysis or Spec execution dispatch stage without mutating successful historical snapshots.",
        inputSchema: {
          taskId: z.string().uuid(),
          stage: taskExecutionStageTypeSchema,
          ...taskStageRetryInputSchema.shape,
        },
      },
      async ({ reason, stage, taskId }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.taskService().retryStage(current, taskId, stage, {
            reason,
          }),
        );
      },
    );

    server.registerTool(
      "cancel_task",
      {
        description:
          "Cancel a task and fan cancellation out to every active child Run v2.",
        inputSchema: { taskId: z.string().uuid() },
      },
      async ({ taskId }) => {
        requireToolScope(current, "run:cancel");
        return result(await this.taskService().cancel(current, taskId));
      },
    );

    server.registerTool(
      "get_run",
      {
        description:
          "Get one Run v2 with attempts, Runtime tasks, criteria, evidence, browser executions, and human interventions.",
        inputSchema: { runId: z.string().uuid() },
      },
      async ({ runId }) => {
        requireToolScope(current, "run:read");
        return result(await this.runService().detail(current, runId));
      },
    );

    server.registerTool(
      "resolve_run_intervention",
      {
        description:
          "Resolve one pending Run v2 human intervention with structured human input. Browser control must be released first; DevProof requeues the same Runtime task with the response in its resume context.",
        inputSchema: {
          interventionId: z.string().uuid(),
          response: runInterventionResolveInputSchema.shape.response,
          runId: z.string().uuid(),
        },
      },
      async ({ interventionId, response, runId }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.runService().resolveIntervention(
            current,
            runId,
            interventionId,
            runInterventionResolveInputSchema.parse({ response }),
          ),
        );
      },
    );

    server.registerTool(
      "read_run_evidence",
      {
        description:
          "Read Run v2-owned Screenshot, DOM, Console or Network evidence without exposing storage credentials or signed URLs.",
        inputSchema: {
          cursor: z.coerce.number().int().min(0).default(0),
          evidenceRef: z
            .string()
            .regex(
              /^artifact:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
            ),
          maxBytes: z.coerce
            .number()
            .int()
            .min(1_000)
            .max(256 * 1_024)
            .default(96 * 1_024),
          runId: z.string().uuid(),
        },
      },
      async ({ cursor, evidenceRef, maxBytes, runId }) => {
        requireToolScope(current, "run:read");
        const evidence = await this.runService().readEvidence(
          current,
          runId,
          evidenceRef,
          { cursor, maxBytes },
        );
        const metadata = {
          contentType: evidence.contentType,
          evidenceRef: evidence.evidenceRef,
          kind: evidence.kind,
          nextCursor: evidence.nextCursor,
          totalBytes: evidence.totalBytes,
          truncated: evidence.truncated,
        };
        return evidence.contentType.startsWith("image/")
          ? {
              content: [
                { text: JSON.stringify(metadata), type: "text" as const },
                {
                  data: evidence.body.toString("base64"),
                  mimeType: evidence.contentType,
                  type: "image" as const,
                },
              ],
              structuredContent: metadata,
            }
          : {
              content: [
                { text: JSON.stringify(metadata), type: "text" as const },
                {
                  text: evidence.body.toString("utf8"),
                  type: "text" as const,
                },
              ],
              structuredContent: metadata,
            };
      },
    );

    return server;
  }

  private instrumentServer(
    server: McpServer,
    current: ToolAuthContext,
    client: { name?: string; version?: string },
  ) {
    const register = server.registerTool.bind(server);
    server.registerTool = ((
      name: string,
      config: unknown,
      callback: (...items: unknown[]) => unknown,
    ) => {
      const requiredScope = MCP_TOOL_SCOPES[name];
      if (requiredScope && !current.credential.scopes.includes(requiredScope)) {
        return undefined as never;
      }
      return register(
        name,
        config as never,
        (async (...items: unknown[]) => {
          const extra = items.at(-1) as {
            requestId?: string | number;
            signal?: AbortSignal;
          };
          const arguments_ = items.length > 1 ? items[0] : {};
          const runId =
            arguments_ &&
            typeof arguments_ === "object" &&
            "runId" in arguments_ &&
            typeof arguments_.runId === "string"
              ? arguments_.runId
              : undefined;
          const probe = Boolean(
            name === "get_integration_status" &&
            arguments_ &&
            typeof arguments_ === "object" &&
            "probe" in arguments_ &&
            arguments_.probe === true,
          );
          return this.invocations.run(
            {
              arguments: arguments_,
              ...(client.name ? { clientName: client.name } : {}),
              ...(client.version ? { clientVersion: client.version } : {}),
              current,
              ...(extra.requestId === undefined
                ? {}
                : { mcpRequestId: String(extra.requestId) }),
              ...(runId ? { runId } : {}),
              ...(probe ? { probe: true } : {}),
              toolName: name,
              transport: "MCP",
            },
            async () => {
              await server
                .sendLoggingMessage({
                  data: { event: "tool.started", toolName: name },
                  level: "debug",
                  logger: "devproof.mcp",
                })
                .catch(() => undefined);
              try {
                const value = await callback(...items);
                await server
                  .sendLoggingMessage({
                    data: { event: "tool.completed", toolName: name },
                    level: "info",
                    logger: "devproof.mcp",
                  })
                  .catch(() => undefined);
                return value;
              } catch (error) {
                await server
                  .sendLoggingMessage({
                    data: { event: "tool.failed", toolName: name },
                    level: "warning",
                    logger: "devproof.mcp",
                  })
                  .catch(() => undefined);
                throw error;
              }
            },
            extra.signal,
          );
        }) as never,
      );
    }) as typeof server.registerTool;
  }

  private runService() {
    if (!this.runs) {
      throw new Error("Run v2 control-plane service is not configured.");
    }
    return this.runs;
  }

  private taskService() {
    if (!this.tasks) {
      throw new Error(
        "Task execution control-plane service is not configured.",
      );
    }
    return this.tasks;
  }
}
