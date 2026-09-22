import { Injectable, Optional } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  taskListQuerySchema,
  taskDeploymentsInputSchema,
  taskCaseRerunInputSchema,
  taskCasesRerunInputSchema,
  taskCasesRerunTaskInputSchema,
  taskAcceptanceReviewRerunInputSchema,
  taskTestAccountsInputSchema,
  runInterventionResolveInputSchema,
  taskDeploymentTargetInputSchema,
  taskAnalysisInputSchema,
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
    "provide_task_analysis_input",
    "set_task_deployment_target",
    "retry_task_stage",
    "cancel_task",
    "get_run",
    "resolve_run_intervention",
    "read_run_evidence",
    "list_task_events",
    "get_task_acceptance_report",
    "set_task_deployments",
    "provide_task_test_accounts",
    "rerun_task",
    "rerun_task_case",
    "rerun_task_cases",
    "rerun_task_cases_as_task",
    "rerun_task_acceptance_review",
    "list_authorized_profiles",
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
    list_authorized_profiles: "run:read",
    list_task_events: "run:read",
    get_task_acceptance_report: "run:read",
    set_task_deployments: "run:write",
    provide_task_test_accounts: "run:write",
    rerun_task: "run:write",
    rerun_task_case: "run:write",
    rerun_task_cases: "run:write",
    rerun_task_cases_as_task: "run:write",
    rerun_task_acceptance_review: "run:write",
    cancel_task: "run:cancel",
    create_task: "run:write",
    get_run: "run:read",
    get_task: "run:read",
    list_tasks: "run:read",
    provide_task_analysis_input: "run:write",
    read_run_evidence: "run:read",
    resolve_run_intervention: "run:write",
    retry_task_stage: "run:write",
    set_task_deployment_target: "run:write",
  };

const taskOutputSchema = z
  .object({
    id: z.string().uuid(),
    lifecycle: z.string(),
    kind: z.string().optional(),
    externalReference: z
      .object({ source: z.string(), externalId: z.string() })
      .nullable()
      .optional(),
  })
  .passthrough();
const taskListOutputSchema = z
  .object({
    value: z.array(taskOutputSchema).optional(),
    items: z.array(taskOutputSchema).optional(),
    page: z.number().int().optional(),
    pageSize: z.number().int().optional(),
    total: z.number().int().optional(),
    totalPages: z.number().int().optional(),
  })
  .passthrough()
  .refine((value) => Array.isArray(value.value) || Array.isArray(value.items));
const MCP_OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  get_integration_status: z.object({
    authenticated: z.literal(true),
    scopes: z.array(z.string()),
    transport: z.literal("MCP"),
  }),
  create_task: taskOutputSchema,
  get_task: taskOutputSchema,
  rerun_task: taskOutputSchema,
  rerun_task_case: taskOutputSchema,
  rerun_task_cases: taskOutputSchema,
  rerun_task_cases_as_task: taskOutputSchema,
  rerun_task_acceptance_review: taskOutputSchema,
  list_tasks: taskListOutputSchema,
  list_task_events: z.object({
    value: z.array(
      z
        .object({
          id: z.string().uuid(),
          sequence: z.string().regex(/^\d+$/u),
          kind: z.string(),
        })
        .passthrough(),
    ),
  }),
  list_authorized_profiles: z.object({
    value: z.array(
      z.object({
        id: z.string().uuid(),
        displayName: z.string(),
        status: z.string(),
        siteHostname: z.string().nullable(),
      }),
    ),
  }),
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
          "Create one durable user-visible task. Spec tasks accept an Issue, GitHub PRs or a testing brief and run tracked analysis and execution stages; direct tasks wrap one Run v2.",
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
        inputSchema: { query: taskListQuerySchema.optional() },
      },
      async ({ query }) => {
        requireToolScope(current, "run:read");
        if (!query) return result(await this.taskService().list(current));
        const { page, pageSize, createdAfter, ...filters } = query;
        return result(
          await this.taskService().listPage(current, page, pageSize, {
            ...filters,
            ...(createdAfter ? { createdAfter: new Date(createdAfter) } : {}),
          }),
        );
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
      "provide_task_analysis_input",
      {
        description:
          "Correct unreadable selected sources, clarify test intent or provide the missing environment to resume Spec analysis.",
        inputSchema: {
          taskId: z.string().uuid(),
          ...taskAnalysisInputSchema.shape,
        },
      },
      async ({ taskId, ...input }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.taskService().provideAnalysisInput(current, taskId, input),
        );
      },
    );

    server.registerTool(
      "set_task_deployment_target",
      {
        description:
          "Provide the HTTP(S) deployment target for a Spec task waiting to start Spec execution.",
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

    server.registerTool(
      "list_task_events",
      {
        description:
          "Read durable task events after a decimal sequence cursor. Persist the last returned sequence for the next poll.",
        inputSchema: {
          taskId: z.string().uuid(),
          after: z.string().regex(/^\d+$/u).optional(),
        },
      },
      async ({ taskId, after }) => {
        requireToolScope(current, "run:read");
        return result(
          await this.taskService().events(
            current,
            taskId,
            after === undefined ? undefined : BigInt(after),
          ),
        );
      },
    );
    server.registerTool(
      "get_task_acceptance_report",
      {
        description: "Read the task acceptance report.",
        inputSchema: { taskId: z.string().uuid() },
      },
      async ({ taskId }) => {
        requireToolScope(current, "run:read");
        return result(
          await this.taskService().acceptanceReport(current, taskId),
        );
      },
    );
    server.registerTool(
      "set_task_deployments",
      {
        description:
          "Update the test environment matrix before execution admission permits changes.",
        inputSchema: {
          taskId: z.string().uuid(),
          ...taskDeploymentsInputSchema.shape,
        },
      },
      async ({ taskId, ...input }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.taskService().setDeployments(current, taskId, input),
        );
      },
    );
    server.registerTool(
      "provide_task_test_accounts",
      {
        description:
          "Provide task test account bindings using the declared account schema. Do not put credentials in free-text prompts.",
        inputSchema: {
          taskId: z.string().uuid(),
          ...taskTestAccountsInputSchema.shape,
        },
      },
      async ({ taskId, ...input }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.taskService().provideTestAccounts(current, taskId, input),
        );
      },
    );
    server.registerTool(
      "rerun_task",
      {
        description:
          "Create a new task from an existing task. Each successful call starts a new rerun; do not blindly retry after an ambiguous response.",
        inputSchema: { taskId: z.string().uuid() },
      },
      async ({ taskId }) => {
        requireToolScope(current, "run:write");
        return result(await this.taskService().rerun(current, taskId));
      },
    );
    server.registerTool(
      "rerun_task_case",
      {
        description:
          "Rerun a case, optionally in one deployment, with an idempotency key.",
        inputSchema: {
          taskId: z.string().uuid(),
          caseId: z.string().uuid(),
          deploymentId: z.string().uuid().optional(),
          ...taskCaseRerunInputSchema.shape,
        },
      },
      async ({ taskId, caseId, deploymentId, ...input }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.taskService().rerunCase(
            current,
            taskId,
            caseId,
            deploymentId,
            input,
          ),
        );
      },
    );
    server.registerTool(
      "rerun_task_cases",
      {
        description:
          "Rerun several cases in place under the same task with one idempotency key. Cases that depend on other cases must be rerun in the same batch.",
        inputSchema: {
          taskId: z.string().uuid(),
          deploymentId: z.string().uuid().optional(),
          ...taskCasesRerunInputSchema.shape,
        },
      },
      async ({ taskId, deploymentId, ...input }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.taskService().rerunCases(
            current,
            taskId,
            input,
            deploymentId,
          ),
        );
      },
    );
    server.registerTool(
      "rerun_task_cases_as_task",
      {
        description:
          "Create a new task that reruns the selected cases with their original Spec, skipping Spec analysis.",
        inputSchema: {
          taskId: z.string().uuid(),
          ...taskCasesRerunTaskInputSchema.shape,
        },
      },
      async ({ taskId, ...input }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.taskService().rerunCasesAsTask(current, taskId, input),
        );
      },
    );
    server.registerTool(
      "rerun_task_acceptance_review",
      {
        description:
          "Regenerate the AI acceptance review for a terminal task. Evidence scores and release gates are preserved by the control plane.",
        inputSchema: {
          taskId: z.string().uuid(),
          ...taskAcceptanceReviewRerunInputSchema.shape,
        },
      },
      async ({ taskId, ...input }) => {
        requireToolScope(current, "run:write");
        return result(
          await this.taskService().rerunAcceptanceReview(
            current,
            taskId,
            input,
          ),
        );
      },
    );
    server.registerTool(
      "list_authorized_profiles",
      {
        description:
          "List browser identities whose owners authorized this service token. Use an ID with EXPLICIT_PROFILE; normal site and entry grants still apply.",
        inputSchema: {},
      },
      async () => {
        requireToolScope(current, "run:read");
        return result(await this.taskService().authorizedProfiles(current));
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
        {
          ...(config as Record<string, unknown>),
          ...(MCP_OUTPUT_SCHEMAS[name]
            ? { outputSchema: MCP_OUTPUT_SCHEMAS[name] }
            : {}),
        } as never,
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
