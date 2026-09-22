import { responseRef, taskApiResponseSchemas } from "./task-api-responses.js";
import { z } from "zod";
import {
  taskExecutionCreateInputSchema,
  taskListQuerySchema,
  taskAnalysisInputSchema,
  taskDeploymentsInputSchema,
  taskDeploymentTargetInputSchema,
  taskStageRetryInputSchema,
  taskCaseRerunInputSchema,
  taskTestAccountsInputSchema,
  taskWebhookCreateInputSchema,
  runInterventionResolveInputSchema,
} from "@devproof/contracts";

const taskResponse = responseRef("TaskDetail");
const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
const objectResult = { type: "object", additionalProperties: true };

/** Runtime-generated input contracts stay in sync with the actual validators. */
export function taskApiContract() {
  const paths: Record<string, Record<string, unknown>> = {};
  function route(
    method: string,
    path: string,
    operationId: string,
    scope: string,
    input?: z.ZodType,
    output: unknown = objectResult,
    status = 200,
    description = "",
  ) {
    const parameters = [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema:
        match[1] === "stage"
          ? {
              type: "string",
              enum: ["SPEC_ANALYSIS", "PROFILE_RESOLUTION", "SPEC_EXECUTION"],
            }
          : { type: "string", format: "uuid" },
    }));
    paths[path] ??= {};
    paths[path]![method] = {
      operationId,
      summary: operationId,
      description,
      security: [{ bearerAuth: [] }],
      "x-required-scope": scope,
      parameters,
      ...(input
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: jsonSchema(input) } },
            },
          }
        : {}),
      responses: {
        [status]: {
          description:
            status === 202
              ? "Accepted; execution continues asynchronously."
              : "Success",
          content: { "application/json": { schema: output } },
        },
        "400": {
          description:
            "Invalid parameters. Schema validation returns error=VALIDATION_ERROR and issues.",
        },
        "401": { description: "Missing, expired or revoked bearer token." },
        "403": {
          description: "Missing scope or browser identity authorization.",
        },
        "404": { description: "Resource not found in this team." },
        "409": {
          description:
            "State conflict or idempotency key reused with different input.",
        },
      },
    };
  }
  route(
    "post",
    "/v2/tasks",
    "createTask",
    "run:write",
    taskExecutionCreateInputSchema,
    taskResponse,
    202,
    "SPEC_TASK requires at least one of goal, issueRef or pullRequestUrls. EXPLICIT_PROFILE requires profileId and an owner-issued service-token grant. Reuse idempotencyKey only for retries of identical input.",
  );
  route(
    "get",
    "/v2/tasks",
    "listTasks",
    "run:read",
    undefined,
    {
      oneOf: [
        { type: "array", items: taskResponse },
        {
          type: "object",
          required: ["items", "page", "pageSize", "total", "totalPages"],
          properties: {
            items: { type: "array", items: taskResponse },
            page: { type: "integer" },
            pageSize: { type: "integer" },
            total: { type: "integer" },
            totalPages: { type: "integer" },
          },
        },
      ],
    },
    200,
    "Without query parameters returns the legacy array (up to 100). With any supported query parameter returns a paginated object. Pass page=1 for the recommended format.",
  );
  const query = jsonSchema(taskListQuerySchema);
  (paths["/v2/tasks"]!.get as Record<string, unknown>).parameters =
    Object.entries(query.properties ?? {}).map(([name, schema]) => ({
      name,
      in: "query",
      schema,
    }));
  route(
    "get",
    "/v2/tasks/authorized-profiles",
    "listAuthorizedProfiles",
    "run:read",
    undefined,
    { type: "array", items: objectResult },
  );
  route(
    "get",
    "/v2/tasks/{id}",
    "getTask",
    "run:read",
    undefined,
    taskResponse,
  );
  route(
    "get",
    "/v2/tasks/{id}/events",
    "listTaskEvents",
    "run:read",
    undefined,
    { type: "array", items: objectResult },
  );
  route(
    "get",
    "/v2/tasks/{id}/metrics",
    "getTaskMetrics",
    "run:read",
    undefined,
    objectResult,
    200,
    "Per-model input/output/cache usage and exclusive elapsed-time breakdown. Counts are decimal strings; missing usage is null. Includes execution and AI review usage, while elapsed time ends at task completion.",
  );
  for (const [suffix, operation] of [
    ["model-calls", "listTaskModelCalls"],
    ["timeline", "listTaskMetricTimeline"],
  ]) {
    const path = `/v2/tasks/{id}/metrics/${suffix}`;
    route(
      "get",
      path,
      operation!,
      "run:read",
      undefined,
      objectResult,
      200,
      "Cursor-paginated task metrics. nextCursor is null on the final page.",
    );
    (paths[path]!.get as { parameters: unknown[] }).parameters.push({
      name: "after",
      in: "query",
      schema: { type: "string", maxLength: 500 },
    });
    if (suffix === "timeline")
      (paths[path]!.get as { parameters: unknown[] }).parameters.push({
        name: "runtime",
        in: "query",
        schema: { type: "string", enum: ["SPEC_ANALYSIS", "BROWSER"] },
      });
  }
  const eventOp = paths["/v2/tasks/{id}/events"]!.get as {
    parameters: unknown[];
  };
  eventOp.parameters.push({
    name: "after",
    in: "query",
    schema: { type: "string", pattern: "^[0-9]+$" },
    description:
      "Last consumed event sequence; serialized as a string to preserve 64-bit precision.",
  });
  route(
    "get",
    "/v2/tasks/{id}/acceptance-report",
    "getTaskAcceptanceReport",
    "run:read",
  );
  route(
    "post",
    "/v2/tasks/{id}/analysis-input",
    "provideTaskAnalysisInput",
    "run:write",
    taskAnalysisInputSchema,
    objectResult,
    201,
  );
  route(
    "post",
    "/v2/tasks/{id}/deployment-target",
    "setTaskDeploymentTarget",
    "run:write",
    taskDeploymentTargetInputSchema,
    objectResult,
    201,
  );
  route(
    "post",
    "/v2/tasks/{id}/deployments",
    "setTaskDeployments",
    "run:write",
    taskDeploymentsInputSchema,
    objectResult,
    201,
  );
  route(
    "post",
    "/v2/tasks/{id}/test-accounts",
    "provideTaskTestAccounts",
    "run:write",
    taskTestAccountsInputSchema,
    objectResult,
    201,
  );
  route(
    "post",
    "/v2/tasks/{id}/stages/{stage}/retry",
    "retryTaskStage",
    "run:write",
    taskStageRetryInputSchema,
    objectResult,
    201,
  );
  route(
    "post",
    "/v2/tasks/{id}/cases/{caseId}/rerun",
    "rerunTaskCase",
    "run:write",
    taskCaseRerunInputSchema,
    objectResult,
    201,
  );
  route(
    "post",
    "/v2/tasks/{id}/cases/{caseId}/deployments/{deploymentId}/rerun",
    "rerunTaskCaseDeployment",
    "run:write",
    taskCaseRerunInputSchema,
    objectResult,
    201,
  );
  route(
    "post",
    "/v2/tasks/{id}/rerun",
    "rerunTask",
    "run:write",
    undefined,
    objectResult,
    201,
    "Each successful request creates a new rerun. Do not automatically retry after an ambiguous response.",
  );
  route(
    "post",
    "/v2/tasks/{id}/cancel",
    "cancelTask",
    "run:cancel",
    undefined,
    objectResult,
    201,
  );
  route("get", "/v2/runs/{id}", "getRun", "run:read");
  route(
    "post",
    "/v2/runs/{id}/interventions/{interventionId}/resolve",
    "resolveRunIntervention",
    "run:write",
    runInterventionResolveInputSchema,
    objectResult,
    201,
  );
  route(
    "post",
    "/v2/tasks/{taskId}/webhooks",
    "subscribeTaskWebhook",
    "run:write + run:read",
    taskWebhookCreateInputSchema,
    objectResult,
    201,
    "HTTP(S) destinations are unrestricted by default, including local and private networks. A nonempty TASK_WEBHOOK_ALLOWED_ORIGINS restricts exact origins. Returns signingSecret to the subscribing token. Same task/token/URL reuses the subscription. Replays matching durable events, including events before subscription.",
  );
  route(
    "get",
    "/v2/tasks/{taskId}/webhooks",
    "listTaskWebhooks",
    "run:read",
    undefined,
    { type: "array", items: objectResult },
  );
  route(
    "delete",
    "/v2/tasks/{taskId}/webhooks/{id}",
    "disableTaskWebhook",
    "run:write",
  );
  route(
    "get",
    "/v2/tasks/{taskId}/webhooks/{id}/deliveries",
    "listTaskWebhookDeliveries",
    "run:read",
    undefined,
    { type: "array", items: objectResult },
  );
  route(
    "post",
    "/v2/tasks/{taskId}/webhooks/{id}/deliveries/{deliveryId}/retry",
    "retryTaskWebhookDelivery",
    "run:write",
    undefined,
    objectResult,
    201,
  );
  const summaries: Record<string, string> = {
    createTask: "创建并派发任务",
    listTasks: "分页查询任务",
    getTask: "查看任务详情",
    listTaskEvents: "读取任务事件",
    getTaskAcceptanceReport: "读取验收报告",
    listAuthorizedProfiles: "查询已授权浏览器身份",
    provideTaskAnalysisInput: "补充分析信息",
    setTaskDeploymentTarget: "设置测试地址",
    setTaskDeployments: "更新测试环境",
    provideTaskTestAccounts: "补充测试账号",
    retryTaskStage: "重试任务阶段",
    rerunTaskCase: "重跑单个用例",
    rerunTaskCaseDeployment: "重跑指定环境的用例",
    rerunTask: "重新创建一轮任务",
    cancelTask: "取消任务",
    getRun: "查看单次执行",
    resolveRunIntervention: "提交人工处理结果",
    subscribeTaskWebhook: "订阅任务回调",
    listTaskWebhooks: "查询回调订阅",
    disableTaskWebhook: "停用回调订阅",
    listTaskWebhookDeliveries: "查询回调投递记录",
    retryTaskWebhookDelivery: "重试失败的回调",
  };
  const responseNames: Record<string, string> = {
    createTask: "TaskDetail",
    getTask: "TaskDetail",
    getTaskAcceptanceReport: "TaskAcceptanceReport",
    listTaskEvents: "TaskEvent[]",
    listAuthorizedProfiles: "AuthorizedProfile[]",
    subscribeTaskWebhook: "WebhookCreated",
    listTaskWebhooks: "WebhookSubscription[]",
    listTaskWebhookDeliveries: "WebhookDelivery[]",
    disableTaskWebhook: "OperationOk",
    retryTaskWebhookDelivery: "OperationOk",
    provideTaskAnalysisInput: "TaskDetail",
    setTaskDeploymentTarget: "TaskDetail",
    setTaskDeployments: "TaskDetail",
    provideTaskTestAccounts: "TaskDetail",
    retryTaskStage: "TaskDetail",
    rerunTaskCase: "TaskDetail",
    rerunTaskCaseDeployment: "TaskDetail",
    rerunTask: "TaskDetail",
    cancelTask: "TaskDetail",
  };
  for (const [path, methods] of Object.entries(paths)) {
    for (const operation of Object.values(methods)) {
      const op = operation as {
        operationId: string;
        summary: string;
        description: string;
        tags?: string[];
        responses: Record<
          string,
          { content?: Record<string, { schema: unknown }> }
        >;
      };
      op.summary = summaries[op.operationId] ?? op.operationId;
      op.tags = [
        path.includes("webhooks")
          ? "事件回调"
          : path.includes("authorized-profiles")
            ? "浏览器身份"
            : path.startsWith("/v2/runs")
              ? "执行与人工处理"
              : "任务",
      ];
      const scope = (operation as Record<string, unknown>)["x-required-scope"];
      op.description = `所需权限：${scope}。\n\n${op.description}`;
      const name = responseNames[op.operationId];
      for (const [status, response] of Object.entries(op.responses)) {
        if (status.startsWith("2") && name && response.content)
          response.content["application/json"]!.schema = name.endsWith("[]")
            ? { type: "array", items: responseRef(name.slice(0, -2)) }
            : responseRef(name);
      }
    }
  }
  const list = paths["/v2/tasks"]!.get as {
    responses: Record<string, { content: Record<string, { schema: unknown }> }>;
  };
  list.responses["200"]!.content["application/json"]!.schema = {
    oneOf: [
      { type: "array", items: responseRef("TaskSummary") },
      responseRef("TaskPage"),
    ],
  };
  const create = paths["/v2/tasks"]!.post as {
    requestBody: { content: Record<string, Record<string, unknown>> };
  };
  create.requestBody.content["application/json"]!.example = {
    kind: "SPEC_TASK",
    idempotencyKey: "ci-build-123-attempt-1",
    externalReference: { source: "ci", externalId: "build-123" },
    goal: "检查首页加载、主要导航和控制台错误。",
    targetUrl: "https://preview.example.com",
    profilePolicy: { strategy: "EPHEMERAL" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "DevProof 对外任务 API",
      version: "1.0.0",
      description:
        "Stable task integration entry points. Additional response fields may be added. MCP is an adapter over the same task services.",
    },
    servers: [{ url: "/" }],
    components: {
      schemas: taskApiResponseSchemas,
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    paths,
  };
}
