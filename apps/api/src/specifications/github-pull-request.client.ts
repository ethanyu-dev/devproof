import {
  specificationPullRequestContextSchema,
  type SpecificationContextDiagnostic,
  type SpecificationPullRequestContext,
} from "@devproof/contracts";
import { Injectable } from "@nestjs/common";

import { env } from "../config/env.js";
import { GithubAccessService } from "../console/github-access.service.js";
import { ContextSourceError } from "./context-source.error.js";

export interface PullRequestReference {
  number: number;
  owner: string;
  repository: string;
  url: string;
}

export interface GithubPullRequestResolution {
  diagnostics: SpecificationContextDiagnostic[];
  pullRequest: SpecificationPullRequestContext;
}

export interface GithubChangedFile {
  additions: number;
  changes: number;
  deletions: number;
  patch: string;
  path: string;
  previousPath: string | null;
  status: string;
}

@Injectable()
export class GithubPullRequestClient {
  constructor(private readonly access: GithubAccessService) {}

  configured(teamId: string) {
    return this.access.configured(teamId);
  }

  async getPullRequest(
    teamId: string,
    pullRequestUrl: string,
    isPrimary: boolean,
  ): Promise<GithubPullRequestResolution> {
    const reference = parsePullRequestUrl(pullRequestUrl);
    const candidates = await this.access.candidatesForRepository(
      teamId,
      reference.owner,
      reference.repository,
    );
    if (candidates.length === 0) {
      throw new ContextSourceError(
        "GITHUB",
        "GITHUB_PAT_NOT_CONFIGURED",
        `没有匹配 ${reference.owner}/${reference.repository} 的 GitHub 凭证。`,
        pullRequestUrl,
      );
    }
    const prefix = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}`;
    let raw: unknown;
    let token: string | null = null;
    let lastError: unknown;
    for (const [index, candidate] of candidates.entries()) {
      try {
        raw = await this.request(
          `${prefix}/pulls/${reference.number}`,
          candidate.token,
          pullRequestUrl,
        );
        token = candidate.token;
        break;
      } catch (error) {
        lastError = error;
        if (index === candidates.length - 1 || !canTryNextCredential(error)) {
          throw error;
        }
      }
    }
    if (!token) throw lastError;
    if (!isRecord(raw)) {
      throw new ContextSourceError(
        "GITHUB",
        "GITHUB_PR_INVALID",
        `GitHub PR 响应无效：${reference.owner}/${reference.repository}#${reference.number}`,
        pullRequestUrl,
      );
    }
    const head = isRecord(raw.head) ? raw.head : {};
    const base = isRecord(raw.base) ? raw.base : {};
    const headSha = stringValue(head.sha, "unknown");
    const diagnostics: SpecificationContextDiagnostic[] = [];
    const [files, checks, deployment] = await Promise.all([
      this.files(prefix, reference.number, token, pullRequestUrl).catch(
        (error: unknown) => {
          diagnostics.push(
            diagnostic(
              "WARNING",
              "GITHUB_FILES_UNAVAILABLE",
              errorMessage(error, "无法读取 PR 变更文件。"),
              pullRequestUrl,
            ),
          );
          return [];
        },
      ),
      this.checks(prefix, headSha, token, pullRequestUrl).catch(() => []),
      this.deployment(prefix, headSha, token, pullRequestUrl).catch(
        (error: unknown) => {
          diagnostics.push(
            diagnostic(
              "WARNING",
              "GITHUB_DEPLOYMENT_UNAVAILABLE",
              errorMessage(error, "无法读取 PR Deployment。"),
              pullRequestUrl,
            ),
          );
          return null;
        },
      ),
    ]);
    if (!deployment) {
      diagnostics.push(
        diagnostic(
          "INFO",
          "GITHUB_DEPLOYMENT_NOT_FOUND",
          "该 PR 当前没有可用的 Deployment URL。",
          pullRequestUrl,
        ),
      );
    }
    const pullRequest = specificationPullRequestContextSchema.parse({
      additions: numberValue(raw.additions),
      baseRef: stringValue(base.ref, "unknown"),
      body: stringValue(raw.body),
      changedFiles: files.map((file) => file.path),
      checks,
      commits: numberValue(raw.commits),
      deletions: numberValue(raw.deletions),
      deploymentUrl: deployment,
      headRef: stringValue(head.ref, "unknown"),
      headSha,
      id: String(raw.node_id ?? raw.id ?? pullRequestUrl),
      isPrimary,
      number: reference.number,
      organization: reference.owner,
      repository: `${reference.owner}/${reference.repository}`,
      status: pullRequestStatus(raw),
      title: stringValue(raw.title, `PR #${reference.number}`),
      url: stringValue(raw.html_url, pullRequestUrl),
    });
    return { diagnostics, pullRequest };
  }

  async changedFiles(
    teamId: string,
    pullRequestUrl: string,
  ): Promise<{ files: GithubChangedFile[]; revision: string }> {
    const {
      prefix,
      pullRequest: raw,
      reference,
      token,
    } = await this.authorizedPullRequest(teamId, pullRequestUrl);
    const head = isRecord(raw) && isRecord(raw.head) ? raw.head : {};
    const revision = stringValue(head.sha, "unknown");
    const files: GithubChangedFile[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const payload = await this.request(
        `${prefix}/pulls/${reference.number}/files?per_page=100&page=${page}`,
        token,
        pullRequestUrl,
      );
      if (!Array.isArray(payload)) break;
      const rows = payload.filter(isRecord);
      files.push(
        ...rows.map((row) => ({
          additions: numberValue(row.additions),
          changes: numberValue(row.changes),
          deletions: numberValue(row.deletions),
          patch: stringValue(row.patch).slice(0, 30_000),
          path: stringValue(row.filename, "unknown"),
          previousPath:
            typeof row.previous_filename === "string"
              ? row.previous_filename
              : null,
          status: stringValue(row.status, "modified"),
        })),
      );
      if (rows.length < 100) break;
    }
    return { files, revision };
  }

  async readPullRequestFile(input: {
    endLine?: number;
    path: string;
    pullRequestUrl: string;
    startLine?: number;
    teamId: string;
  }) {
    const {
      prefix,
      pullRequest: raw,
      token,
    } = await this.authorizedPullRequest(input.teamId, input.pullRequestUrl);
    const head = isRecord(raw) && isRecord(raw.head) ? raw.head : {};
    const revision = stringValue(head.sha, "unknown");
    const path = normalizeRepositoryPath(input.path);
    const payload = await this.request(
      `${prefix}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(revision)}`,
      token,
      input.pullRequestUrl,
    );
    if (!isRecord(payload) || payload.encoding !== "base64") {
      throw new ContextSourceError(
        "GITHUB",
        "GITHUB_FILE_INVALID",
        `GitHub 未返回可读取的文件：${input.path}`,
        input.pullRequestUrl,
      );
    }
    const decoded = Buffer.from(
      stringValue(payload.content),
      "base64",
    ).toString("utf8");
    const lines = decoded.split(/\r?\n/u);
    const startLine = boundedLine(input.startLine, 1, lines.length || 1);
    const maximumEndLine = Math.min(lines.length || 1, startLine + 399);
    const endLine = Math.max(
      startLine,
      boundedLine(input.endLine, maximumEndLine, maximumEndLine),
    );
    return {
      content: lines.slice(startLine - 1, endLine).join("\n"),
      endLine,
      path: input.path,
      revision,
      startLine,
      totalLines: lines.length,
    };
  }

  async searchPullRequestCode(input: {
    pathPrefix?: string;
    pullRequestUrl: string;
    query: string;
    teamId: string;
  }) {
    const {
      prefix,
      pullRequest: raw,
      reference,
      token,
    } = await this.authorizedPullRequest(input.teamId, input.pullRequestUrl);
    const head = isRecord(raw) && isRecord(raw.head) ? raw.head : {};
    const revision = stringValue(head.sha, "unknown");
    const query = input.query.trim().slice(0, 500);
    const qualifier = `repo:${reference.owner}/${reference.repository}`;
    const payload = await this.request(
      `/search/code?q=${encodeURIComponent(`${query} ${qualifier}`)}&per_page=20`,
      token,
      input.pullRequestUrl,
    );
    const rows =
      isRecord(payload) && Array.isArray(payload.items)
        ? payload.items.filter(isRecord)
        : [];
    const prefixFilter = input.pathPrefix
      ? normalizeRepositoryPath(input.pathPrefix)
      : null;
    const matches: Array<{
      endLine: number;
      path: string;
      revision: string;
      snippet: string;
      startLine: number;
    }> = [];
    for (const row of rows) {
      const path = stringValue(row.path);
      if (!path || (prefixFilter && !path.startsWith(prefixFilter))) continue;
      try {
        const contentPayload = await this.request(
          `${prefix}/contents/${path
            .split("/")
            .map(encodeURIComponent)
            .join("/")}?ref=${encodeURIComponent(revision)}`,
          token,
          input.pullRequestUrl,
        );
        if (!isRecord(contentPayload) || contentPayload.encoding !== "base64") {
          continue;
        }
        const lines = Buffer.from(stringValue(contentPayload.content), "base64")
          .toString("utf8")
          .split(/\r?\n/u);
        const tokens = query
          .toLocaleLowerCase()
          .split(/\s+/u)
          .filter((token) => token.length >= 2);
        const matchedAt = lines.findIndex((line) =>
          tokens.some((token) => line.toLocaleLowerCase().includes(token)),
        );
        const center = matchedAt >= 0 ? matchedAt : 0;
        const start = Math.max(0, center - 12);
        const end = Math.min(lines.length, center + 13);
        matches.push({
          endLine: end,
          path,
          revision,
          snippet: lines.slice(start, end).join("\n").slice(0, 12_000),
          startLine: start + 1,
        });
      } catch {
        // Individual binary, removed, or inaccessible files do not fail search.
      }
      if (matches.length >= 10) break;
    }
    return { matches, query, revision };
  }

  private async authorizedPullRequest(teamId: string, pullRequestUrl: string) {
    const reference = parsePullRequestUrl(pullRequestUrl);
    const candidates = await this.access.candidatesForRepository(
      teamId,
      reference.owner,
      reference.repository,
    );
    if (!candidates[0]) {
      throw new ContextSourceError(
        "GITHUB",
        "GITHUB_PAT_NOT_CONFIGURED",
        `没有匹配 ${reference.owner}/${reference.repository} 的 GitHub 凭证。`,
        pullRequestUrl,
      );
    }
    const prefix = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}`;
    let lastError: unknown;
    for (const [index, candidate] of candidates.entries()) {
      try {
        const pullRequest = await this.request(
          `${prefix}/pulls/${reference.number}`,
          candidate.token,
          pullRequestUrl,
        );
        return { prefix, pullRequest, reference, token: candidate.token };
      } catch (error) {
        lastError = error;
        if (index === candidates.length - 1 || !canTryNextCredential(error)) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async files(
    prefix: string,
    number: number,
    token: string,
    reference: string,
  ) {
    const result: Array<{ path: string }> = [];
    for (let page = 1; page <= 3; page += 1) {
      const payload = await this.request(
        `${prefix}/pulls/${number}/files?per_page=100&page=${page}`,
        token,
        reference,
      );
      if (!Array.isArray(payload)) break;
      const rows = payload.filter(isRecord);
      result.push(
        ...rows.map((row) => ({ path: stringValue(row.filename, "unknown") })),
      );
      if (rows.length < 100) break;
    }
    return result;
  }

  private async checks(
    prefix: string,
    headSha: string,
    token: string,
    reference: string,
  ) {
    const payload = await this.request(
      `${prefix}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`,
      token,
      reference,
    );
    const rows =
      isRecord(payload) && Array.isArray(payload.check_runs)
        ? payload.check_runs.filter(isRecord)
        : [];
    return rows.map((row) => ({
      conclusion: typeof row.conclusion === "string" ? row.conclusion : null,
      detailsUrl: httpUrl(row.details_url),
      name: stringValue(row.name, "unnamed-check"),
      status: stringValue(row.status, "unknown"),
    }));
  }

  private async deployment(
    prefix: string,
    headSha: string,
    token: string,
    reference: string,
  ) {
    const payload = await this.request(
      `${prefix}/deployments?sha=${encodeURIComponent(headSha)}&per_page=10`,
      token,
      reference,
    );
    for (const deployment of Array.isArray(payload)
      ? payload.filter(isRecord)
      : []) {
      if (typeof deployment.id !== "number") continue;
      const statuses = await this.request(
        `${prefix}/deployments/${deployment.id}/statuses?per_page=20`,
        token,
        reference,
      );
      if (!Array.isArray(statuses)) continue;
      const rows = statuses.filter(isRecord);
      const selected = rows.find((row) => row.state === "success") ?? rows[0];
      const url = httpUrl(selected?.environment_url);
      if (url) return url;
    }
    return null;
  }

  private async request(path: string, token: string, reference: string) {
    const configuration = env();
    const response = await fetch(
      `${configuration.GITHUB_API_URL.replace(/\/$/u, "")}${path}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": configuration.GITHUB_API_VERSION,
        },
        signal: AbortSignal.timeout(15_000),
      },
    ).catch((error: unknown) => {
      throw new ContextSourceError(
        "GITHUB",
        "GITHUB_REQUEST_FAILED",
        `GitHub API 请求失败：${errorMessage(error, "network error")}`,
        reference,
      );
    });
    if (!response.ok) {
      throw new ContextSourceError(
        "GITHUB",
        response.status === 404
          ? "GITHUB_REPOSITORY_NOT_AUTHORIZED"
          : response.status === 403
            ? "GITHUB_PERMISSION_DENIED"
            : "GITHUB_HTTP_ERROR",
        `GitHub API 返回 ${response.status}。`,
        reference,
        response.status,
      );
    }
    return response.status === 204
      ? null
      : ((await response.json()) as unknown);
  }
}

function canTryNextCredential(error: unknown) {
  return (
    error instanceof ContextSourceError &&
    error.status !== null &&
    [401, 403, 404, 429].includes(error.status)
  );
}

function normalizeRepositoryPath(value: string) {
  const path = value.trim().replace(/^\/+|\/+$/gu, "");
  if (
    !path ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "GitHub file path must be a repository-relative file path.",
    );
  }
  return path;
}

function boundedLine(
  value: number | undefined,
  fallback: number,
  maximum: number,
) {
  return Number.isInteger(value) && value! > 0
    ? Math.min(value!, maximum)
    : fallback;
}

export function parsePullRequestUrl(value: string): PullRequestReference {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const number = Number(segments[3]);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      segments[2] !== "pull" ||
      !segments[0] ||
      !segments[1] ||
      !Number.isInteger(number) ||
      number <= 0
    ) {
      throw new Error("invalid");
    }
    return {
      number,
      owner: segments[0],
      repository: segments[1],
      url: value,
    };
  } catch {
    throw new ContextSourceError(
      "GITHUB",
      "GITHUB_PR_URL_INVALID",
      `无法解析 GitHub Pull Request URL：${value}`,
      value,
    );
  }
}

function pullRequestStatus(value: Record<string, unknown>) {
  if (value.draft === true) return "DRAFT";
  if (value.merged_at) return "MERGED";
  return value.state === "closed" ? "CLOSED" : "OPEN";
}

function diagnostic(
  level: "INFO" | "WARNING",
  code: string,
  message: string,
  reference: string,
): SpecificationContextDiagnostic {
  return { code, level, message, reference, source: "GITHUB" };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function httpUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
