import { createHash } from "node:crypto";

import {
  specificationKnowledgeContextSchema,
  type SpecificationContextDiagnostic,
  type SpecificationIssueContext,
  type SpecificationKnowledgeContext,
} from "@devproof/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Injectable } from "@nestjs/common";

import { env } from "../config/env.js";

const safeToolPattern = /(?:search|query|retriev|knowledge|rag)/iu;
const unsafeToolPattern =
  /(?:create|delete|ingest|insert|remove|update|upload|write)/iu;

interface KnowledgeTool {
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
  description?: string;
  inputSchema: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
    type: "object";
  };
  name: string;
}

export interface KnowledgeResolution {
  diagnostics: SpecificationContextDiagnostic[];
  items: SpecificationKnowledgeContext[];
}

@Injectable()
export class KnowledgeContextClient {
  configured() {
    return Boolean(env().KNOWLEDGE_MCP_URL);
  }

  configuredTool() {
    return env().KNOWLEDGE_MCP_TOOL ?? null;
  }

  async resolve(
    issue: SpecificationIssueContext,
    queryOverride?: string,
  ): Promise<KnowledgeResolution> {
    const configuration = env();
    if (!configuration.KNOWLEDGE_MCP_URL) {
      return {
        diagnostics: [
          diagnostic(
            "INFO",
            "KNOWLEDGE_MCP_NOT_CONFIGURED",
            "未配置知识库 MCP，本次只使用 Issue 与 Pull Request 上下文。",
            null,
          ),
        ],
        items: [],
      };
    }

    let transport: StreamableHTTPClientTransport | null = null;
    try {
      const client = new Client({
        name: "devproof-knowledge-resolver",
        version: "0.1.0",
      });
      transport = new StreamableHTTPClientTransport(
        new URL(configuration.KNOWLEDGE_MCP_URL),
        {
          requestInit: {
            headers: configuration.KNOWLEDGE_MCP_BEARER_TOKEN
              ? {
                  Authorization: `Bearer ${configuration.KNOWLEDGE_MCP_BEARER_TOKEN}`,
                }
              : {},
            signal: AbortSignal.timeout(configuration.KNOWLEDGE_MCP_TIMEOUT_MS),
          },
        },
      );
      await client.connect(transport as unknown as Transport);
      const listed = await client.listTools(undefined, {
        signal: AbortSignal.timeout(configuration.KNOWLEDGE_MCP_TIMEOUT_MS),
      });
      const tool = selectKnowledgeTool(
        listed.tools as unknown as KnowledgeTool[],
        configuration.KNOWLEDGE_MCP_TOOL,
      );
      const result = await client.callTool(
        {
          arguments: knowledgeArguments(tool, issue, queryOverride),
          name: tool.name,
        },
        undefined,
        { signal: AbortSignal.timeout(configuration.KNOWLEDGE_MCP_TIMEOUT_MS) },
      );
      if ("isError" in result && result.isError) {
        throw new Error(JSON.stringify(result).slice(0, 4_000));
      }
      const items = normalizeKnowledgeResult(result);
      return {
        diagnostics: [
          diagnostic(
            "INFO",
            "KNOWLEDGE_MCP_RESOLVED",
            `通过 MCP 工具 ${tool.name} 读取 ${items.length} 条知识库内容。`,
            configuration.KNOWLEDGE_MCP_URL,
          ),
        ],
        items,
      };
    } catch (error) {
      return {
        diagnostics: [
          diagnostic(
            "WARNING",
            "KNOWLEDGE_MCP_RESOLUTION_FAILED",
            `知识库 MCP 读取失败：${redactedError(error, configuration.KNOWLEDGE_MCP_BEARER_TOKEN)}`,
            configuration.KNOWLEDGE_MCP_URL,
          ),
        ],
        items: [],
      };
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }
}

function selectKnowledgeTool(tools: KnowledgeTool[], configuredName?: string) {
  if (configuredName) {
    const tool = tools.find((candidate) => candidate.name === configuredName);
    if (!tool) throw new Error(`知识库 MCP 不存在工具 ${configuredName}。`);
    assertSafe(tool);
    return tool;
  }
  const candidates = tools.filter(
    (tool) =>
      safeToolPattern.test(`${tool.name} ${tool.description ?? ""}`) &&
      isSafe(tool),
  );
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length
        ? "知识库 MCP 存在多个候选读取工具，请配置 KNOWLEDGE_MCP_TOOL。"
        : "知识库 MCP 没有可安全识别的读取工具。",
    );
  }
  return candidates[0]!;
}

function knowledgeArguments(
  tool: KnowledgeTool,
  issue: SpecificationIssueContext,
  queryOverride?: string,
) {
  const configuration = env();
  const properties = tool.inputSchema.properties ?? {};
  const result = parseStaticArguments(
    configuration.KNOWLEDGE_MCP_STATIC_ARGUMENTS,
  );
  const query = (
    queryOverride?.trim() ||
    [
      `${issue.identifier} ${issue.title}`,
      issue.description,
      issue.labels.join(", "),
    ]
      .filter(Boolean)
      .join("\n")
  ).slice(0, 20_000);
  const queryKey = [
    "query",
    "question",
    "search_query",
    "searchQuery",
    "text",
    "input",
    "prompt",
  ].find((key) => key in properties);
  if (queryKey && result[queryKey] === undefined) result[queryKey] = query;
  for (const key of ["issueId", "issue_id", "identifier"]) {
    if (key in properties && result[key] === undefined) {
      result[key] = key === "identifier" ? issue.identifier : issue.id;
    }
  }
  const missing = (tool.inputSchema.required ?? []).filter(
    (name) => result[name] === undefined,
  );
  if (missing.length) {
    throw new Error(`知识库工具缺少参数：${missing.join(", ")}。`);
  }
  return result;
}

export function normalizeKnowledgeResult(result: unknown) {
  const records: unknown[] = [];
  collectCandidates(result, records, 0);
  const items: SpecificationKnowledgeContext[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of records.entries()) {
    const normalized = normalizeCandidate(candidate, index);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    items.push(normalized);
    if (items.length === 100) break;
  }
  return items;
}

function collectCandidates(value: unknown, result: unknown[], depth: number) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    try {
      collectCandidates(JSON.parse(value) as unknown, result, depth + 1);
    } catch {
      if (value.trim().length >= 20) result.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value
      .slice(0, 500)
      .forEach((item) => collectCandidates(item, result, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  if (
    ["content", "text", "body", "snippet"].some(
      (key) => typeof value[key] === "string",
    )
  ) {
    result.push(value);
  }
  Object.values(value).forEach((item) =>
    collectCandidates(item, result, depth + 1),
  );
}

function normalizeCandidate(candidate: unknown, index: number) {
  if (typeof candidate === "string") {
    return specificationKnowledgeContextSchema.parse({
      content: candidate,
      id: hash(candidate),
      title: `知识片段 ${index + 1}`,
    });
  }
  if (!isRecord(candidate)) return null;
  const content = firstString(candidate, [
    "content",
    "text",
    "body",
    "snippet",
  ]);
  if (!content) return null;
  const url = firstString(candidate, ["url", "uri", "sourceUrl"]);
  return specificationKnowledgeContextSchema.parse({
    content,
    id: firstString(candidate, ["id", "key", "documentId"]) ?? hash(content),
    title: firstString(candidate, ["title", "name"]) ?? `知识片段 ${index + 1}`,
    url: url && /^https?:\/\//iu.test(url) ? url : null,
  });
}

function parseStaticArguments(value?: string) {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("KNOWLEDGE_MCP_STATIC_ARGUMENTS 必须是 JSON 对象。 ");
  }
  return parsed;
}

function isSafe(tool: KnowledgeTool) {
  return (
    !unsafeToolPattern.test(tool.name) &&
    tool.annotations?.destructiveHint !== true &&
    tool.annotations?.readOnlyHint !== false
  );
}

function assertSafe(tool: KnowledgeTool) {
  if (!isSafe(tool)) throw new Error(`知识库工具 ${tool.name} 不是只读工具。`);
}

function diagnostic(
  level: "INFO" | "WARNING",
  code: string,
  message: string,
  reference: string | null,
): SpecificationContextDiagnostic {
  return { code, level, message, reference, source: "KNOWLEDGE" };
}

function redactedError(error: unknown, secret?: string) {
  const message = error instanceof Error ? error.message : String(error);
  return secret ? message.replaceAll(secret, "[REDACTED]") : message;
}

function firstString(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return null;
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
