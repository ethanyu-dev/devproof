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
  it.each([
    { truncated: true },
    { bodyTruncated: true },
    { command: "page.snapshot" },
    { kind: "DOM" },
  ])("rejects incomplete or non-network citations: %j", (options) => {
    const { cache, page } = fixture(options);
    expect(
      cache.networkCitation(page.result.observationId, 0, 0),
    ).toBeUndefined();
  });
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
