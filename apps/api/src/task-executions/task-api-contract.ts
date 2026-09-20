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

const taskResponse = {
  type: "object",
  required: ["id", "kind", "lifecycle"],
  properties: {
    id: { type: "string", format: "uuid" },
    kind: { type: "string" },
    lifecycle: {
      type: "string",
      enum: [
        "QUEUED",
        "RUNNING",
        "WAITING_INPUT",
        "WAITING_HUMAN",
        "COMPLETED",
        "CANCELLED",
        "TIMED_OUT",
      ],
    },
    verdict: { type: ["string", "null"] },
    waitingReason: { type: ["string", "null"] },
    externalReference: {
      type: ["object", "null"],
      properties: {
        source: { type: "string" },
        externalId: { type: "string" },
      },
    },
  },
  additionalProperties: true,
};
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
  return {
    openapi: "3.1.0",
    info: {
      title: "DevProof external task API",
      version: "1.0.0",
      description:
        "Stable task integration entry points. Additional response fields may be added. MCP is an adapter over the same task services.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    paths,
  };
}
