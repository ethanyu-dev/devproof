/** Actual configured Spec model, fixture source facts, production schema/catalog.
 * No console tasks or business records are changed. At most three model calls.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PrismaService } from "../apps/api/dist/database/prisma.service.js";
import { CredentialCipherService } from "../apps/api/dist/security/credential-cipher.service.js";
import { createChatCompletionsClient } from "../apps/agent-runtime/dist/model-client.js";
import {
  createModelFetch,
  parseModelHostAllowlist,
} from "../apps/agent-runtime/dist/model-network-policy.js";
import {
  SpecCheckCatalog,
  defineChecksSchema,
} from "../apps/agent-runtime/dist/spec-check-catalog.js";
import { OBSERVATION_CONTRACT_GUIDANCE } from "../packages/agent-runtime-protocol/dist/index.js";
const { z } = createRequire(
  new URL("../apps/agent-runtime/package.json", import.meta.url),
)("zod");
const sourceRun = process.argv[2];
if (!sourceRun)
  throw new Error(
    "Usage: node scripts/object-evidence-spec-smoke.mjs SOURCE_RUN",
  );
const db = new PrismaService();
let candidate;
try {
  const { teamId } = await db.executionRun.findUniqueOrThrow({
    where: { id: sourceRun },
    select: { teamId: true },
  });
  const model = await db.agentModelConfiguration.findFirstOrThrow({
    where: { teamId, pool: "SPEC_ANALYSIS" },
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
const sourceRef = "analysis-source://fixture/requirement";
const quote =
  "新增合规模型映射、旧版对公转账白名单，默认启用，开关形式与零数据留存 (ZDR) 一致。";
const sourceContents = new Map([
  [
    sourceRef,
    quote +
      ' 界面名称：弹窗标题="新增用户白名单"；选择器 label="白名单类型"；Switch label="启用状态"。',
  ],
]);
const requirements = [
  { id: "requirement-1", description: quote, sourceRef, quote },
];
const client = createChatCompletionsClient(
  candidate,
  createModelFetch(
    parseModelHostAllowlist(process.env.DEVPROOF_AGENT_MODEL_HOST_ALLOWLIST),
  ),
);
const catalog = new SpecCheckCatalog();
const messages = [
  {
    role: "system",
    content:
      "你是 DevProof Spec 分析 Agent。只基于已提供的 fixture 来源生成默认状态和样式比较验收。必须调用 define_checks。\n" +
      OBSERVATION_CONTRACT_GUIDANCE,
  },
  {
    role: "user",
    content: JSON.stringify({
      requirements,
      sources: [...sourceContents],
      instruction:
        "为两个新增类型与参照类型分别声明对象目标；默认启用状态和两组开关形式比较全部保留。requirementId 使用 requirement-1。",
    }),
  },
];
const attempts = [];
let passed = false;
for (let i = 0; i < 3; i++) {
  const response = await client.complete(
    {
      model: candidate.modelId,
      messages,
      tools: [
        {
          type: "function",
          function: {
            name: "define_checks",
            description: "登记验收标准，失败时返回具体字段错误。",
            parameters: z.toJSONSchema(defineChecksSchema),
          },
        },
      ],
    },
    { signal: AbortSignal.timeout(120_000), timeoutMs: 120_000 },
  );
  messages.push(response.message);
  for (const call of response.message.tool_calls ?? []) {
    let result;
    try {
      result = catalog.define(
        JSON.parse(call.function.arguments),
        requirements,
        sourceContents,
      );
    } catch (error) {
      result = { accepted: false, error: String(error).slice(0, 1000) };
    }
    attempts.push({ input: JSON.parse(call.function.arguments), result });
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(result),
    });
    if (result.accepted) {
      const checks = catalog.expand(
        {
          summary: "对象默认状态与样式契约 smoke",
          cases: [
            {
              name: "默认状态与比较",
              steps: ["分别新开弹窗并选择每个类型，取证后关闭。"],
              checkIds: catalog.ids,
              accountRequirements: [],
            },
          ],
        },
        requirements,
      ).cases[0].criteria;
      const contracts = checks
        .map((c) => c.observationContract)
        .filter(Boolean);
      passed =
        contracts.length > 0 &&
        contracts.reduce((n, c) => n + c.comparisons.length, 0) >= 2 &&
        ["合规模型映射", "旧版对公转账白名单"].every((name) =>
          contracts.some((c) =>
            c.targets.some(
              (t) =>
                t.entity.oneOf.includes(name) &&
                t.phase === "INITIAL_AFTER_OPEN" &&
                t.assertions.some(
                  (a) =>
                    a.subject.label === "启用状态" &&
                    a.property === "CHECKED" &&
                    a.operator === "EQ" &&
                    a.expected === true,
                ),
            ),
          ),
        ) &&
        contracts.some((c) =>
          c.targets.some((t) => t.entity.oneOf.includes("零数据留存 (ZDR)")),
        );
    }
  }
  if (passed) break;
}
await mkdir(new URL("../release/object-evidence/", import.meta.url), {
  recursive: true,
});
const file = new URL(
  `../release/object-evidence/spec-smoke-${Date.now()}.json`,
  import.meta.url,
);
await writeFile(
  file,
  JSON.stringify(
    {
      passed,
      model: candidate.modelId,
      sourceRun,
      source: "synthetic fixture; no business UI verification",
      attempts,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    passed,
    model: candidate.modelId,
    calls: attempts.length,
    file: file.pathname,
  }),
);
if (!passed) process.exitCode = 1;
