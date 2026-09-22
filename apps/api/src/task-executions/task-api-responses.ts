/** Public response documentation. Examples are synthetic and contain no team data. */
type Schema = Record<string, unknown>;
const string: Schema = { type: "string" };
const nullableString: Schema = { type: ["string", "null"] };
const uuid: Schema = { type: "string", format: "uuid" };
const date: Schema = { type: "string", format: "date-time" };
const nullableDate: Schema = { type: ["string", "null"], format: "date-time" };
const count: Schema = { type: "integer", minimum: 0 };
const bool: Schema = { type: "boolean" };
const freeObject: Schema = { type: "object", additionalProperties: true };
const array = (items: Schema): Schema => ({ type: "array", items });
const object = (
  properties: Record<string, Schema>,
  required: string[] = [],
): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
});
export const responseRef = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});
const lifecycle: Schema = {
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
  description: "执行状态。COMPLETED 不代表验证通过，还需查看 verdict。",
};
const verdict: Schema = {
  type: ["string", "null"],
  enum: ["PASSED", "FAILED", "INCONCLUSIVE", null],
};
const acceptanceVerdict: Schema = {
  type: "string",
  enum: ["PASSED", "FAILED", "INCONCLUSIVE", "PENDING"],
};
const externalReference: Schema = {
  type: ["object", "null"],
  properties: { source: string, externalId: string },
  description: "外部业务关联，与幂等键独立；没有关联时为 null。",
};
const taskId = "72b2525c-b0d7-4451-82fc-ee210541016d";
const hookId = "285146a8-5230-4b02-832a-5eef19e8dc8a";
const timestamp = "2026-09-20T08:00:00.000Z";
const issue = object({
  category: string,
  code: string,
  message: string,
  nextStep: string,
});
const countByVerdict = object({
  PASSED: count,
  FAILED: count,
  INCONCLUSIVE: count,
  PENDING: count,
  total: count,
  required: count,
});
const summary = object(
  {
    id: uuid,
    title: string,
    kind: {
      type: "string",
      enum: ["SPEC_TASK", "ISSUE_SPEC", "DIRECT_RUN", "LEGACY_RUN"],
    },
    lifecycle,
    currentStage: string,
    verdict,
    executionDisposition: nullableString,
    waitingReason: {
      ...nullableString,
      description:
        "等待原因，例如 ANALYSIS_INPUT_REQUIRED、TEST_ACCOUNTS_REQUIRED。",
    },
    externalReference,
    source: object({ kind: string, ref: nullableString }),
    createdAt: date,
    updatedAt: date,
    counts: object(
      Object.fromEntries(
        [
          "total",
          "passed",
          "failed",
          "inconclusive",
          "queued",
          "running",
          "recovering",
          "waitingHuman",
          "waiting",
          "blocked",
          "terminal",
          "timedOut",
          "cancelled",
          "dispatchFailed",
        ].map((key) => [key, count]),
      ),
    ),
  },
  ["id", "title", "kind", "lifecycle", "verdict", "counts"],
);
const taskExample = {
  id: taskId,
  title: "首页冒烟测试",
  kind: "SPEC_TASK",
  lifecycle: "QUEUED",
  currentStage: "SPEC_ANALYSIS",
  verdict: null,
  waitingReason: null,
  externalReference: { source: "ci", externalId: "build-123" },
  counts: { total: 0, passed: 0, failed: 0, queued: 0, running: 0 },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const subscription = object(
  {
    id: uuid,
    taskId: uuid,
    url: { type: "string", format: "uri" },
    events: array(string),
    disabledAt: nullableDate,
    createdAt: date,
  },
  ["id", "taskId", "url", "events", "disabledAt", "createdAt"],
);
const subscriptionExample = {
  id: hookId,
  taskId,
  url: "https://ci.example.com/devproof/events",
  events: ["task.completed", "task.waiting_input"],
  disabledAt: null,
  createdAt: timestamp,
};

export const taskApiResponseSchemas: Record<string, Schema> = {
  TaskSummary: { ...summary, example: taskExample },
  TaskDetail: {
    allOf: [
      responseRef("TaskSummary"),
      object({
        startedAt: nullableDate,
        finishedAt: nullableDate,
        deadlineAt: date,
        cancelRequestedAt: nullableDate,
        traceId: string,
        input: {
          ...freeObject,
          description: "当前任务输入，字段随 SPEC_TASK / DIRECT_RUN 模式变化。",
        },
        environment: freeObject,
        analysisInputRequest: {
          type: ["object", "null"],
          description:
            "分析需要补充信息时的请求；包含该次分析对应的 expectedAttemptId。",
          additionalProperties: true,
        },
        testAccountPreparation: {
          ...freeObject,
          description: "所需测试账号和输入修订信息。",
        },
        deployments: array(
          object({
            id: uuid,
            key: string,
            name: string,
            targetUrl: { type: "string", format: "uri" },
            enabled: bool,
            environment: freeObject,
          }),
        ),
        stages: array(
          object({
            id: uuid,
            type: string,
            status: string,
            currentAttemptNumber: count,
            maxAttempts: count,
            waitingReason: nullableString,
            startedAt: nullableDate,
            finishedAt: nullableDate,
            lastError: { description: "最后一次阶段错误；无错误时为 null。" },
            attempts: array(
              object({
                id: uuid,
                number: count,
                status: string,
                startedAt: nullableDate,
                finishedAt: nullableDate,
                error: {},
                result: {},
              }),
            ),
          }),
        ),
        runs: array(
          object({
            runId: uuid,
            lifecycle: string,
            verdict,
            currentAttemptNumber: count,
            maxAttempts: count,
            evidenceCount: count,
            interventionCount: count,
          }),
        ),
        cases: {
          ...array(freeObject),
          description: "生成的用例及各环境执行详情。",
        },
        profileBinding: {
          type: ["object", "null"],
          additionalProperties: true,
          description: "浏览器身份解析状态；可能尚未解析。",
        },
      }),
    ],
    example: {
      ...taskExample,
      deadlineAt: "2026-09-20T10:00:00.000Z",
      finishedAt: null,
      startedAt: null,
      deployments: [],
      stages: [],
      runs: [],
      cases: [],
      profileBinding: null,
    },
  },
  TaskPage: {
    ...object(
      {
        items: array(responseRef("TaskSummary")),
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 100 },
        total: count,
        totalPages: { type: "integer", minimum: 1 },
      },
      ["items", "page", "pageSize", "total", "totalPages"],
    ),
    example: {
      items: [taskExample],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    },
  },
  TaskEvent: {
    ...object(
      {
        id: uuid,
        taskExecutionId: uuid,
        sequence: {
          type: "string",
          pattern: "^[0-9]+$",
          description: "64 位事件序号，以字符串传输；用于 after 游标。",
        },
        kind: string,
        actor: string,
        payload: freeObject,
        occurredAt: date,
        createdAt: date,
      },
      ["id", "taskExecutionId", "sequence", "kind", "occurredAt"],
    ),
    example: {
      id: hookId,
      taskExecutionId: taskId,
      sequence: "123",
      kind: "task.completed",
      actor: "CONTROL_PLANE",
      payload: {},
      occurredAt: timestamp,
      createdAt: timestamp,
    },
  },
  AuthorizedProfile: {
    ...object(
      {
        id: uuid,
        displayName: string,
        status: {
          type: "string",
          enum: [
            "UNINITIALIZED",
            "PREPARING",
            "VERIFYING",
            "READY",
            "REAUTH_REQUIRED",
            "MIGRATION_REQUIRED",
            "LOST",
            "DISABLED",
          ],
        },
        siteHostname: nullableString,
      },
      ["id", "displayName", "status", "siteHostname"],
    ),
    example: {
      id: hookId,
      displayName: "测试环境登录身份",
      status: "READY",
      siteHostname: "preview.example.com",
    },
  },
  TaskAcceptanceReport: {
    ...object(
      {
        version: { type: "integer", enum: [1, 2] },
        revision: string,
        generatedAt: date,
        taskId: uuid,
        title: string,
        lifecycle,
        finishedAt: nullableDate,
        final: { ...bool, description: "是否已形成最终验收结论。" },
        verdict: acceptanceVerdict,
        aiAccepted: bool,
        summary: string,
        scope: { type: "string", enum: ["REQUIREMENT", "CASE", "DIRECT"] },
        sourceRef: nullableString,
        specificationId: nullableString,
        sourceHash: nullableString,
        pullRequestUrl: nullableString,
        coverageComplete: bool,
        counts: object({ cases: countByVerdict, criteria: countByVerdict }),
        assessment: object({
          method: { enum: ["REQUIRED_CRITERIA_V1", "REQUIRED_CRITERIA_V2"] },
          score: { type: ["number", "null"], minimum: 0, maximum: 100 },
          recommendation: {
            type: "string",
            enum: [
              "RECOMMENDED",
              "NEEDS_VALIDATION",
              "NOT_RECOMMENDED",
              "SCOPED_ONLY",
              "PENDING",
            ],
          },
          reason: string,
          passed: count,
          failed: count,
          unknown: count,
          pending: count,
          total: count,
          excluded: count,
          exclusions: array(freeObject),
          findings: array(freeObject),
        }),
        requirements: array(
          object({
            id: string,
            description: string,
            sourceRef: nullableString,
            verdict: acceptanceVerdict,
            caseIds: array(uuid),
            reason: nullableString,
          }),
        ),
        cases: array(
          object({
            caseId: string,
            name: string,
            deployment: string,
            targetUrl: nullableString,
            runId: nullableString,
            attemptNumber: { type: ["integer", "null"] },
            executionOrdinal: count,
            lifecycle: string,
            executionDisposition: nullableString,
            verdict: acceptanceVerdict,
            criteria: array(
              object({
                id: string,
                requirementId: nullableString,
                description: string,
                required: bool,
                verdict: acceptanceVerdict,
                recordedVerdict: nullableString,
                summary: string,
                evidence: array(
                  object({
                    id: string,
                    ref: string,
                    kind: string,
                    downloadPath: nullableString,
                  }),
                ),
                issues: array(issue),
              }),
            ),
            issues: array(issue),
          }),
        ),
        issues: array(issue),
        review: {
          type: "object",
          additionalProperties: true,
          description: "可选的 AI 验收复核详情。",
        },
      },
      [
        "version",
        "revision",
        "generatedAt",
        "taskId",
        "title",
        "lifecycle",
        "final",
        "verdict",
        "summary",
        "assessment",
        "counts",
        "cases",
      ],
    ),
    example: {
      version: 2,
      revision: "example-revision",
      generatedAt: timestamp,
      taskId,
      title: "首页冒烟测试",
      lifecycle: "RUNNING",
      finishedAt: null,
      final: false,
      verdict: "PENDING",
      summary: "任务正在执行，等待验收证据。",
      scope: "DIRECT",
      aiAccepted: false,
      coverageComplete: false,
      assessment: {
        method: "REQUIRED_CRITERIA_V2",
        score: null,
        recommendation: "PENDING",
        reason: "执行尚未结束。",
        passed: 0,
        failed: 0,
        unknown: 0,
        pending: 0,
        total: 0,
        excluded: 0,
        exclusions: [],
        findings: [],
      },
      counts: {
        cases: { total: 0, PASSED: 0, FAILED: 0, INCONCLUSIVE: 0, PENDING: 0 },
        criteria: {
          total: 0,
          required: 0,
          PASSED: 0,
          FAILED: 0,
          INCONCLUSIVE: 0,
          PENDING: 0,
        },
      },
      requirements: [],
      cases: [],
      issues: [],
    },
  },
  WebhookSubscription: { ...subscription, example: subscriptionExample },
  WebhookCreated: {
    allOf: [
      responseRef("WebhookSubscription"),
      object(
        {
          signingSecret: {
            type: "string",
            description: "用于验签的密钥。仅注册响应返回，列表不返回。",
          },
        },
        ["signingSecret"],
      ),
    ],
    example: {
      ...subscriptionExample,
      signingSecret: "example-only-not-a-real-secret",
    },
  },
  WebhookDelivery: {
    ...object(
      {
        id: uuid,
        eventId: uuid,
        status: {
          type: "string",
          enum: ["PENDING", "DELIVERED", "FAILED", "CANCELLED"],
        },
        attempts: count,
        nextAttemptAt: date,
        lastError: nullableString,
        deliveredAt: nullableDate,
      },
      [
        "id",
        "eventId",
        "status",
        "attempts",
        "nextAttemptAt",
        "lastError",
        "deliveredAt",
      ],
    ),
    example: {
      id: hookId,
      eventId: taskId,
      status: "DELIVERED",
      attempts: 1,
      nextAttemptAt: timestamp,
      lastError: null,
      deliveredAt: timestamp,
    },
  },
  OperationOk: {
    ...object({ ok: { const: true } }, ["ok"]),
    example: { ok: true },
  },
};
