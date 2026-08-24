import {
  specificationIssueContextSchema,
  type SpecificationIssueContext,
} from "@devproof/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Injectable } from "@nestjs/common";

import { env } from "../config/env.js";
import { ContextSourceError } from "./context-source.error.js";

const unsafeToolPattern =
  /(?:archive|create|delete|insert|remove|update|write)/iu;

interface McpToolDefinition {
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
  description?: string;
  inputSchema: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
    type: "object";
  };
  name: string;
}

export interface LinearIssueResolution {
  issue: SpecificationIssueContext;
  pullRequestUrls: string[];
}

@Injectable()
export class LinearContextClient {
  configured() {
    return Boolean(env().LINEAR_API_TOKEN || env().LINEAR_MCP_BEARER_TOKEN);
  }

  mode() {
    return env().LINEAR_API_TOKEN ? ("GRAPHQL" as const) : ("MCP" as const);
  }

  configuredTool() {
    return env().LINEAR_MCP_TOOL ?? null;
  }

  async getIssue(issueRef: string): Promise<LinearIssueResolution> {
    const configuration = env();
    if (configuration.LINEAR_API_TOKEN) {
      return this.getIssueFromGraphql(issueRef);
    }
    if (!configuration.LINEAR_MCP_BEARER_TOKEN) {
      throw new ContextSourceError(
        "LINEAR",
        "LINEAR_MCP_NOT_CONFIGURED",
        "DevProof 尚未配置 Linear MCP 凭据。",
        issueRef,
      );
    }

    let transport: StreamableHTTPClientTransport | null = null;
    try {
      const client = new Client({
        name: "devproof-specification-resolver",
        version: "0.1.0",
      });
      transport = new StreamableHTTPClientTransport(
        new URL(configuration.LINEAR_MCP_URL),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${configuration.LINEAR_MCP_BEARER_TOKEN}`,
            },
            signal: AbortSignal.timeout(configuration.LINEAR_MCP_TIMEOUT_MS),
          },
        },
      );
      await client.connect(transport as unknown as Transport);
      const listed = await client.listTools(undefined, {
        signal: AbortSignal.timeout(configuration.LINEAR_MCP_TIMEOUT_MS),
      });
      const tool = selectIssueTool(
        listed.tools as unknown as McpToolDefinition[],
        configuration.LINEAR_MCP_TOOL,
      );
      const result = await client.callTool(
        {
          arguments: issueToolArguments(tool, normalizeIssueRef(issueRef)),
          name: tool.name,
        },
        undefined,
        { signal: AbortSignal.timeout(configuration.LINEAR_MCP_TIMEOUT_MS) },
      );
      if ("isError" in result && result.isError) {
        throw new Error(toolErrorMessage(result));
      }
      return normalizeIssueResult(result, issueRef);
    } catch (error) {
      if (error instanceof ContextSourceError) throw error;
      throw new ContextSourceError(
        "LINEAR",
        "LINEAR_MCP_REQUEST_FAILED",
        `通过 Linear MCP 读取 Issue 失败：${safeError(error, configuration.LINEAR_MCP_BEARER_TOKEN)}`,
        issueRef,
      );
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }

  private async getIssueFromGraphql(
    issueRef: string,
  ): Promise<LinearIssueResolution> {
    const configuration = env();
    const issueId = normalizeIssueRef(issueRef);
    const response = await fetch(configuration.LINEAR_API_URL, {
      body: JSON.stringify({
        query: `query DevProofIssue($id: String!) {
          organization { id }
          issue(id: $id) {
            id identifier title description url priority
            state { name }
            labels { nodes { name } }
            assignee { id name email }
            attachments { nodes { url } }
          }
        }`,
        variables: { id: issueId },
      }),
      headers: {
        authorization:
          configuration.LINEAR_API_AUTH_MODE === "OAUTH"
            ? `Bearer ${configuration.LINEAR_API_TOKEN}`
            : configuration.LINEAR_API_TOKEN!,
        "content-type": "application/json; charset=utf-8",
      },
      method: "POST",
      signal: AbortSignal.timeout(configuration.LINEAR_MCP_TIMEOUT_MS),
    });
    const result = (await response.json().catch(() => null)) as unknown;
    const root = isRecord(result) ? result : {};
    const errors = Array.isArray(root.errors) ? root.errors : [];
    if (!response.ok || errors.length) {
      throw new ContextSourceError(
        "LINEAR",
        "LINEAR_GRAPHQL_REQUEST_FAILED",
        `通过 Linear GraphQL 读取 Issue 失败：${graphqlError(errors, response.status)}`,
        issueRef,
        response.status >= 400 ? response.status : 502,
      );
    }
    const data = isRecord(root.data) ? root.data : {};
    const issue = isRecord(data.issue) ? data.issue : null;
    if (!issue) {
      throw new ContextSourceError(
        "LINEAR",
        "LINEAR_ISSUE_NOT_FOUND",
        `Linear GraphQL 未返回 Issue：${issueRef}`,
        issueRef,
        404,
      );
    }
    const organization = isRecord(data.organization) ? data.organization : {};
    const issuerKey =
      firstString(organization, ["id"]) ??
      configuration.LINEAR_WORKSPACE_ID ??
      "linear:graphql:default";
    const assignee = normalizeAssignee(issue.assignee, issuerKey);
    const state = isRecord(issue.state)
      ? (firstString(issue.state, ["name"]) ?? "")
      : "";
    const labels =
      isRecord(issue.labels) && Array.isArray(issue.labels.nodes)
        ? issue.labels.nodes
            .map((label) =>
              isRecord(label) ? firstString(label, ["name"]) : null,
            )
            .filter((label): label is string => Boolean(label))
        : [];
    const normalized = specificationIssueContextSchema.parse({
      assignee,
      description: firstString(issue, ["description"]) ?? "",
      id: firstString(issue, ["id"]) ?? issueId,
      identifier: firstString(issue, ["identifier"]) ?? issueId,
      labels,
      priority: normalizePriority(issue.priority),
      state,
      title: firstString(issue, ["title"]),
      url:
        httpUrl(firstString(issue, ["url"])) ??
        `https://linear.app/issue/${encodeURIComponent(issueId)}`,
    });
    return {
      issue: normalized,
      pullRequestUrls: prioritizedPullRequestUrls(result),
    };
  }
}

export function selectIssueTool(
  tools: McpToolDefinition[],
  configuredName?: string,
) {
  if (configuredName) {
    const configured = tools.find((tool) => tool.name === configuredName);
    if (!configured) {
      throw new Error(`Linear MCP 不存在工具 ${configuredName}。`);
    }
    assertReadOnly(configured);
    return configured;
  }
  const candidates = tools
    .filter((tool) => {
      const text = `${tool.name} ${tool.description ?? ""}`;
      return (
        /issue|ticket/iu.test(text) &&
        /get|read|find|search|retrieve/iu.test(text)
      );
    })
    .filter(isReadOnly)
    .sort((left, right) => issueToolScore(right) - issueToolScore(left));
  const selected = candidates[0];
  if (!selected) {
    throw new Error(
      "Linear MCP 没有可安全识别的 Issue 读取工具，请配置 LINEAR_MCP_TOOL。",
    );
  }
  return selected;
}

export function issueToolArguments(tool: McpToolDefinition, issueRef: string) {
  const properties = tool.inputSchema.properties ?? {};
  const result: Record<string, unknown> = {};
  const preferred = [
    "id",
    "issueId",
    "issue_id",
    "identifier",
    "issueIdentifier",
    "query",
    "searchQuery",
    "search_query",
  ];
  const key = preferred.find((candidate) => candidate in properties);
  if (key) result[key] = issueRef;
  if (!key) {
    const strings = Object.entries(properties).filter(([, schema]) =>
      acceptsString(schema),
    );
    if (strings.length === 1 && strings[0]) result[strings[0][0]] = issueRef;
  }
  const missing = (tool.inputSchema.required ?? []).filter(
    (name) => result[name] === undefined,
  );
  if (missing.length) {
    throw new Error(
      `Linear MCP 工具 ${tool.name} 有无法推断的必填参数：${missing.join(", ")}。`,
    );
  }
  return result;
}

export function normalizeIssueResult(
  result: unknown,
  issueRef: string,
): LinearIssueResolution {
  const records: Array<Record<string, unknown>> = [];
  collectRecords(result, records, 0);
  const normalizedRef = normalizeIssueRef(issueRef).toLowerCase();
  const issue = records
    .filter((record) => firstString(record, ["title", "name"]))
    .filter((record) => issueIdentifier(record))
    .sort(
      (left, right) =>
        issueMatchScore(right, normalizedRef) -
        issueMatchScore(left, normalizedRef),
    )[0];
  if (!issue) {
    throw new ContextSourceError(
      "LINEAR",
      "LINEAR_ISSUE_NOT_FOUND",
      `Linear MCP 未返回可识别的 Issue：${issueRef}`,
      issueRef,
      404,
    );
  }
  const identifier = issueIdentifier(issue)!;
  const state =
    firstString(issue, ["stateName", "status"]) ??
    (isRecord(issue.state)
      ? firstString(issue.state, ["name", "label"])
      : typeof issue.state === "string"
        ? issue.state
        : "");
  const issuerKey = env().LINEAR_WORKSPACE_ID ?? "linear:mcp:default";
  const normalized = specificationIssueContextSchema.parse({
    assignee: normalizeAssignee(
      issue.assignee ?? flattenedAssignee(issue),
      issuerKey,
    ),
    description: firstString(issue, ["description", "body"]) ?? "",
    id: firstString(issue, ["id"]) ?? identifier,
    identifier,
    labels: normalizeLabels(issue.labels),
    priority: normalizePriority(issue.priority),
    state,
    title: firstString(issue, ["title", "name"]),
    url:
      httpUrl(firstString(issue, ["url", "webUrl", "web_url"])) ??
      `https://linear.app/issue/${encodeURIComponent(identifier)}`,
  });
  return {
    issue: normalized,
    pullRequestUrls: prioritizedPullRequestUrls(result),
  };
}

function normalizeAssignee(value: unknown, issuerKey: string) {
  if (!isRecord(value)) return null;
  const externalId = firstString(value, ["id", "externalId", "external_id"]);
  const name = firstString(value, ["name", "displayName", "display_name"]);
  if (!externalId || !name) return null;
  const rawType = firstString(value, ["type", "kind"]);
  return {
    email: firstString(value, ["email"])?.trim().toLowerCase() ?? null,
    externalId,
    issuerKey,
    name,
    type:
      value.isAgent === true || rawType?.toLowerCase() === "agent"
        ? ("AGENT" as const)
        : ("HUMAN" as const),
  };
}

function flattenedAssignee(issue: Record<string, unknown>) {
  const externalId = firstString(issue, [
    "assigneeId",
    "assignee_id",
    "assigneeExternalId",
  ]);
  const name = firstString(issue, ["assigneeName", "assignee_name"]);
  if (!externalId || !name) return null;
  return {
    email: firstString(issue, ["assigneeEmail", "assignee_email"]),
    id: externalId,
    name,
  };
}

function graphqlError(errors: unknown[], status: number) {
  const messages = errors
    .slice(0, 3)
    .map((error) =>
      isRecord(error) && typeof error.message === "string"
        ? error.message
        : String(error),
    );
  return messages.join("; ") || `HTTP ${status}`;
}

export function extractGithubPullRequestUrls(value: string | null | undefined) {
  if (!value) return [];
  return [
    ...new Set(
      [
        ...value.matchAll(
          /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/giu,
        ),
      ].map((match) => match[0]),
    ),
  ].slice(0, 25);
}

export function normalizeIssueRef(value: string) {
  const normalized = value.trim();
  try {
    const url = new URL(normalized);
    const match = url.pathname.match(/\/issue\/([^/]+)/iu);
    return decodeURIComponent(match?.[1] ?? normalized);
  } catch {
    return normalized;
  }
}

function collectRecords(
  value: unknown,
  records: Array<Record<string, unknown>>,
  depth: number,
) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    try {
      collectRecords(JSON.parse(value) as unknown, records, depth + 1);
    } catch {
      // Non-JSON text is still included in the serialized URL scan.
    }
    return;
  }
  if (Array.isArray(value)) {
    value
      .slice(0, 500)
      .forEach((item) => collectRecords(item, records, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  records.push(value);
  Object.values(value).forEach((item) =>
    collectRecords(item, records, depth + 1),
  );
}

function issueIdentifier(record: Record<string, unknown>) {
  const explicit = firstString(record, [
    "identifier",
    "issueIdentifier",
    "key",
  ]);
  if (explicit) return explicit;
  const id = firstString(record, ["id"]);
  return id && /^[A-Za-z][A-Za-z0-9_]*-\d+$/u.test(id) ? id : null;
}

function issueMatchScore(record: Record<string, unknown>, issueRef: string) {
  const values = [
    issueIdentifier(record),
    firstString(record, ["id"]),
    firstString(record, ["url", "webUrl", "web_url"]),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  return values.some((value) => value === issueRef || value.includes(issueRef))
    ? 10
    : 0;
}

function normalizeLabels(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) =>
      typeof item === "string"
        ? [item]
        : isRecord(item)
          ? [firstString(item, ["name", "label"])].filter(
              (label): label is string => Boolean(label),
            )
          : [],
    )
    .slice(0, 100);
}

function normalizePriority(value: unknown) {
  const candidate = isRecord(value) ? value.value : value;
  const parsed = typeof candidate === "number" ? candidate : Number(candidate);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 4 ? parsed : null;
}

function prioritizedPullRequestUrls(result: unknown) {
  const structured = isRecord(result) ? result.structuredContent : null;
  return [
    ...new Set([
      ...extractGithubPullRequestUrls(JSON.stringify(structured)),
      ...extractGithubPullRequestUrls(JSON.stringify(result)),
    ]),
  ].slice(0, 25);
}

function isReadOnly(tool: McpToolDefinition) {
  return (
    !unsafeToolPattern.test(tool.name) &&
    tool.annotations?.destructiveHint !== true &&
    tool.annotations?.readOnlyHint !== false
  );
}

function assertReadOnly(tool: McpToolDefinition) {
  if (!isReadOnly(tool)) {
    throw new Error(`Linear MCP 工具 ${tool.name} 不是安全的只读工具。`);
  }
}

function issueToolScore(tool: McpToolDefinition) {
  const name = tool.name.toLowerCase();
  return (name.includes("get") ? 4 : 0) + (name.includes("issue") ? 3 : 0);
}

function acceptsString(schema: Record<string, unknown>) {
  return (
    schema.type === "string" ||
    (Array.isArray(schema.type) && schema.type.includes("string"))
  );
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function httpUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function toolErrorMessage(result: unknown) {
  return isRecord(result)
    ? JSON.stringify(result).slice(0, 4_000)
    : String(result);
}

function safeError(error: unknown, secret?: string) {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.replaceAll(secret, "[REDACTED]") : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
