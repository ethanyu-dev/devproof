import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  structuredObservationSchema,
  type StructuredObservation,
} from "@devproof/runtime-protocol";
import {
  executionStateSchema,
  executionRecordSchema,
  executionRecordDeltaSchema,
  businessTestAccountSchema,
  testAccountBindingsSchema,
  readExecutionState,
  type ExecutionState,
  type RuntimeEvidenceRef,
} from "@devproof/agent-runtime-protocol";
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const parse = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};
const resource = (url: string) => {
  try {
    const u = new URL(url);
    return (
      u.origin +
      u.pathname
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
};
const recordKey = (id: unknown, type: unknown, url?: string) =>
  `${url ? resource(url) : ""}:${String(type ?? "")}:${String(id)}`;
const stableRecordRef = (r: {
  id: string;
  type?: string | undefined;
  resourceUrl?: string | undefined;
  account?: string | undefined;
}) =>
  `record:${createHash("sha256")
    .update(
      JSON.stringify([
        r.resourceUrl ? resource(r.resourceUrl) : "",
        r.type ?? "",
        r.id,
        r.account ?? "",
      ]),
    )
    .digest("hex")}`;
/** Prefer explicit identity, and reject contradictory body/path/query identities. */
export function requestedRecordId(
  url: string,
  request: Record<string, unknown>,
) {
  try {
    const u = new URL(url);
    const tail = u.pathname.split("/").filter(Boolean).at(-1);
    const ids = [
      request.id,
      ...u.searchParams.getAll("id"),
      ...(tail &&
      /^(?:\d+|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu.test(tail)
        ? [tail]
        : []),
    ]
      .filter((v) => v !== undefined && v !== null)
      .map(String);
    return {
      id: ids[0],
      conflict: new Set(ids).size > 1 || u.searchParams.getAll("id").length > 1,
    };
  } catch {
    return { id: undefined, conflict: true };
  }
}
function completeList(body: unknown, url: string): boolean {
  const v = object(body);
  const lists = Array.isArray(body)
    ? [body]
    : [v.data, v.list, v.items, v.records, v.whitelists].filter(Array.isArray);
  if (!lists.length)
    return [v.data, v.result].some(
      (child) => child && typeof child === "object" && completeList(child, url),
    );
  if (lists.length !== 1) return false;
  const list = lists[0]!;
  if (list.length > 100) return false;
  const total = v.total ?? v.totalCount ?? v.total_count;
  if (total !== undefined) return Number(total) === list.length;
  const params = new URL(url).searchParams;
  return ![...params.keys()].some((k) =>
    /page|offset|cursor|limit|size/iu.test(k),
  );
}

// Unlike recursively finding records, this also accounts for malformed rows:
// an unparseable row in a complete list must never prove a type absent.
function listRows(body: unknown, depth = 0): unknown[] | undefined {
  if (depth > 8) return;
  if (Array.isArray(body)) return body;
  const v = object(body);
  const lists = [v.data, v.list, v.items, v.records, v.whitelists].filter(
    Array.isArray,
  );
  if (lists.length) return lists.length === 1 ? lists[0] : undefined;
  const nested = [v.data, v.result].flatMap((child) => {
    const rows =
      child && typeof child === "object"
        ? listRows(child, depth + 1)
        : undefined;
    return rows ? [rows] : [];
  });
  return nested.length === 1 ? nested[0] : undefined;
}

const queryFields = [
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

/** An empty list is relevant only if its query scope includes this record. */
function completeReadCoversRecord(
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
    resource(read.url) !== resource(record.resourceUrl)
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
      queryFields.includes(field),
  );
}

function responseRecordId(response: unknown): string | undefined {
  const body = object(response);
  const id = body.id ?? object(body.data).id ?? object(body.result).id;
  return typeof id === "string" || typeof id === "number"
    ? String(id)
    : undefined;
}
function writeMatchesRecord(
  w: ExecutionState["writes"][number],
  r: ExecutionState["records"][number],
) {
  if (!r.resourceUrl || resource(w.url) !== resource(r.resourceUrl))
    return false;
  const request = object(parse(w.request));
  const identity = requestedRecordId(w.url, request);
  if (identity.conflict) return false;
  if (w.method === "POST") {
    const createdId = responseRecordId(parse(w.response));
    if (createdId !== undefined && createdId !== r.id) return false;
    if (r.creationWriteKey) return w.key === r.creationWriteKey;
  }
  if (identity.id !== undefined)
    return (
      identity.id === r.id &&
      (request.type === undefined || request.type === r.type) &&
      (request.account === undefined ||
        [r.account, ...r.accountAliases].includes(String(request.account)))
    );
  return (
    request.type === r.type &&
    typeof request.account === "string" &&
    [r.account, ...r.accountAliases].includes(request.account)
  );
}

function successful(status: unknown, body: unknown) {
  const r = object(body);
  return (
    typeof status === "number" &&
    status >= 200 &&
    status < 300 &&
    r.success !== false &&
    (r.code === undefined ||
      [0, 200, "0", "200", "OK", "SUCCESS"].includes(r.code as never))
  );
}
function rejectedWrite(w: ExecutionState["writes"][number]) {
  return (
    [400, 401, 403, 404, 405, 409, 415, 422].includes(w.status ?? 0) ||
    (w.confirmed &&
      w.status !== null &&
      w.status >= 200 &&
      w.status < 300 &&
      !successful(w.status, parse(w.response)))
  );
}
function records(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 8 || !value || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.slice(0, 100).flatMap((v) => records(v, depth + 1));
  const v = object(value);
  if (
    (typeof v.id === "string" || typeof v.id === "number") &&
    typeof v.type === "string" &&
    v.account !== undefined
  )
    return [v];
  if (
    (typeof v.id === "string" || typeof v.id === "number") &&
    String(v.id).length > 0 &&
    String(v.id).length <= 500 &&
    typeof v.name === "string" &&
    v.name.trim().length > 0 &&
    v.name.length <= 500 &&
    v.account === undefined
  )
    return [
      { id: v.id, type: "NAMED_RESOURCE", resourceName: v.name, config: v },
    ];
  return Object.values(v).flatMap((child) => records(child, depth + 1));
}
function emptyList(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  const v = object(value);
  return [v.data, v.list, v.items, v.records, v.whitelists].some((child) =>
    Array.isArray(child)
      ? child.length === 0
      : child && typeof child === "object" && emptyList(child),
  );
}

// Business responses may contain empty or malformed optional identity fields.
// They must never become shared aliases linking otherwise unrelated users.
function accountAliases(values: unknown[]) {
  return [
    ...new Set(
      values.flatMap((value) => {
        const parsed = businessTestAccountSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
}

/** Model-writable plan and record deltas; server observations remain authoritative. */
export const executionProgressSchema = z.object({
  phase: executionStateSchema.shape.phase.removeDefault().optional(),
  step: executionStateSchema.shape.step.removeDefault().optional(),
  records: z.array(executionRecordDeltaSchema).max(50).optional(),
  cleanupReview: executionStateSchema.shape.cleanupReview,
});

/** Durable facts are distinct from product verdicts and permission to delete.
 * Ownership requires a complete preflight proving absence, a matching creation,
 * and a subsequent record on the same API resource. HTTP 200 alone is insufficient.
 */
export class ExecutionJournal {
  state: ExecutionState;
  private lastUiObservation?: StructuredObservation;
  private lastUiEvidenceRefs: string[] = [];
  private pendingUiRead = false;
  private invalidateUiConfirmations(recordRef?: string) {
    const refs = new Set(
      this.state.cleanupConfirmations
        .filter(
          (p) => p.source === "UI" && (!recordRef || p.recordRef === recordRef),
        )
        .map((p) => p.recordRef),
    );
    for (const r of this.state.records)
      if (
        r.recordRef &&
        refs.has(r.recordRef) &&
        r.cleanup?.status === "COMPLETED"
      ) {
        r.cleanup.status = "PENDING";
        delete r.cleanup.resolution;
        r.cleanup.note = "后续操作使原核对结果失效，需要重新读取确认。";
      }
    this.state.cleanupConfirmations = this.state.cleanupConfirmations.filter(
      (p) => p.source !== "UI" || (!!recordRef && p.recordRef !== recordRef),
    );
  }
  constructor(policy: Record<string, unknown>) {
    this.state = readExecutionState(policy);
    for (const record of this.state.records)
      record.recordRef ??= stableRecordRef(record);
    const bindings = testAccountBindingsSchema.safeParse(policy.testAccounts);
    if (bindings.success && bindings.data.length) {
      this.state.accounts = bindings.data.map((binding) => ({
        ...binding,
        aliases: [
          ...new Set([
            ...binding.aliases,
            ...(this.state.accounts?.find(
              (old) =>
                old.slotId === binding.slotId &&
                old.account === binding.account,
            )?.aliases ?? []),
          ]),
        ],
      }));
      delete this.state.account;
      this.state.accountAliases = [];
    }
  }
  observe(
    output: unknown,
    evidence: Map<string, RuntimeEvidenceRef>,
    command?: { commandType: string; payload: unknown },
  ) {
    const before = JSON.stringify(this.state),
      root = object(output),
      result = object(root.result);
    const target = object(object(command?.payload).target);
    const clicked = this.lastUiObservation?.nodes.find(
      (n) => n.ref === target.ref,
    );
    const freshUiRead =
      command?.commandType === "page.reload" ||
      (command?.commandType === "page.click" &&
        !!clicked &&
        /^(搜索|查询|刷新|search|refresh|reload)$/iu.test(
          clicked.name ?? clicked.text ?? "",
        ));
    if (
      command &&
      !/\.(snapshot|get_text|get_url|get_title|network|errors|console|screenshot|dom|scroll)$/u.test(
        command.commandType,
      )
    ) {
      this.invalidateUiConfirmations();
      this.pendingUiRead = false;
    }
    if (freshUiRead && root.status === "SUCCEEDED") this.pendingUiRead = true;
    const feedback = object(result.actionFeedback ?? root.actionFeedback);
    const network = parse(result.content);
    const entries = Array.isArray(network) ? network : [];
    const requests: Record<string, unknown>[] = entries.length
      ? entries.map((e) => {
          const r = object(e);
          return {
            ...r,
            requestId: r.requestId ?? r.timestamp,
            requestSummary:
              r.requestBody === undefined
                ? undefined
                : JSON.stringify(r.requestBody),
            responseSummary:
              r.responseBody === undefined
                ? undefined
                : JSON.stringify(r.responseBody),
          };
        })
      : Array.isArray(feedback.requests)
        ? feedback.requests.map(object)
        : [];
    // IDs come from the command's artifacts, not arbitrary model text.
    const refs: string[] = [];
    const findRefs = (v: unknown, depth = 0) => {
      if (depth > 8 || !v || typeof v !== "object") return;
      if (Array.isArray(v)) {
        v.forEach((x) => findRefs(x, depth + 1));
        return;
      }
      const o = object(v);
      if (typeof o.id === "string" && evidence.has(`artifact://${o.id}`))
        refs.push(`artifact://${o.id}`);
      if (Array.isArray(o.evidenceRefs))
        for (const ref of o.evidenceRefs)
          if (typeof ref === "string" && evidence.has(ref)) refs.push(ref);
      if (typeof o.externalId === "string" && evidence.has(o.externalId))
        refs.push(o.externalId);
      Object.values(o).forEach((x) => findRefs(x, depth + 1));
    };
    findRefs(output);
    const evidenceRefs = [...new Set(refs)].slice(-8);
    for (const q of requests) {
      const url = String(q.url ?? ""),
        method = String(q.method),
        body = parse(q.responseSummary);
      if (!url) continue;
      const requestKey =
        typeof q.requestId === "string" && /^[a-f0-9-]{36}$/iu.test(q.requestId)
          ? `request:${q.requestId}`
          : `${String(feedback.commandId ?? "network")}:${String(q.requestId)}`;
      if (!this.state.requestOrder.includes(requestKey)) {
        if (this.state.requestOrder.length < 2000)
          this.state.requestOrder.push(requestKey);
        else this.state.requestOrderTruncated = true;
      }
      const sequence = this.state.requestOrder.indexOf(requestKey);

      const found = records(body);
      const completeBody =
        q.bodyPending !== true &&
        q.pending !== true &&
        q.responseTruncated !== true &&
        q.responseBodyTruncated !== true &&
        q.responseBodyOmitted === undefined &&
        typeof q.responseSummary === "string";
      if (
        method === "GET" &&
        completeBody &&
        successful(q.status, body) &&
        emptyList(body) &&
        completeList(body, url)
      ) {
        try {
          const params = new URL(url).searchParams,
            account = params.get("account"),
            type = params.get("type");
          if (
            account &&
            type &&
            params.getAll("account").length === 1 &&
            params.getAll("type").length === 1 &&
            evidenceRefs.length &&
            [...params.keys()].every((k) =>
              [
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
              ].includes(k),
            )
          ) {
            const key = `${resource(url)}:${type}:${account}`;
            // A later empty read cannot retroactively authorize an earlier POST.
            if (
              !this.state.writes.some(
                (w) =>
                  w.method === "POST" &&
                  (!w.confirmed || successful(w.status, parse(w.response))) &&
                  resource(w.url) === resource(url) &&
                  (!w.request ||
                    ((object(parse(w.request)).account === undefined ||
                      object(parse(w.request)).account === account) &&
                      (object(parse(w.request)).type === undefined ||
                        object(parse(w.request)).type === type))),
              )
            )
              this.state.preflightAbsences = [
                ...new Set([...this.state.preflightAbsences, key]),
              ].slice(-100);
          }
        } catch {
          /* Incomplete URLs cannot establish record ownership. */
        }
      }
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
        // Authentication traffic is not a business mutation receipt.
        !/(?:^|\/)(?:oauth|auth|login|signin|sign-in|token|refresh|session|password)(?:[/?#]|$)/iu.test(
          url,
        ) &&
        evidenceRefs.length
      ) {
        const key = requestKey;
        const uiTypeLabel =
          method === "POST"
            ? this.submittedTypeLabel(object(parse(q.requestSummary)).account)
            : undefined;
        const receipt = {
          key,
          sequence,
          ...(typeof q.timestamp === "string"
            ? { timestamp: q.timestamp }
            : {}),
          method: method as "POST" | "PUT" | "PATCH" | "DELETE",
          url,
          status: typeof q.status === "number" ? q.status : null,
          confirmed: completeBody,
          ...(typeof q.requestSummary === "string"
            ? { request: q.requestSummary.slice(0, 4000) }
            : {}),
          ...(typeof q.responseSummary === "string"
            ? { response: q.responseSummary.slice(0, 4000) }
            : {}),
          evidenceRefs,
          ...(uiTypeLabel ? { uiTypeLabel } : {}),
        };
        const index = this.state.writes.findIndex((w) => w.key === key);
        if (index >= 0) {
          const previous = this.state.writes[index]!;
          this.state.writes[index] =
            previous.confirmed && !receipt.confirmed
              ? {
                  ...previous,
                  evidenceRefs: [
                    ...new Set([
                      ...previous.evidenceRefs,
                      ...receipt.evidenceRefs,
                    ]),
                  ].slice(-20),
                }
              : { ...previous, ...receipt };
          const updated = this.state.writes[index]!;
          if (
            previous.request !== updated.request ||
            previous.response !== updated.response ||
            previous.status !== updated.status ||
            previous.confirmed !== updated.confirmed
          )
            this.invalidateUiConfirmations();
        } else {
          this.state.writes.push(receipt);
          this.invalidateUiConfirmations();
        }
        this.inferCreationAbsence(
          this.state.writes.find((w) => w.key === key)!,
        );
        if (this.state.writes.length > 200) {
          this.state.writeHistoryTruncated = true;
          this.state.writes = this.state.writes.slice(-200);
        }

        if (this.state.phase !== "CLEANUP") {
          this.state.phase = "VERIFYING";
          this.state.step =
            "已观察到业务提交：核对回执、结果与清理责任；缺失请求体时不能宣称没有写入，不重新提交创建。";
        }
      }
      if (!completeBody || !successful(q.status, body)) {
        if (method === "POST" && completeBody && !successful(q.status, body)) {
          const req = object(parse(q.requestSummary));
          this.state.preflightAbsences = this.state.preflightAbsences.filter(
            (k) =>
              k !==
              `${resource(url)}:${String(req.type)}:${String(req.account)}`,
          );
        }
        continue;
      }
      if (method === "GET" && evidenceRefs.length && sequence >= 0) {
        const collection = listRows(body);
        const identities = (collection ?? []).slice(0, 100).flatMap((row) => {
          const direct = object(row);
          const candidate =
            direct.id !== undefined ? (records(row)[0] ?? direct) : direct;
          const aliases = accountAliases([
            candidate.account,
            object(candidate.user).uuid,
            object(candidate.user).phone,
            object(candidate.user).email,
          ]);
          return (typeof candidate.id === "string" ||
            typeof candidate.id === "number") &&
            typeof candidate.type === "string" &&
            candidate.type.length > 0 &&
            candidate.type.length <= 500 &&
            String(candidate.id).length <= 500 &&
            (aliases.length || candidate.resourceName !== undefined)
            ? [
                {
                  id: String(candidate.id),
                  type: candidate.type,
                  accountAliases: aliases,
                },
              ]
            : [];
        });
        const read = {
          key: requestKey,
          url,
          sequence,
          ...(typeof q.timestamp === "string"
            ? { timestamp: q.timestamp }
            : {}),
          empty: emptyList(body),
          complete: completeList(body, url),
          identitiesComplete:
            !!collection &&
            collection.length <= 100 &&
            identities.length === collection.length,
          identities,
          recordKeys: found.map((r) => recordKey(r.id, r.type, url)),
          namedResources: found.flatMap((r) =>
            typeof r.resourceName === "string"
              ? [{ id: String(r.id), name: r.resourceName }]
              : [],
          ),
          recordStates: Object.fromEntries(
            found.flatMap((r) => {
              if (r.config === undefined) return [];
              const value = JSON.stringify(parse(r.config) ?? r.config);
              // A truncated value cannot establish restoration of the full state.
              return value.length <= 2000
                ? [[recordKey(r.id, r.type, url), value]]
                : [];
            }),
          ),
          evidenceRefs,
        };
        const previous = this.state.readReceipts.find(
          (r) => r.key === requestKey,
        );
        if (
          !previous ||
          !isDeepStrictEqual(previous.recordStates, read.recordStates)
        ) {
          for (const record of this.state.records) {
            const actual =
              read.recordStates[
                recordKey(record.id, record.type, record.resourceUrl)
              ];
            if (
              record.recordRef &&
              actual !== undefined &&
              record.initialState !== undefined &&
              !isDeepStrictEqual(
                parse(actual) ?? actual,
                parse(record.initialState) ?? record.initialState,
              )
            )
              this.invalidateUiConfirmations(record.recordRef);
          }
        }
        this.state.readReceipts = [
          ...this.state.readReceipts.filter((r) => r.key !== requestKey),
          read,
        ].slice(-200);
      }
      for (const candidate of found) {
        // Named resources are reconciled against their own pre-create read and
        // unique write receipt below, never against a fabricated account.
        if (candidate.resourceName !== undefined) continue;
        const id = String(candidate.id),
          type = String(candidate.type),
          key = recordKey(id, type, url);
        const aliases = accountAliases([
          candidate.account,
          object(candidate.user).uuid,
          object(candidate.user).phone,
          object(candidate.user).email,
        ]);
        if (this.state.account && aliases.includes(this.state.account))
          this.state.accountAliases = [
            ...new Set([...this.state.accountAliases, ...aliases]),
          ].slice(0, 20);
        for (const binding of this.state.accounts ?? []) {
          if (
            aliases.includes(binding.account) ||
            binding.aliases.some((alias) => aliases.includes(alias))
          )
            binding.aliases = [
              ...new Set([...binding.aliases, ...aliases]),
            ].slice(0, 20);
        }
        const existing = this.state.records.find(
          (r) => recordKey(r.id, r.type, r.resourceUrl) === key,
        );
        if (existing) {
          if (candidate.config !== undefined)
            existing.currentState = JSON.stringify(
              parse(candidate.config) ?? candidate.config,
            ).slice(0, 2000);
          continue;
        }
        const assigned =
          !this.state.accounts?.length ||
          this.state.accounts.some(
            (a) =>
              [a.account, ...a.aliases].some((v) => aliases.includes(v)) &&
              (!a.requiredTypes.length || a.requiredTypes.includes(type)),
          );
        if (method === "GET" && assigned && sequence >= 0) {
          const baseline = {
            id,
            type,
            resourceUrl: resource(url),
            account: aliases[0],
            accountAliases: aliases,
            ownership: "EXISTING" as const,
            baselineObservation: {
              readKey: requestKey,
              sequence,
              ...(typeof q.timestamp === "string"
                ? { timestamp: q.timestamp }
                : {}),
            },
            ...(candidate.config !== undefined
              ? {
                  initialState: JSON.stringify(
                    parse(candidate.config) ?? candidate.config,
                  ),
                  currentState: JSON.stringify(
                    parse(candidate.config) ?? candidate.config,
                  ),
                }
              : {}),
            evidenceRefs,
          };
          if (
            this.baselinePrecedesWrites(baseline) &&
            !this.state.observedRecords.some(
              (r) => recordKey(r.id, r.type, r.resourceUrl) === key,
            ) &&
            this.state.observedRecords.length < 100 &&
            (baseline.initialState?.length ?? 0) <= 2000
          )
            this.state.observedRecords.push({
              ...baseline,
              recordRef: stableRecordRef(baseline),
            });
        }
        if (this.state.existingRecordKeys.includes(key)) continue;
        const observed = {
          id,
          type,
          resourceUrl: resource(url),
          accountAliases: aliases,
          currentState: JSON.stringify(
            parse(candidate.config) ?? candidate.config ?? null,
          ).slice(0, 2000),
          evidenceRefs,
        };
        const creation = this.matchingCreation(observed);
        const creationAccount = object(parse(creation?.request)).account;
        const matchingResults = found.filter(
          (r) =>
            r.type === type &&
            accountAliases([
              r.account,
              object(r.user).uuid,
              object(r.user).phone,
              object(r.user).email,
            ]).includes(String(creationAccount)),
        );
        if (
          creation &&
          evidenceRefs.length &&
          (responseRecordId(parse(creation.response)) !== undefined ||
            matchingResults.length === 1)
        ) {
          const index = this.state.pendingRecords.findIndex(
            (r) => recordKey(r.id, r.type, r.resourceUrl) === key,
          );
          if (index >= 0) this.state.pendingRecords[index] = observed;
          else if (this.state.pendingRecords.length < 50)
            this.state.pendingRecords.push(observed);
        } else {
          this.state.existingRecordKeys = [
            ...new Set([...this.state.existingRecordKeys, key]),
          ].slice(-200);
        }
      }
    }
    // Body capture can finish after the list response, including on a later lease.
    // Retain the list evidence until the matching receipt confirms or rejects creation.
    this.state.pendingRecords = this.state.pendingRecords.filter((record) => {
      const creation = this.matchingCreation(record, false);
      if (!creation?.confirmed) return true;
      if (!successful(creation.status, parse(creation.response))) {
        this.state.existingRecordKeys = [
          ...new Set([
            ...this.state.existingRecordKeys,
            recordKey(record.id, record.type, record.resourceUrl),
          ]),
        ].slice(-200);
        return false;
      }
      if (this.state.records.length >= 50) return true;
      this.state.records.push({
        ...record,
        recordRef: stableRecordRef({
          ...record,
          account: String(object(parse(creation.request)).account),
        }),
        account: String(object(parse(creation.request)).account),
        ownership: "CREATED_THIS_RUN",
        evidenceRefs: [
          ...new Set([...creation.evidenceRefs, ...record.evidenceRefs]),
        ].slice(-20),
        cleanup: {
          instruction: "核对本次创建证据与当前状态后，执行 Spec 约定的清理。",
          status: "PENDING",
        },
      });
      return false;
    });
    this.reconcileNamedResources();
    this.registerObservedMutations();
    this.reconcileCleanup();
    const ui = structuredObservationSchema.safeParse(
      result.structuredObservation,
    );
    if (ui.success) {
      this.observeUi(ui.data, evidenceRefs, this.pendingUiRead);
      this.pendingUiRead = false;
      this.lastUiObservation = ui.data;
      this.lastUiEvidenceRefs = evidenceRefs;
    }
    this.reconcileReview();
    return before !== JSON.stringify(this.state);
  }

  private inferCreationAbsence(write: ExecutionState["writes"][number]) {
    const request = object(parse(write.request));
    if (
      write.method !== "POST" ||
      write.sequence === undefined ||
      this.state.requestOrderTruncated ||
      this.state.writeHistoryTruncated ||
      typeof request.account !== "string" ||
      typeof request.type !== "string"
    )
      return;
    // A second submit cannot reuse an old absence proof to claim another record.
    if (
      this.state.writes.some(
        (w) =>
          w.key !== write.key &&
          w.method === "POST" &&
          (w.sequence ?? -1) < write.sequence! &&
          resource(w.url) === resource(write.url) &&
          (!w.confirmed || successful(w.status, parse(w.response))) &&
          (object(parse(w.request)).account === undefined ||
            object(parse(w.request)).account === request.account) &&
          (object(parse(w.request)).type === undefined ||
            object(parse(w.request)).type === request.type),
      )
    )
      return;
    const read = [...this.state.readReceipts]
      .sort((a, b) => b.sequence - a.sequence)
      .find((r) => {
        if (
          resource(r.url) !== resource(write.url) ||
          r.sequence >= write.sequence! ||
          (r.timestamp &&
            write.timestamp &&
            !(Date.parse(r.timestamp) < Date.parse(write.timestamp)))
        )
          return false;
        const params = new URL(r.url).searchParams;
        return (
          params.getAll("account").length === 1 &&
          params.get("account") === request.account &&
          params.getAll("type").length <= 1 &&
          (!params.has("type") || params.get("type") === request.type) &&
          [...params.keys()].every((field) => queryFields.includes(field))
        );
      });
    if (
      !read?.complete ||
      !read.identitiesComplete ||
      !read.evidenceRefs.length ||
      !read.identities.every((r) =>
        r.accountAliases.includes(request.account as string),
      ) ||
      read.identities.some((r) => r.type === request.type)
    )
      return;
    this.state.preflightAbsences = [
      ...new Set([
        ...this.state.preflightAbsences,
        `${resource(write.url)}:${request.type}:${request.account}`,
      ]),
    ].slice(-100);
  }

  private baselinePrecedesWrites(record: ExecutionState["records"][number]) {
    const baseline = record.baselineObservation;
    if (
      !baseline ||
      this.state.requestOrderTruncated ||
      this.state.writeHistoryTruncated
    )
      return false;
    return this.state.writes.every((write) => {
      if (rejectedWrite(write) || resource(write.url) !== record.resourceUrl)
        return true;
      const request = object(parse(write.request));
      const identity = requestedRecordId(write.url, request);
      // An unidentified mutation might affect this record. Do not assume that a
      // subsequent read is a baseline while its request body is still missing.
      if (!identity.conflict) {
        if (identity.id !== undefined && identity.id !== record.id) return true;
        if (identity.id === undefined) {
          if (request.type !== undefined && request.type !== record.type)
            return true;
          if (
            request.account !== undefined &&
            ![record.account, ...record.accountAliases].includes(
              String(request.account),
            )
          )
            return true;
        }
      }
      return (
        write.sequence !== undefined &&
        baseline.sequence < write.sequence &&
        (!baseline.timestamp ||
          !write.timestamp ||
          Date.parse(baseline.timestamp) < Date.parse(write.timestamp))
      );
    });
  }

  /** Bind accountless collections by endpoint + exact name + pre-write absence.
   * A successful response alone is not ownership, and ID changes are never guessed.
   */
  private reconcileNamedResources() {
    if (this.state.requestOrderTruncated || this.state.writeHistoryTruncated)
      return;
    for (const read of [...this.state.readReceipts].sort(
      (a, b) => a.sequence - b.sequence,
    )) {
      for (const item of read.namedResources ?? []) {
        const identity = {
          id: item.id,
          type: "NAMED_RESOURCE",
          resourceUrl: resource(read.url),
          resourceName: item.name,
          accountAliases: [] as string[],
        };
        const key = recordKey(identity.id, identity.type, identity.resourceUrl);
        const existing = this.state.records.find(
          (r) => recordKey(r.id, r.type, r.resourceUrl) === key,
        );
        if (existing) {
          const rename = this.state.writes.find(
            (w) =>
              ["PUT", "PATCH"].includes(w.method) &&
              w.confirmed &&
              successful(w.status, parse(w.response)) &&
              writeMatchesRecord(w, existing) &&
              w.sequence !== undefined &&
              w.sequence < read.sequence &&
              object(parse(w.request)).name === item.name,
          );
          if (rename) existing.resourceName = item.name;
          if (read.recordStates[key])
            existing.currentState = read.recordStates[key];
          continue;
        }
        const creates = this.state.writes.filter((w) => {
          const response = parse(w.response);
          if (
            w.method !== "POST" ||
            !w.confirmed ||
            response === undefined ||
            !successful(w.status, response) ||
            resource(w.url) !== identity.resourceUrl ||
            w.sequence === undefined ||
            w.sequence >= read.sequence ||
            (w.timestamp &&
              read.timestamp &&
              Date.parse(w.timestamp) >= Date.parse(read.timestamp))
          )
            return false;
          const request = object(parse(w.request));
          const responseId = responseRecordId(response);
          if (
            request.name !== item.name ||
            request.account !== undefined ||
            request.id !== undefined ||
            (responseId !== undefined && responseId !== item.id)
          )
            return false;
          const prior = this.state.readReceipts
            .filter(
              (r) =>
                r.sequence < w.sequence! &&
                completeReadCoversRecord(r, identity) &&
                (!r.timestamp ||
                  !w.timestamp ||
                  Date.parse(r.timestamp) < Date.parse(w.timestamp)),
            )
            .sort((a, b) => b.sequence - a.sequence)[0];
          if (
            !prior ||
            prior.namedResources.some(
              (r) => r.id === item.id || r.name === item.name,
            )
          )
            return false;
          // Any intervening ambiguous write can have created/modified this name.
          return !this.state.writes.some((other) => {
            if (
              other.key === w.key ||
              rejectedWrite(other) ||
              resource(other.url) !== identity.resourceUrl ||
              other.sequence === undefined ||
              other.sequence <= prior.sequence ||
              other.sequence >= read.sequence
            )
              return false;
            const otherRequest = object(parse(other.request));
            return (
              otherRequest.name === item.name ||
              (otherRequest.name === undefined &&
                requestedRecordId(other.url, otherRequest).id === undefined)
            );
          });
        });
        if (
          creates.length === 1 &&
          read.identitiesComplete &&
          read.namedResources.filter((r) => r.name === item.name).length ===
            1 &&
          !this.state.records.some(
            (r) => r.creationWriteKey === creates[0]!.key,
          ) &&
          !this.state.existingRecordKeys.includes(key) &&
          this.state.records.length < 50
        ) {
          const creation = creates[0]!;
          this.state.records.push({
            ...identity,
            recordRef: stableRecordRef(identity),
            creationWriteKey: creation.key,
            ownership: "CREATED_THIS_RUN",
            ...(read.recordStates[key]
              ? { currentState: read.recordStates[key] }
              : {}),
            evidenceRefs: [
              ...new Set([...creation.evidenceRefs, ...read.evidenceRefs]),
            ].slice(-20),
            cleanup: {
              status: "PENDING",
              instruction:
                "按 Spec 清理本次创建的资源，并按 ID 或唯一名称重新查询确认。",
            },
          });
        } else if (read.recordStates[key]) {
          const baseline = {
            ...identity,
            recordRef: stableRecordRef(identity),
            ownership: "EXISTING" as const,
            initialState: read.recordStates[key]!,
            currentState: read.recordStates[key]!,
            baselineObservation: {
              readKey: read.key,
              sequence: read.sequence,
              ...(read.timestamp ? { timestamp: read.timestamp } : {}),
            },
            evidenceRefs: read.evidenceRefs,
          };
          if (
            this.baselinePrecedesWrites(baseline) &&
            this.state.observedRecords.length < 100 &&
            !this.state.observedRecords.some(
              (r) => r.recordRef === baseline.recordRef,
            )
          ) {
            this.state.observedRecords.push(baseline);
            this.state.existingRecordKeys = [
              ...new Set([...this.state.existingRecordKeys, key]),
            ].slice(-200);
          }
        }
      }
    }
  }

  private registerObservedMutations() {
    for (const write of this.state.writes) {
      if (
        !["PUT", "PATCH", "DELETE"].includes(write.method) ||
        rejectedWrite(write)
      )
        continue;
      const matches = this.state.observedRecords.filter(
        (r) => writeMatchesRecord(write, r) && this.baselinePrecedesWrites(r),
      );
      if (matches.length !== 1 || this.state.records.length >= 50) continue;
      const baseline = matches[0]!;
      if (this.state.records.some((r) => r.recordRef === baseline.recordRef))
        continue;
      this.state.records.push({
        ...baseline,
        cleanup: {
          instruction: "按修改前观察到的状态恢复既有记录，并重新读取核对。",
          status: "PENDING",
        },
      });
    }
  }

  private reconcileReview() {
    const review = this.state.cleanupReview;
    if (!review) return;
    const unresolved = new Set(this.unresolvedWrites().map((w) => w.key));
    if (this.state.writeHistoryTruncated) unresolved.add("history:truncated");
    const remaining = review.writeKeys.filter((key) => unresolved.has(key));
    if (remaining.length) review.writeKeys = remaining;
    else delete this.state.cleanupReview;
  }
  private observeUi(
    observation: StructuredObservation,
    evidenceRefs: string[],
    freshRead: boolean,
  ) {
    if (
      !evidenceRefs.length ||
      !observation.coverage.completeWithinScope ||
      observation.coverage.truncated
    )
      return;
    const byId = new Map(observation.nodes.map((n) => [n.nodeId, n]));
    const rows = observation.nodes.filter(
      (n) => n.visible && (n.tag === "tr" || n.role === "row"),
    );
    const values = (row: StructuredObservation["nodes"][number]) =>
      observation.nodes.flatMap((n) => {
        if (!n.visible || n.truncatedProperties?.length) return [];
        let parent = n;
        const seen = new Set<string>();
        while (parent.nodeId !== row.nodeId) {
          if (
            seen.has(parent.nodeId) ||
            ((parent.tag === "button" || parent.role === "button") &&
              n.checked === undefined)
          )
            return [];
          seen.add(parent.nodeId);
          const next = byId.get(parent.parentId ?? "");
          if (!next) return [];
          parent = next;
        }
        return n.checked !== undefined
          ? [`checked:${n.checked}`]
          : n.value !== undefined
            ? [`value:${n.value}`]
            : n.text?.trim()
              ? [n.text.trim()]
              : [];
      });
    const observedRows = rows
      .filter(
        (r) =>
          observation.consistency === "VERIFIED" ||
          observation.verifiedScopeNodeIds?.includes(r.nodeId),
      )
      .map((row) => ({ row, values: values(row) }));
    const known = [...this.state.observedRecords, ...this.state.records];
    for (const record of known) {
      const aliases = [record.account, ...record.accountAliases].filter(
        (v): v is string => !!v,
      );
      if (!aliases.length || !record.recordRef) continue;
      if (
        known.some(
          (other) =>
            other.recordRef !== record.recordRef &&
            other.id === record.id &&
            other.resourceUrl !== record.resourceUrl &&
            [other.account, ...other.accountAliases].some(
              (v) => v && aliases.includes(v),
            ),
        )
      )
        continue;
      const candidates = observedRows.filter((r) =>
        r.values.some((v) => aliases.includes(v)),
      );
      const stateValues = (v: string[]) =>
        v.filter((s) => s !== record.id && !aliases.includes(s));
      if (
        record.uiBaseline?.pageIdentity === observation.pageIdentity &&
        candidates.some((r) => r.values.includes(record.id)) &&
        !candidates.some((r) =>
          isDeepStrictEqual(stateValues(r.values), record.uiBaseline!.values),
        )
      )
        this.invalidateUiConfirmations(record.recordRef);
      if (
        !record.uiBaseline &&
        !this.state.writes.some((w) => writeMatchesRecord(w, record))
      ) {
        const identified = candidates.filter((r) =>
          r.values.includes(record.id),
        );
        if (identified.length === 1) {
          const states = stateValues(identified[0]!.values);
          // Scope the UI fallback to an actually readable boolean state. An
          // identity-only row (e.g. its status column is clipped) proves nothing
          // about restoration of a hidden configuration.
          const booleans = states.filter((v) =>
            /^(checked:(true|false)|启用|禁用|开启|关闭|enabled|disabled|on|off)$/iu.test(
              v,
            ),
          );
          if (
            booleans.length === 1 &&
            states.length <= 100 &&
            states.every((v) => v.length <= 500)
          )
            record.uiBaseline = {
              observationId: observation.captureId,
              pageIdentity: observation.pageIdentity,
              capturedAt: observation.capturedUntil,
              values: states,
              evidenceRefs,
            };
        }
      }
      if (
        !freshRead ||
        !record.cleanup ||
        !record.uiBaseline ||
        record.uiBaseline.pageIdentity !== observation.pageIdentity ||
        Date.parse(observation.capturedFrom) <=
          Date.parse(record.uiBaseline.capturedAt) ||
        observation.captureId === record.uiBaseline.observationId
      )
        continue;
      const matching = candidates.filter(
        (r) =>
          r.values.includes(record.id) &&
          isDeepStrictEqual(stateValues(r.values), record.uiBaseline!.values),
      );
      if (matching.length !== 1 || record.ownership !== "EXISTING") continue;
      const mutation = this.state.writes
        .filter((w) => writeMatchesRecord(w, record) && !rejectedWrite(w))
        .at(-1);
      if (mutation && !["PUT", "PATCH"].includes(mutation.method)) continue;
      // A concrete conflicting receipt needs reconciliation, even when the UI
      // appears restored. Missing network capture alone does not disprove UI.
      if (mutation && record.initialState !== undefined) {
        const request = object(parse(mutation.request));
        if (
          request.config !== undefined &&
          !isDeepStrictEqual(
            parse(request.config) ?? request.config,
            parse(record.initialState) ?? record.initialState,
          )
        )
          continue;
      }
      const key = recordKey(record.id, record.type, record.resourceUrl);
      const latestRead = this.state.readReceipts
        .filter((read) => read.recordKeys.includes(key))
        .sort((a, b) => b.sequence - a.sequence)[0];
      const actual = latestRead?.recordStates[key];
      if (
        actual !== undefined &&
        record.initialState !== undefined &&
        (!mutation || latestRead!.sequence > (mutation.sequence ?? -1)) &&
        !isDeepStrictEqual(
          parse(actual) ?? actual,
          parse(record.initialState) ?? record.initialState,
        )
      )
        continue;
      this.state.cleanupConfirmations = this.state.cleanupConfirmations.filter(
        (p) => p.recordRef !== record.recordRef,
      );
      this.state.cleanupConfirmations.push({
        source: "UI",
        recordRef: record.recordRef,
        writeKey: mutation?.key ?? `ui:${record.uiBaseline.observationId}`,
        readKey: `ui:${observation.captureId}`,
        evidenceRefs,
      });
      record.cleanup = {
        ...record.cleanup,
        status: "COMPLETED",
        resolution: "RESTORED",
        note: "已刷新页面并确认同一记录恢复到修改前状态。",
      };
      record.evidenceRefs = [
        ...new Set([...record.evidenceRefs, ...evidenceRefs]),
      ].slice(-20);
    }
  }
  private submittedTypeLabel(account: unknown) {
    const obs = this.lastUiObservation;
    if (!obs || typeof account !== "string") return;
    const nodes = new Map(obs.nodes.map((n) => [n.nodeId, n]));
    const within = (
      node: StructuredObservation["nodes"][number],
      id: string,
    ) => {
      let current: typeof node | undefined = node;
      const seen = new Set<string>();
      while (current && !seen.has(current.nodeId)) {
        if (current.nodeId === id) return true;
        seen.add(current.nodeId);
        current = nodes.get(current.parentId ?? "");
      }
      return false;
    };
    const forms = obs.nodes.filter(
      (n) =>
        n.visible &&
        (n.tag === "form" || n.role === "form") &&
        obs.nodes.some(
          (field) =>
            field.visible && field.value === account && within(field, n.nodeId),
        ),
    );
    const labels = new Set(
      forms.flatMap((form) =>
        obs.nodes
          .filter(
            (n) =>
              n.visible &&
              n.selectedLabelSource &&
              n.selectedLabel &&
              !n.truncatedProperties?.length &&
              within(n, form.nodeId),
          )
          .map((n) => n.selectedLabel!),
      ),
    );
    return labels.size === 1 ? [...labels][0] : undefined;
  }
  /** A visible result row can complete the creation chain when the list JSON
   * body is unavailable; identity still comes from the preflight and submit. */
  private createdUiRecord(change: z.input<typeof executionRecordDeltaSchema>) {
    const obs = this.lastUiObservation;
    if (
      !obs ||
      !change.id ||
      !this.lastUiEvidenceRefs.length ||
      !obs.coverage.completeWithinScope ||
      obs.coverage.truncated
    )
      return;
    const byId = new Map(obs.nodes.map((n) => [n.nodeId, n]));
    for (const write of [...this.state.writes].reverse()) {
      const request = object(parse(write.request));
      if (
        write.method !== "POST" ||
        !write.confirmed ||
        !successful(write.status, parse(write.response)) ||
        !write.uiTypeLabel ||
        ![write.uiTypeLabel, request.type].includes(change.type) ||
        typeof request.account !== "string" ||
        typeof request.type !== "string" ||
        !this.state.preflightAbsences.includes(
          `${resource(write.url)}:${request.type}:${request.account}`,
        ) ||
        (change.account && change.account !== request.account)
      )
        continue;
      try {
        if (new URL(obs.pageIdentity).origin !== new URL(write.url).origin)
          continue;
      } catch {
        continue;
      }
      const rows = new Map<string, Set<string>>();
      for (const n of obs.nodes) {
        if (!n.visible || n.truncatedProperties?.length || !n.text) continue;
        let parent = n;
        const seen = new Set<string>();
        while (parent.tag !== "tr" && parent.role !== "row") {
          if (seen.has(parent.nodeId)) break;
          seen.add(parent.nodeId);
          const next = byId.get(parent.parentId ?? "");
          if (!next) break;
          parent = next;
        }
        if (
          (parent.tag === "tr" || parent.role === "row") &&
          (obs.consistency === "VERIFIED" ||
            obs.verifiedScopeNodeIds?.includes(parent.nodeId))
        ) {
          const values = rows.get(parent.nodeId) ?? new Set<string>();
          values.add(n.text.trim());
          rows.set(parent.nodeId, values);
        }
      }
      const matches = [...rows.values()].filter(
        (v) =>
          v.has(change.id!) &&
          v.has(request.account as string) &&
          v.has(write.uiTypeLabel!),
      );
      if (matches.length !== 1) continue;
      const record = {
        id: change.id,
        type: request.type,
        displayType: write.uiTypeLabel,
        resourceUrl: resource(write.url),
        account: request.account,
        accountAliases: [request.account],
        ownership: "CREATED_THIS_RUN" as const,
        evidenceRefs: [
          ...new Set([...write.evidenceRefs, ...this.lastUiEvidenceRefs]),
        ].slice(-20),
        cleanup: {
          instruction: "完成验证后清理本次创建记录并重新查询",
          status: "PENDING" as const,
        },
      };
      return { ...record, recordRef: stableRecordRef(record) };
    }
  }
  private matchingCreation(
    record: ExecutionState["pendingRecords"][number],
    requireAbsence = true,
  ) {
    return [...this.state.writes].reverse().find((w) => {
      const request = object(parse(w.request));
      return (
        w.method === "POST" &&
        resource(w.url) === record.resourceUrl &&
        request.type === record.type &&
        record.accountAliases.includes(request.account as string) &&
        (responseRecordId(parse(w.response)) === undefined ||
          responseRecordId(parse(w.response)) === record.id) &&
        (!requireAbsence ||
          this.state.preflightAbsences.includes(
            `${record.resourceUrl}:${record.type}:${String(request.account)}`,
          ))
      );
    });
  }
  update(
    next: z.input<typeof executionProgressSchema> & {
      account?: string | undefined;
    },
  ) {
    const account = next.account;
    if (
      account !== undefined &&
      account !== this.state.account &&
      !this.state.accounts?.some((binding) =>
        [binding.account, ...binding.aliases].includes(account),
      )
    )
      throw new Error(
        "record_progress 不能分配或更换测试账号；请通过 TEST_ACCOUNT 人工输入获取账号。",
      );
    const delta = executionProgressSchema.parse(next);
    const mergedRecords = [...this.state.records];
    for (const change of delta.records ?? []) {
      if (
        change.ownership === "CREATED_THIS_RUN" &&
        !mergedRecords.some(
          (r) =>
            r.id === change.id &&
            (r.type === change.type || r.displayType === change.type),
        )
      ) {
        const created = this.createdUiRecord(change);
        if (created) {
          this.state.records.push(created);
          mergedRecords.push(created);
          Object.assign(change, {
            recordRef: created.recordRef,
            type: created.type,
            resourceUrl: created.resourceUrl,
            account: created.account,
            accountAliases: created.accountAliases,
          });
        }
      }
      // Resolve a real baseline before locking identity. A display label is not
      // an API enum, and a model-authored sentence cannot replace observed JSON.
      const observed = this.state.observedRecords.filter(
        (r) =>
          (change.recordRef
            ? r.recordRef === change.recordRef
            : r.id === change.id) &&
          (!change.resourceUrl ||
            resource(change.resourceUrl) === r.resourceUrl) &&
          (!change.account ||
            [r.account, ...r.accountAliases].includes(change.account)),
      );
      if (observed.length > 1)
        throw new Error(
          "记录身份不唯一，请使用 observedRecords 中的 recordRef。",
        );
      const baseline = observed[0];
      if (
        baseline &&
        !mergedRecords.some((r) => r.recordRef === baseline.recordRef)
      ) {
        if (!this.baselinePrecedesWrites(baseline))
          throw new Error(
            "无法确认该状态来自写入前的观察，不能用修改后的状态作为恢复基线。",
          );
        const suppliedRefs = change.evidenceRefs ?? [];
        if (!suppliedRefs.length)
          throw new Error("登记记录必须引用已交付的观察。");
        if (change.ownership && change.ownership !== "EXISTING")
          throw new Error(
            "修改前已观察到的记录属于 EXISTING，不能声明为本次创建。",
          );
        mergedRecords.push({
          ...baseline,
          ...(change.type && change.type !== baseline.type
            ? { displayType: change.type }
            : {}),
        });
        Object.assign(change, {
          recordRef: baseline.recordRef,
          id: baseline.id,
          type: baseline.type,
          resourceUrl: baseline.resourceUrl,
          account: baseline.account,
          accountAliases: baseline.accountAliases,
          ownership: baseline.ownership,
          initialState: baseline.initialState,
          currentState: baseline.currentState,
        });
      }
      const candidates = mergedRecords.filter((r) =>
        change.recordRef
          ? r.recordRef === change.recordRef
          : r.id === change.id &&
            (change.type === undefined || r.type === change.type) &&
            (change.resourceUrl === undefined ||
              resource(r.resourceUrl ?? "") === resource(change.resourceUrl)),
      );
      if (candidates.length > 1)
        throw new Error("记录身份不唯一，请使用当前台账的 recordRef。");
      const locked = candidates[0];
      if (
        !locked &&
        change.ownership === "EXISTING" &&
        change.initialState !== undefined &&
        parse(change.initialState) === undefined
      )
        throw new Error(
          "INITIAL_STATE_FORMAT: initialState 必须是修改前状态的 JSON；优先引用 observedRecords 的 recordRef，由平台继承，不填写自然语言说明。",
        );
      if (change.recordRef && !locked)
        throw new Error("未知 recordRef，请引用当前台账中的记录。");
      if (
        locked &&
        ["id", "type", "resourceUrl", "account", "recordRef"].some(
          (k) =>
            Object.hasOwn(change, k) &&
            change[k as keyof typeof change] !==
              locked[k as keyof typeof locked],
        )
      )
        throw new Error("记录身份不可由进度更新修改。");
      if (
        locked &&
        change.accountAliases &&
        JSON.stringify([...change.accountAliases].sort()) !==
          JSON.stringify([...locked.accountAliases].sort())
      )
        throw new Error("账号别名由真实观察维护，不能通过进度更新修改。");
      const record = executionRecordSchema.parse({
        ...locked,
        ...change,
        uiBaseline: locked?.uiBaseline,
        baselineObservation: locked?.baselineObservation,
      });
      if (record.cleanup?.status === "RETAINED") {
        if (
          !locked ||
          locked.ownership !== "CREATED_THIS_RUN" ||
          !record.cleanup.note?.trim()
        )
          throw new Error(
            "按计划保留仅适用于已确认本次创建的记录，须说明 Spec 保留依据和后续用途；既有数据应恢复原状。",
          );
        const proof = this.retentionRead(locked);
        if (!proof)
          throw new Error(
            "保留记录前须确认最后一次提交成功，并重新读取同一记录的当前状态。",
          );
        record.cleanup.retainedAtWriteKey = proof.mutation.key;
        record.evidenceRefs = [
          ...new Set([...record.evidenceRefs, ...proof.read.evidenceRefs]),
        ].slice(-20);
      }
      record.recordRef ??= stableRecordRef(record);
      const index = locked ? mergedRecords.indexOf(locked) : -1;
      if (index < 0) mergedRecords.push(record);
      else mergedRecords[index] = record;
    }
    const parsed = executionStateSchema.parse({
      ...this.state,
      ...delta,
      records: mergedRecords,
    });
    if (delta.cleanupReview) {
      const unresolved = new Set(this.unresolvedWrites().map((w) => w.key));
      if (this.state.writeHistoryTruncated) unresolved.add("history:truncated");
      if (delta.cleanupReview.writeKeys.some((key) => !unresolved.has(key)))
        throw new Error(
          "清理核对只能关联当前未确认归属的提交；请从 unreviewedWriteKeys 读取 writeKeys。",
        );
    }
    for (const record of parsed.records) {
      const locked = this.state.records.find(
        (r) =>
          recordKey(r.id, r.type, r.resourceUrl) ===
          recordKey(record.id, record.type, record.resourceUrl),
      );
      if (locked && locked.ownership !== record.ownership)
        throw new Error("已确认的业务对象归属不能被后续计划覆盖。");
      if (
        locked?.initialState !== undefined &&
        locked.initialState !== record.initialState
      )
        throw new Error("初始业务状态必须保留，不能用修改后的状态覆盖。");
      if (
        record.ownership === "CREATED_THIS_RUN" &&
        !this.state.records.some(
          (r) =>
            recordKey(r.id, r.type, r.resourceUrl) ===
              recordKey(record.id, record.type, record.resourceUrl) &&
            r.ownership === "CREATED_THIS_RUN",
        )
      )
        throw new Error(
          "本次创建归属必须来自已观察的前置查询、提交与结果；不能凭计划声明创建成功。请核对该账号与类型已提交的精确查询、完整空结果、成功 POST 及后续记录；只填写筛选框不构成前置查询。",
        );
      if (record.cleanup?.status === "BLOCKED" && !record.cleanup.note?.trim())
        throw new Error("清理受阻时必须记录原因与具体待处理动作。");
      const prior = this.state.records.find(
        (r) =>
          recordKey(r.id, r.type, r.resourceUrl) ===
          recordKey(record.id, record.type, record.resourceUrl),
      );
      if (
        record.cleanup?.status === "COMPLETED" &&
        prior?.cleanup?.status !== "COMPLETED" &&
        !this.state.cleanupConfirmations.some(
          (proof) =>
            proof.recordRef === record.recordRef &&
            proof.evidenceRefs.some((ref) => record.evidenceRefs.includes(ref)),
        )
      )
        throw new Error(
          "清理完成必须引用重新核对结果的证据：成功删除后精确查询或完整列表确认不存在，或恢复初始值后重新读取确认；仅更换附件编号不能证明清理。",
        );
    }
    if (parsed.phase === "PREFLIGHT" && this.state.writes.length)
      throw new Error(
        "已观察到提交，不能退回 PREFLIGHT；请核对结果和清理责任。",
      );
    this.state = {
      ...parsed,
      ...(this.state.account ? { account: this.state.account } : {}),
      accounts: this.state.accounts,
      accountAliases: this.state.accountAliases,
      pendingRecords: this.state.pendingRecords,
      observedRecords: this.state.observedRecords,
      writeHistoryTruncated: this.state.writeHistoryTruncated,
      writes: this.state.writes,
      preflightAbsences: this.state.preflightAbsences,
      existingRecordKeys: [
        ...new Set([
          ...this.state.existingRecordKeys,
          ...parsed.records
            .filter((r) => r.ownership === "EXISTING")
            .map((r) => recordKey(r.id, r.type, r.resourceUrl)),
        ]),
      ].slice(-200),
    };
    if (this.lastUiObservation)
      this.observeUi(this.lastUiObservation, this.lastUiEvidenceRefs, false);
    this.reconcileCleanup();
    this.reconcileReview();
  }
  /** Independent records can make progress even if a different record is rejected. */
  updatePartial(
    next: z.input<typeof executionProgressSchema> & {
      account?: string | undefined;
    },
  ) {
    const { records, ...other } = next;
    this.update(other);
    const results = [];
    for (const record of records ?? []) {
      try {
        this.update({ records: [record] });
        results.push({
          recordRef: record.recordRef,
          id: record.id,
          accepted: true,
        });
      } catch (error) {
        results.push({
          recordRef: record.recordRef,
          id: record.id,
          accepted: false,
          error: String(error),
        });
      }
    }
    return results;
  }
  /** Record all outstanding cleanup obligations together when explicitly blocked. */
  blockCleanup(note: string) {
    this.state.phase = "CLEANUP";
    for (const r of this.state.records)
      if (r.cleanup?.status === "PENDING")
        r.cleanup = {
          ...r.cleanup,
          status: "BLOCKED",
          note: note.slice(0, 1000),
        };
    const writeKeys = this.unreviewedWriteKeys();
    const refs = [
      ...new Set(this.unresolvedWrites().flatMap((w) => w.evidenceRefs)),
    ].slice(0, 20);
    if (writeKeys.length && refs.length)
      this.state.cleanupReview = {
        status: "BLOCKED",
        note: note.slice(0, 1000),
        writeKeys: [
          ...new Set([
            ...(this.state.cleanupReview?.writeKeys ?? []),
            ...writeKeys,
          ]),
        ].slice(0, 200),
        evidenceRefs: refs,
      };
  }
  private reconcileCleanup() {
    for (const record of this.state.records) {
      if (!record.recordRef || !record.cleanup) continue;
      const key = recordKey(record.id, record.type, record.resourceUrl);
      // Recompute from the latest mutation/read, so replaying an old empty
      // response cannot re-establish a proof invalidated by later activity.
      const mutation = this.state.writes
        .filter((w) => writeMatchesRecord(w, record) && !rejectedWrite(w))
        .sort((a, b) => (a.sequence ?? -1) - (b.sequence ?? -1))
        .at(-1);
      if (record.cleanup.status === "RETAINED") {
        const proof = this.retentionRead(record);
        if (
          !proof ||
          proof.mutation.key !== record.cleanup.retainedAtWriteKey
        ) {
          record.cleanup.status = "PENDING";
          delete record.cleanup.retainedAtWriteKey;
        }
      }
      let confirmation:
        ExecutionState["cleanupConfirmations"][number] | undefined;
      if (
        !this.state.requestOrderTruncated &&
        mutation?.sequence !== undefined &&
        mutation.confirmed &&
        successful(mutation.status, parse(mutation.response))
      ) {
        const laterReads = this.state.readReceipts
          .filter(
            (read) =>
              read.sequence > mutation.sequence! &&
              (!read.timestamp ||
                !mutation.timestamp ||
                Date.parse(read.timestamp) > Date.parse(mutation.timestamp)),
          )
          .sort((a, b) => b.sequence - a.sequence);
        let confirmedRead: ExecutionState["readReceipts"][number] | undefined;
        if (
          mutation.method === "DELETE" &&
          record.ownership === "CREATED_THIS_RUN"
        ) {
          const latestRead = laterReads.find(
            (read) =>
              read.recordKeys.includes(key) ||
              completeReadCoversRecord(read, record),
          );
          if (latestRead && !latestRead.recordKeys.includes(key))
            confirmedRead = latestRead;
        } else if (
          record.ownership === "EXISTING" &&
          ["PUT", "PATCH"].includes(mutation.method) &&
          record.initialState !== undefined
        ) {
          const expected = parse(record.initialState) ?? record.initialState;
          const request = object(parse(mutation.request));
          const config = parse(request.config) ?? request.config;
          const latestRead = laterReads.find((read) =>
            read.recordKeys.includes(key),
          );
          const actual = latestRead?.recordStates[key];
          if (
            (record.resourceName !== undefined ||
              isDeepStrictEqual(config, expected)) &&
            actual !== undefined &&
            isDeepStrictEqual(parse(actual) ?? actual, expected)
          )
            confirmedRead = latestRead;
        }
        if (confirmedRead)
          confirmation = {
            recordRef: record.recordRef,
            writeKey: mutation.key,
            readKey: confirmedRead.key,
            evidenceRefs: [
              ...new Set([
                ...mutation.evidenceRefs,
                ...confirmedRead.evidenceRefs,
              ]),
            ].slice(-20),
          };
      }
      this.state.cleanupConfirmations = this.state.cleanupConfirmations.filter(
        (proof) =>
          proof.recordRef !== record.recordRef ||
          (!confirmation && proof.source === "UI"),
      );
      if (confirmation) {
        this.state.cleanupConfirmations.push(confirmation);
        record.cleanup = {
          ...record.cleanup,
          status: "COMPLETED",
          resolution: mutation!.method === "DELETE" ? "DELETED" : "RESTORED",
          note:
            mutation!.method === "DELETE"
              ? "已核对删除回执及后续查询，记录已不存在。"
              : "已重新读取并确认恢复到修改前状态。",
        };
        delete record.cleanup.retainedAtWriteKey;
        record.evidenceRefs = [
          ...new Set([...record.evidenceRefs, ...confirmation.evidenceRefs]),
        ].slice(-20);
      } else if (
        mutation &&
        record.cleanup.status === "COMPLETED" &&
        !this.state.cleanupConfirmations.some(
          (p) => p.recordRef === record.recordRef,
        )
      ) {
        record.cleanup.status = "PENDING";
        delete record.cleanup.resolution;
        record.cleanup.note =
          "最新写入或查询与原收尾结果不一致，需要重新核对。";
      }
    }
  }
  private retentionRead(record: ExecutionState["records"][number]) {
    if (this.state.requestOrderTruncated) return;
    const mutation = this.state.writes
      .filter((w) => writeMatchesRecord(w, record) && !rejectedWrite(w))
      .sort((a, b) => (a.sequence ?? -1) - (b.sequence ?? -1))
      .at(-1);
    if (
      !mutation?.confirmed ||
      mutation.sequence === undefined ||
      mutation.method === "DELETE" ||
      !successful(mutation.status, parse(mutation.response))
    )
      return;
    const key = recordKey(record.id, record.type, record.resourceUrl);
    const read = this.state.readReceipts
      .filter((r) => resource(r.url) === resource(record.resourceUrl ?? ""))
      .sort((a, b) => b.sequence - a.sequence)
      .find(
        (r) =>
          r.recordKeys.includes(key) || completeReadCoversRecord(r, record),
      );
    if (
      !read ||
      read.sequence <= mutation.sequence ||
      !read.recordKeys.includes(key) ||
      (read.timestamp &&
        mutation.timestamp &&
        !(Date.parse(read.timestamp) > Date.parse(mutation.timestamp)))
    )
      return;
    return { mutation, read };
  }
  modelView() {
    return {
      ...this.state,
      requestOrder: undefined,
      readReceipts: undefined,
      unresolvedWrites: this.unresolvedWrites().map((w) => ({
        key: w.key,
        method: w.method,
        url: w.url,
        status: w.status,
        outcome:
          w.confirmed && successful(w.status, parse(w.response))
            ? "SUCCEEDED"
            : "UNCONFIRMED",
        ownership: "UNCONFIRMED",
        evidenceRefs: w.evidenceRefs,
      })),
      unreviewedWriteKeys: this.unreviewedWriteKeys(),
      cleanupNotice: this.cleanupNotice(),
      recordGuidance:
        "登记已有记录时优先只传 observedRecords 的 recordRef、cleanup 与观察引用；平台继承真实 ID、类型编码、资源地址和修改前 JSON。displayType 是页面名称，不要把自然语言说明写入 initialState。",
      prerequisiteFacts: {
        existingRecordKeys: this.state.existingRecordKeys.slice(-20),
        existingRecordCount: this.state.existingRecordKeys.length,
        confirmedAbsences: this.state.preflightAbsences.slice(-20),
        confirmedAbsenceCount: this.state.preflightAbsences.length,
        recordedWriteCount: this.state.writes.length,
        recordedCreateCount: this.state.writes.filter(
          (w) => w.method === "POST",
        ).length,
        createdRecordCount: this.state.records.filter(
          (r) => r.ownership === "CREATED_THIS_RUN",
        ).length,
        notice:
          "existingRecordKeys 是历史已观察记录，人工处置后以重新查询为准。已有记录不等于本次创建，没有回执不能宣称创建成功。",
      },
      existingRecordKeys: undefined,
      preflightAbsences: undefined,
      writes: this.state.writes.slice(-4).map((w) => ({
        ...w,
        request: w.request?.slice(0, 600),
        response: w.response?.slice(0, 600),
      })),
    };
  }
  /** Unidentified writes remain cleanup obligations, even when no record could be bound. */
  unresolvedWrites() {
    return this.state.writes.filter((w) => {
      if (rejectedWrite(w)) return false;
      const request = object(parse(w.request));
      return !this.state.records.some((r) => {
        if (
          !r.cleanup ||
          !r.resourceUrl ||
          resource(w.url) !== resource(r.resourceUrl)
        )
          return false;
        if (w.method === "POST" && r.ownership !== "CREATED_THIS_RUN")
          return false;
        return writeMatchesRecord(w, r);
      });
    });
  }
  unreviewedWrites() {
    return this.unresolvedWrites().filter(
      (w) => !this.state.cleanupReview?.writeKeys.includes(w.key),
    );
  }
  unreviewedWriteKeys() {
    return [
      ...this.unreviewedWrites().map((w) => w.key),
      ...(this.state.writeHistoryTruncated &&
      !this.state.cleanupReview?.writeKeys.includes("history:truncated")
        ? ["history:truncated"]
        : []),
    ];
  }
  cleanupReserveCalls() {
    const pending = this.pendingCleanup().filter(
      (r) => r.cleanup?.status === "PENDING",
    ).length;
    return pending || this.unreviewedWriteKeys().length
      ? Math.min(
          24,
          4 + pending * 7 + (this.unreviewedWriteKeys().length ? 5 : 0),
        )
      : 0;
  }
  cleanupNotice() {
    const pending = this.pendingCleanup();
    const unresolved = this.unresolvedWrites();
    if (
      !pending.length &&
      !unresolved.length &&
      !this.state.pendingRecords.length &&
      !this.state.writeHistoryTruncated
    )
      return undefined;
    return [
      this.state.writeHistoryTruncated
        ? "提交台账超过保留上限，历史写入需人工对照原始网络证据核对。"
        : "",
      pending.length
        ? `待核对清理或恢复：${pending.map((r) => `${r.type ?? "记录"} ${r.id}${r.cleanup?.note ? `（${r.cleanup.note}）` : ""}`).join("、")}`
        : "",
      unresolved.length
        ? `${unresolved.length} 笔提交尚未确认记录归属，${this.state.cleanupReview?.note ?? "需查询确认，不能直接删除或宣称已清理"}`
        : "",
      this.state.pendingRecords.length
        ? `${this.state.pendingRecords.length} 条记录的创建回执尚未确认，需后续核对归属。`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  pendingCleanup() {
    return this.state.records.filter(
      (r) => r.cleanup && !["COMPLETED", "RETAINED"].includes(r.cleanup.status),
    );
  }
  accountRequestError(context: Record<string, unknown>) {
    const existing = object(context.existingRecord);
    const own = this.state.records.find(
      (r) => r.id === String(existing.id) && r.ownership === "CREATED_THIS_RUN",
    );
    return own
      ? `记录 ${own.id} 是本次执行创建的，请继续核验和清理；不能把创建后的存在当成前置冲突再次索取账号。`
      : null;
  }
}
