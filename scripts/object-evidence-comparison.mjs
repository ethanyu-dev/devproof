/** Real model + Chromium + API binding service; isolated in-memory persistence.
 * Does not create or edit console tasks. See docs/browser-verification-implementation-log.md.
 */
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { PrismaService } from "../apps/api/dist/database/prisma.service.js";
import { CredentialCipherService } from "../apps/api/dist/security/credential-cipher.service.js";
import { ObservationBindingService } from "../apps/api/dist/agent-runtime/observation-binding.service.js";
import { BrowserSessionManager } from "../apps/browser-runtime/dist/index.js";
import { startSsrfProxy } from "../apps/browser-runtime/dist/ssrf-proxy.js";
import { BrowserVerificationExecutor } from "../apps/agent-runtime/dist/browser-verification.executor.js";
import { createChatCompletionsClient } from "../apps/agent-runtime/dist/model-client.js";
import {
  createModelFetch,
  parseModelHostAllowlist,
} from "../apps/agent-runtime/dist/model-network-policy.js";
import {
  runtimeTaskSnapshotSchema,
  observationContractSchema,
} from "../packages/agent-runtime-protocol/dist/index.js";
import {
  observationDigest,
  freezeObservationContract,
} from "../packages/agent-runtime-protocol/dist/observation-digest.js";
import { summarizeEvents } from "./local-browser/metrics.mjs";

const option = (key, fallback) => {
  const i = process.argv.indexOf(`--${key}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const sourceRun = option("source-run", undefined);
if (!sourceRun)
  throw new Error(
    "--source-run requires an existing local run to select its configured team model.",
  );
const mode = option("mode", "focus");
if (!["base", "combined", "focus", "delta"].includes(mode))
  throw new Error("Unknown mode.");
const negative = process.argv.includes("--negative");
const db = new PrismaService();
let candidate, teamId;
try {
  const source = await db.executionRun.findUniqueOrThrow({
    where: { id: sourceRun },
    select: { teamId: true },
  });
  teamId = source.teamId;
  const model = await db.agentModelConfiguration.findFirstOrThrow({
    where: { teamId, pool: "BROWSER_EXECUTION" },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  candidate = {
    apiKey: new CredentialCipherService().decrypt(model.apiKeyEncrypted),
    baseUrl: model.baseUrl,
    modelId: model.modelId,
    displayName: model.displayName,
  };
} finally {
  await db.$disconnect();
}
const names = ["合规模型映射", "旧版对公转账白名单", "零数据留存 (ZDR)"];
const contract = freezeObservationContract(
  observationContractSchema.parse({
    version: 2,
    targets: names.map((name, i) => ({
      targetId: `type-${i}`,
      label: name,
      scope: { kind: "DIALOG", names: ["新增用户白名单"] },
      entity: {
        controlKind: "SELECT",
        label: "白名单类型",
        property: "SELECTED_LABEL",
        oneOf: [name],
      },
      phase: "INITIAL_AFTER_OPEN",
      assertions: [
        {
          assertionId: "enabled",
          subject: { kind: "SWITCH", label: "启用状态" },
          property: "CHECKED",
          operator: "EQ",
          expected: true,
        },
      ],
      requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
      temporal: "SAME_OBSERVATION",
    })),
    comparisons: [0, 1].map((i) => ({
      comparisonId: `compare-${i}`,
      subjectTargetId: `type-${i}`,
      referenceTargetId: "type-2",
      dimensions: ["开关形式"],
      sourceRef: "analysis-source://fixture",
      quote: "开关形式与参照一致",
    })),
  }),
  "defaults",
);
let html = await readFile(
  new URL(
    "../apps/browser-runtime/src/fixtures/object-evidence.html",
    import.meta.url,
  ),
  "utf8",
);
html += `<script>document.querySelector('#open').onclick=()=>{document.querySelector('#type').value='${names[0]}';document.querySelector('#enabled').setAttribute('aria-checked','true');document.querySelector('dialog').showModal()};document.querySelector('#type').onchange=()=>document.querySelector('#enabled').setAttribute('aria-checked',${negative ? "document.querySelector('#type').value==='旧版对公转账白名单'?'false':'true'" : "'true'"});</script>`;
const server = createServer((_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const proxy = await startSsrfProxy({ allowlist: new Set(["127.0.0.1"]) });
const manager = new BrowserSessionManager(
  {
    removeSession: async () => {},
    replaceSession: async () => {},
    value: () => ({ sessions: [] }),
  },
  proxy.server,
  () => {},
  () => {},
);
const taskId = randomUUID(),
  runId = randomUUID(),
  attemptId = randomUUID(),
  leaseToken = randomUUID(),
  sessionId = randomUUID();
const deadlineAt = new Date(Date.now() + 600_000).toISOString();
const snapshot = runtimeTaskSnapshotSchema.parse({
  runId,
  attemptId,
  attemptNumber: 1,
  teamId,
  traceId: "f".repeat(32),
  deadlineAt,
  goal: "验证三种白名单类型的默认开启状态，前两种的开关形式与 ZDR 一致。每个类型都必须重新打开弹窗、选择类型、观察默认状态、关闭弹窗，不要手动改变开关。只观察，不提交新增记录。按契约提交验收，保存截图并实际比较。",
  environment: { targetUrl: origin },
  criteria: [
    {
      id: "defaults",
      description: "三种类型默认开启；前两种开关形式与 ZDR 一致。",
      observationContract: contract,
      requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
    },
  ],
  modelCandidates: [candidate],
  executionPolicy: {
    browser: { profile: { mode: "EPHEMERAL" } },
    combinedObservation: mode !== "base",
    observationFocus: ["focus", "delta"].includes(mode),
    observationDelta: mode === "delta",
    formSequences: false,
  },
});
const task = {
  id: taskId,
  runId,
  attemptId,
  snapshot,
  fencingToken: 1n,
  leaseToken,
  leaseOwner: "fixture",
  leaseExpiresAt: new Date(deadlineAt),
  status: "RUNNING",
};
const bindings = [],
  events = [],
  evidence = [],
  commands = new Map(),
  storage = new Map(),
  trace = [],
  operations = [];
const matches = (row, where) =>
  Object.entries(where ?? {}).every(([key, value]) =>
    value && typeof value === "object"
      ? "in" in value
        ? value.in.includes(row[key])
        : "gt" in value
          ? row[key] > value.gt
          : value.path
            ? value.path.reduce((v, k) => v?.[k], row[key]) === value.equals
            : false
      : row[key] === value,
  );
const find = (rows, args) =>
  rows
    .filter((row) => matches(row, args.where))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, args.take ?? rows.length);
const prisma = {
  agentRuntimeTask: { findFirst: async () => task },
  runObservationBinding: {
    createMany: async ({ data }) => {
      for (const row of data)
        if (
          !bindings.some((b) =>
            ["attemptId", "targetId", "contractDigest", "observationId"].every(
              (k) => b[k] === row[k],
            ),
          )
        )
          bindings.push(row);
    },
    findUniqueOrThrow: async ({ where }) =>
      bindings.find((b) =>
        matches(b, where.attemptId_targetId_contractDigest_observationId),
      ),
    findMany: async (args) => find(bindings, args),
    count: async (args) => find(bindings, args).length,
  },
  runEvent: {
    create: async ({ data }) => {
      events.push(data);
      return data;
    },
    createMany: async ({ data }) => {
      for (const row of data)
        if (!events.some((e) => e.id === row.id)) events.push(row);
    },
    findFirst: async (args) => find(events, args)[0],
    findMany: async (args) => find(events, args),
    count: async (args) => find(events, args).length,
  },
  runEvidence: {
    findMany: async (args) => find(evidence, args),
    findFirst: async (args) => {
      const row = find(evidence, args)[0];
      if (row?.runtimeArtifact)
        row.runtimeArtifact.command = commands.get(
          row.runtimeArtifact.commandId,
        );
      return row;
    },
  },
};
prisma.$transaction = async (fn) => fn(prisma);
const service = new ObservationBindingService(prisma, {
  get: async (key) => ({ body: storage.get(key) }),
});
const execute = async (command) => {
  const id = randomUUID();
  operations.push({
    commandType: command.commandType,
    after: Boolean(command.after),
  });
  try {
    const output = await manager.execute({
      ...command,
      commandId: id,
      sessionId,
      leaseToken,
      fencingToken: "1",
      deadlineAt: new Date(
        Math.min(Date.parse(deadlineAt), Date.now() + 20_000),
      ).toISOString(),
      type: "command.execute",
    });
    const artifacts = (output.artifacts ?? []).map((a) => {
      const id = randomUUID(),
        body = Buffer.from(a.dataBase64, "base64");
      storage.set(id, body);
      const artifact = {
        id,
        kind: a.kind,
        metadata: a.metadata,
        contentType: a.contentType,
        storageKey: id,
        byteSize: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
      };
      evidence.push({
        id: randomUUID(),
        runId,
        attemptId,
        externalId: `artifact://${id}`,
        kind: a.kind,
        runtimeArtifactId: id,
        runtimeArtifact: artifact,
        metadata: a.metadata,
      });
      return artifact;
    });
    const saved = { id, ownerTaskId: taskId, status: "SUCCEEDED", artifacts };
    commands.set(id, saved);
    artifacts.forEach((a) => (a.commandId = id));
    const boundEvidence = await service.capture(task, saved);
    const shot = [...artifacts]
      .reverse()
      .find((a) => a.kind === "SCREENSHOT" && a.metadata?.visualObservation);
    return {
      status: "SUCCEEDED",
      result: output.result,
      artifacts,
      boundEvidence,
      ...(shot
        ? {
            visualObservation: {
              ...shot.metadata.visualObservation,
              artifactId: shot.id,
              contentType: shot.contentType,
              dataBase64: storage.get(shot.id).toString("base64"),
            },
          }
        : {}),
    };
  } catch (error) {
    operations.at(-1).error = String(error).slice(0, 700);
    return {
      status: "FAILED",
      error: {
        code: "FIXTURE_COMMAND_FAILED",
        message: String(error).slice(0, 700),
      },
    };
  }
};
let closed = false;
const controlPlane = {
  acquireBrowser: async () => {
    await execute({
      commandType: "session.open",
      payload: {
        allowedOrigins: [origin],
        profileMode: "EPHEMERAL",
        profileKey: `fixture-${runId}`,
      },
    });
    return {
      status: "ACQUIRED",
      browserExecutionId: randomUUID(),
      expiresAt: deadlineAt,
      fencingToken: "1",
      leaseId: randomUUID(),
      runnerId: randomUUID(),
      runnerKind: "BROWSER",
    };
  },
  releaseBrowser: async () => {
    await manager.close(sessionId);
    closed = true;
    return { released: true };
  },
  browserCommand: async (_lease, command) => execute(command),
  appendEvent: async (_lease, kind, payload) => {
    trace.push({ kind, payload });
    if (kind === "execution.checkpoint" && payload.verificationCheckpoint) {
      const p = payload.verificationCheckpoint;
      await service.validateReferences(
        task,
        p.bindingIds ?? [],
        p.comparisonReviewIds ?? [],
      );
      await service.validate(task, p.criteria ?? []);
    }
    return {};
  },
  observationOperation: async (_lease, operation, input) =>
    operation === "images"
      ? service.images(task, input.bindingIds)
      : service[operation](task, input),
};
const modelFetch = createModelFetch(
  parseModelHostAllowlist(process.env.DEVPROOF_AGENT_MODEL_HOST_ALLOWLIST),
);
const executor = new BrowserVerificationExecutor(
  (c) => createChatCompletionsClient(c, modelFetch),
  controlPlane,
  60,
  { mode: "BOUNDED", toolSurfaceMode: "GROUPED" },
);
const started = Date.now();
let outcome, error;
console.log(
  JSON.stringify({
    event: "started",
    mode,
    negative,
    model: candidate.modelId,
  }),
);
try {
  outcome = await executor.execute(
    {
      taskId,
      snapshot,
      fencingToken: "1",
      leaseToken,
      leaseExpiresAt: deadlineAt,
    },
    { taskId, fencingToken: "1", leaseToken, workerId: "fixture" },
    AbortSignal.timeout(600_000),
  );
  if (outcome.criteria) await service.validate(task, outcome.criteria);
} catch (failure) {
  error = String(failure).slice(0, 1500);
} finally {
  try {
    await manager.close(sessionId);
    closed = true;
  } catch (failure) {
    closed = false;
    error = `CLEANUP_FAILED: ${String(failure).slice(0, 1000)}`;
  }
  await proxy.stop();
  await new Promise((resolve) => server.close(resolve));
}
const report = {
  mode,
  negative,
  model: candidate.modelId,
  contractDigest: observationDigest(contract),
  sourceRun,
  persistence: "ISOLATED_MEMORY",
  buildDigests: Object.fromEntries(
    await Promise.all(
      [
        "apps/api/dist/agent-runtime/observation-binding.service.js",
        "apps/agent-runtime/dist/browser-verification.executor.js",
        "apps/browser-runtime/dist/index.js",
      ].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(new URL(`../${path}`, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  ),
  elapsedMs: Date.now() - started,
  ...summarizeEvents(trace),
  outcome,
  error,
  closed,
  bindings: bindings.length,
  reviews: events.filter((e) => e.kind === "observation.visual.reviewed")
    .length,
  operations,
  toolResults: trace
    .filter((e) => e.kind === "agent.tool.completed")
    .map((e) => ({
      name: e.payload.name,
      outputPreview: e.payload.outputPreview,
      errorMessage: e.payload.errorMessage,
    })),
};
await mkdir(new URL("../release/object-evidence/", import.meta.url), {
  recursive: true,
});
const path = new URL(
  `../release/object-evidence/${mode}-${negative ? "negative" : "positive"}-${started}.json`,
  import.meta.url,
);
await writeFile(path, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    event: "completed",
    file: path.pathname,
    mode,
    negative,
    elapsedMs: report.elapsedMs,
    modelCalls: report.modelCalls,
    browserCalls: operations.length,
    outcome: outcome?.verdict ?? outcome?.kind,
    error,
    closed,
  }),
);
if (error || outcome?.verdict !== (negative ? "FAILED" : "PASSED"))
  process.exitCode = 1;
