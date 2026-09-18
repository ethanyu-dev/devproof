import { describe, expect, it } from "vitest";
import { runtimeActionCommandInputSchema } from "@devproof/runtime-protocol";
import { BrowserObservations } from "./browser-observation.js";
import {
  criterionSubmissionSchema,
  resolveCriterionEvidence,
} from "./criterion-evidence.js";
import { networkRequestMatches } from "./network-criterion.js";

const request = {
  method: "POST",
  url: "https://example.test/whitelist",
  status: 200,
  requestBody: {
    config: '{ "value": true }',
    account: "subject",
    type: "MAPPING",
  },
  responseBody: {},
};
const criterion = {
  id: "create",
  description: "新增映射白名单",
  required: true,
  requiredEvidenceKinds: ["NETWORK"] as ["NETWORK"],
  requireObservedEvidence: true,
  observationTargets: [
    {
      label: "新增白名单请求体字段集合",
      expectedText: "account, type, config",
    },
    { label: "新增白名单请求体 type", expectedText: "MAPPING" },
    { label: "新增白名单请求体 config", expectedText: '{"value":true}' },
  ],
};
function fixture(
  options: {
    truncated?: boolean;
    command?: string;
    bodyTruncated?: boolean;
    kind?: string;
  } = {},
) {
  const cache = new BrowserObservations();
  const raw = {
    status: "SUCCEEDED",
    result: {
      content: JSON.stringify([
        {
          ...request,
          ...(options.bodyTruncated ? { responseBodyTruncated: true } : {}),
        },
      ]),
      truncated: options.truncated ?? false,
    },
    artifacts: [{ id: "network", kind: options.kind ?? "NETWORK" }],
  };
  cache.capture(
    runtimeActionCommandInputSchema.parse({
      commandType: options.command ?? "page.network",
      payload: {},
    }),
    raw,
  );
  const page = cache.project(raw) as {
    result: { observationId: string; cursor: number };
  };
  const evidence = new Map([
    [
      "artifact://network",
      {
        externalId: "artifact://network",
        kind: "NETWORK" as const,
        label: "",
        metadata: {},
      },
    ],
  ]);
  return { cache, page, raw, evidence };
}
describe("structured network criterion citations", () => {
  it("accepts exact fields, enum and JSON config from one actual request, preserving its evidence", () => {
    const { cache, page, evidence } = fixture();
    const result = resolveCriterionEvidence(
      criterionSubmissionSchema.parse({
        criterionId: criterion.id,
        status: "PASSED",
        summary: "新增请求字段正确。",
        networkCitations: criterion.observationTargets.map((t) => ({
          target: t.label,
          observationId: page.result.observationId,
          cursor: 0,
          requestIndex: 0,
        })),
      }),
      criterion,
      cache,
      evidence,
    );
    expect(result.error).toBeUndefined();
    if (result.error) throw new Error(result.error.error);
    expect(result.result.evidenceRefs).toEqual(["artifact://network"]);
    expect(result.result.observations).toHaveLength(3);
  });
  it.each([{ truncated: true }, { command: "page.snapshot" }, { kind: "DOM" }])(
    "rejects incomplete or non-network citations: %j",
    (options) => {
      const { cache, page } = fixture(options);
      expect(
        cache.networkCitation(page.result.observationId, 0, 0),
      ).toBeUndefined();
    },
  );
  it("rejects unknown indexes and unread pages", () => {
    const { cache, page } = fixture();
    expect(
      cache.networkCitation(page.result.observationId, 0, 9),
    ).toBeUndefined();
    expect(
      cache.networkCitation(page.result.observationId, 500, 0),
    ).toBeUndefined();
  });
  it("does not treat equal-looking DOM text as structured request evidence", () => {
    const { cache, page, evidence } = fixture({ command: "page.snapshot" });
    const result = resolveCriterionEvidence(
      criterionSubmissionSchema.parse({
        criterionId: criterion.id,
        status: "PASSED",
        summary: "请求正确。",
        evidenceRefs: ["artifact://network"],
        observations: [
          {
            target: criterion.observationTargets[0]!.label,
            observationId: page.result.observationId,
            cursor: 0,
            quote: JSON.stringify(request),
          },
        ],
      }),
      criterion,
      cache,
      evidence,
    );
    expect(result.error?.code).toBe("QUOTE_NOT_EXACT");
  });
  it("checks exact key sets and typed JSON values instead of substrings", () => {
    const match = (body: unknown, target: string, expected: string) =>
      networkRequestMatches(
        JSON.stringify({ ...request, requestBody: body }),
        target,
        expected,
      );
    expect(
      match(
        { ...request.requestBody, extra: true },
        criterion.observationTargets[0]!.label,
        "account, type, config",
      ),
    ).toBe(false);
    expect(
      match(
        { ...request.requestBody, config: '{"value":false}' },
        "请求体 config",
        '{"value":true}',
      ),
    ).toBe(false);
    expect(
      match(
        { ...request.requestBody, config: '{"value":"true"}' },
        "请求体 config",
        '{"value":true}',
      ),
    ).toBe(false);
    expect(
      match(
        { ...request.requestBody, type: "NOT_MAPPING" },
        "请求体 type",
        "MAPPING",
      ),
    ).toBe(false);
    expect(
      networkRequestMatches(
        JSON.stringify({ ...request, url: request.url + "?type=MAPPING" }),
        "列表请求的 type 参数",
        "MAPPING",
      ),
    ).toBe(true);
    expect(
      networkRequestMatches(
        JSON.stringify(request),
        "更新白名单请求体 config",
        '{"value":true}',
      ),
    ).toBe(false);
    expect(
      networkRequestMatches(
        JSON.stringify({ ...request, method: "PUT" }),
        "更新白名单请求体 config",
        '{"value":true}',
      ),
    ).toBe(true);
    expect(
      networkRequestMatches(
        JSON.stringify({
          ...request,
          url: request.url + "?type=OTHER&type=MAPPING",
        }),
        "列表请求的 type 参数",
        "MAPPING",
      ),
    ).toBe(false);
  });
});

it("matches a list query's explicit field=value without relying on Chinese field labels", () => {
  const matches = (url: string) =>
    networkRequestMatches(
      JSON.stringify({ method: "GET", url }),
      "按账号与合规模型映射筛选的列表查询请求",
      "type=MODEL_NAME_MAPPING_WHITELIST",
    );
  expect(
    matches(
      "https://example.test/list?account=test&type=MODEL_NAME_MAPPING_WHITELIST",
    ),
  ).toBe(true);
  expect(
    matches("https://example.test/list?type=NOT_MODEL_NAME_MAPPING_WHITELIST"),
  ).toBe(false);
  expect(
    matches(
      "https://example.test/list?type=MODEL_NAME_MAPPING_WHITELIST&type=OTHER",
    ),
  ).toBe(false);
});

it("does not bypass typed request validation with a raw substring quotation", () => {
  const { cache, page, evidence } = fixture();
  const configCheck = {
    ...criterion,
    observationTargets: [{ label: "新增请求体 config", expectedText: "true" }],
  };
  const result = resolveCriterionEvidence(
    criterionSubmissionSchema.parse({
      criterionId: criterion.id,
      status: "PASSED",
      summary: "配置正确。",
      evidenceRefs: ["artifact://network"],
      observations: [
        {
          target: "新增请求体 config",
          observationId: page.result.observationId,
          cursor: 0,
          quote: JSON.stringify(request),
        },
      ],
    }),
    configCheck,
    cache,
    evidence,
  );
  expect(result.error?.code).toBe("QUOTE_NOT_EXACT");
});

it("uses the captured request body even when response capture is incomplete, but never proves omitted response fields", () => {
  const { cache, page, evidence } = fixture({ bodyTruncated: true });
  const citation = cache.networkCitation(page.result.observationId, 0, 0)!;
  expect(citation).toBeDefined();
  expect(
    networkRequestMatches(citation.quote, "新增请求体 type", "MAPPING"),
  ).toBe(true);
  expect(
    networkRequestMatches(
      JSON.stringify({
        ...request,
        responseBody: { type: "MAPPING" },
        responseBodyOmitted: "size_limit",
      }),
      "响应体 type",
      "MAPPING",
    ),
  ).toBe(false);
  expect(
    networkRequestMatches(
      JSON.stringify({ ...request, requestBodyOmitted: "authentication" }),
      "请求体 type",
      "MAPPING",
    ),
  ).toBe(false);
  const result = resolveCriterionEvidence(
    criterionSubmissionSchema.parse({
      criterionId: criterion.id,
      status: "PASSED",
      summary: "请求字段已完整观察。",
      networkCitations: criterion.observationTargets.map((t) => ({
        target: t.label,
        observationId: page.result.observationId,
        cursor: 0,
        requestIndex: 0,
      })),
    }),
    criterion,
    cache,
    evidence,
  );
  expect(result.error).toBeUndefined();
});

it("automatically retains DOM evidence for an exact delivered manual quotation", () => {
  const cache = new BrowserObservations();
  const raw = {
    status: "SUCCEEDED",
    result: { content: '- option "映射白名单" [ref=e1]' },
    artifacts: [{ id: "dom", kind: "DOM" }],
  };
  cache.capture(
    runtimeActionCommandInputSchema.parse({
      commandType: "page.snapshot",
      payload: {},
    }),
    raw,
  );
  const page = cache.project(raw) as { result: { observationId: string } };
  const evidence = new Map([
    [
      "artifact://dom",
      {
        externalId: "artifact://dom",
        kind: "DOM" as const,
        label: "选项",
        metadata: {},
      },
    ],
  ]);
  const check = {
    id: "option",
    description: "选项可见",
    required: true,
    requiredEvidenceKinds: ["DOM"] as ["DOM"],
    requireObservedEvidence: true,
    observationTargets: [{ label: "选项", expectedText: "映射白名单" }],
  };
  const submit = (quote: string) =>
    resolveCriterionEvidence(
      criterionSubmissionSchema.parse({
        criterionId: "option",
        status: "PASSED",
        summary: "选项已显示。",
        observations: [
          {
            observationId: page.result.observationId,
            cursor: 0,
            target: "选项",
            quote,
          },
        ],
      }),
      check,
      cache,
      evidence,
    );
  const resolved = submit(raw.result.content);
  if (resolved.error) throw new Error(resolved.error.error);
  expect(resolved.result.evidenceRefs).toEqual(["artifact://dom"]);
  expect(submit("未观察的映射白名单").error).toBeDefined();
});
