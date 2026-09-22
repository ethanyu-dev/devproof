import type { ExecutionState } from "./execution-state.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const parse = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/** Page and identity filters that do not by themselves hide a record. */
export const EXECUTION_READ_QUERY_FIELDS: readonly string[] = [
  "account",
  "type",
  "page",
  "pageSize",
  "pageNum",
  "pageIndex",
  "page_size",
  "page_num",
  "page_index",
  "limit",
  "offset",
];

/** Collapse list suffixes and trailing numeric or UUID path ids. */
export function executionResourceUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin +
      parsed.pathname
        .replace(/\/list\/?$/, "")
        .replace(/\/[^/]+$/, (match) =>
          /^\/(?:\d+|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu.test(match)
            ? ""
            : match,
        )
        .replace(/\/$/, "")
    );
  } catch {
    return url;
  }
}

export function executionRecordKey(id: unknown, type: unknown, url?: string) {
  return `${url ? executionResourceUrl(url) : ""}:${String(type ?? "")}:${String(id)}`;
}

/** Prefer explicit identity, and reject contradictory body/path/query identities. */
export function requestedRecordId(
  url: string,
  request: Record<string, unknown>,
) {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).at(-1);
    const ids = [
      request.id,
      ...parsed.searchParams.getAll("id"),
      ...(tail &&
      /^(?:\d+|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu.test(tail)
        ? [tail]
        : []),
    ]
      .filter((value) => value !== undefined && value !== null)
      .map(String);
    return {
      id: ids[0],
      conflict:
        new Set(ids).size > 1 || parsed.searchParams.getAll("id").length > 1,
    };
  } catch {
    return { id: undefined, conflict: true };
  }
}

export function responseRecordId(response: unknown): string | undefined {
  const body = object(response);
  const id = body.id ?? object(body.data).id ?? object(body.result).id;
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : undefined;
}

/** An empty list is relevant only if its query scope includes this record. */
export function completeReadCoversRecord(
  read: ExecutionState["readReceipts"][number],
  record: Pick<
    ExecutionState["records"][number],
    | "id"
    | "type"
    | "resourceUrl"
    | "resourceName"
    | "account"
    | "accountAliases"
  >,
) {
  if (
    !read.complete ||
    !read.identitiesComplete ||
    !record.resourceUrl ||
    executionResourceUrl(read.url) !== executionResourceUrl(record.resourceUrl)
  )
    return false;
  const identity = requestedRecordId(read.url, {});
  if (
    identity.conflict ||
    (identity.id !== undefined && identity.id !== record.id)
  )
    return false;
  const params = new URL(read.url).searchParams;
  if (
    ["id", "type", "account"].some((field) => params.getAll(field).length > 1)
  )
    return false;
  if (params.has("id") && params.get("id") !== record.id) return false;
  if (
    params.has("name") &&
    (params.getAll("name").length !== 1 ||
      params.get("name") !== record.resourceName)
  )
    return false;
  if (params.has("type") && params.get("type") !== record.type) return false;
  if (
    params.has("account") &&
    ![record.account, ...record.accountAliases].includes(params.get("account")!)
  )
    return false;
  return [...params.keys()].every(
    (field) =>
      field === "id" ||
      (field === "name" && Boolean(record.resourceName)) ||
      EXECUTION_READ_QUERY_FIELDS.includes(field),
  );
}

export function writeMatchesRecord(
  write: ExecutionState["writes"][number],
  record: ExecutionState["records"][number],
) {
  if (
    !record.resourceUrl ||
    executionResourceUrl(write.url) !== executionResourceUrl(record.resourceUrl)
  )
    return false;
  const request = object(parse(write.request));
  const identity = requestedRecordId(write.url, request);
  if (identity.conflict) return false;
  if (write.method === "POST") {
    const createdId = responseRecordId(parse(write.response));
    if (createdId !== undefined && createdId !== record.id) return false;
    if (record.creationWriteKey) return write.key === record.creationWriteKey;
  }
  if (identity.id !== undefined)
    return (
      identity.id === record.id &&
      (request.type === undefined || request.type === record.type) &&
      (request.account === undefined ||
        [record.account, ...record.accountAliases].includes(
          String(request.account),
        ))
    );
  return (
    request.type === record.type &&
    typeof request.account === "string" &&
    [record.account, ...record.accountAliases].includes(request.account)
  );
}

export function successfulExecutionWrite(status: unknown, body: unknown) {
  const parsed = object(body);
  return (
    typeof status === "number" &&
    status >= 200 &&
    status < 300 &&
    parsed.success !== false &&
    (parsed.code === undefined ||
      [0, 200, "0", "200", "OK", "SUCCESS"].includes(parsed.code as never))
  );
}
