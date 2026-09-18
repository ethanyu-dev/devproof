import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
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
function writeMatchesRecord(
  w: ExecutionState["writes"][number],
  r: ExecutionState["records"][number],
) {
  if (!r.resourceUrl || resource(w.url) !== resource(r.resourceUrl))
    return false;
  const request = object(parse(w.request));
  const identity = requestedRecordId(w.url, request);
  if (identity.conflict) return false;
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
 * Ownership requires a filtered empty preflight, a successful matching creation,
 * and a subsequent record on the same API resource. HTTP 200 alone is insufficient.
 */
export class ExecutionJournal {
  state: ExecutionState;
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
  observe(output: unknown, evidence: Map<string, RuntimeEvidenceRef>) {
    const before = JSON.stringify(this.state),
      root = object(output),
      result = object(root.result);
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
                "page_size",
                "page_num",
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
        } else this.state.writes.push(receipt);
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
        const read = {
          key: requestKey,
          url,
          sequence,
          ...(typeof q.timestamp === "string"
            ? { timestamp: q.timestamp }
            : {}),
          empty: emptyList(body),
          complete: completeList(body, url),
          recordKeys: found.map((r) => recordKey(r.id, r.type, url)),
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
        this.state.readReceipts = [
          ...this.state.readReceipts.filter((r) => r.key !== requestKey),
          read,
        ].slice(-200);
      }
      for (const candidate of found) {
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
        if (this.matchingCreation(observed) && evidenceRefs.length) {
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
    this.reconcileCleanup();
    return before !== JSON.stringify(this.state);
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
      const record = executionRecordSchema.parse({ ...locked, ...change });
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
  private reconcileCleanup() {
    for (const record of this.state.records) {
      if (!record.recordRef || !record.cleanup) continue;
      const key = recordKey(record.id, record.type, record.resourceUrl);
      // Recompute from the latest mutation/read, so replaying an old empty
      // response cannot re-establish a proof invalidated by later activity.
      const mutation = this.state.writes
        .filter((w) => writeMatchesRecord(w, record))
        .sort((a, b) => (a.sequence ?? -1) - (b.sequence ?? -1))
        .at(-1);
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
        if (mutation.method === "DELETE") {
          const latestRead = laterReads.find((read) => {
            if (read.recordKeys.includes(key)) return true;
            if (
              !read.complete ||
              resource(read.url) !== resource(record.resourceUrl!)
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
              ["id", "type", "account"].some(
                (field) => params.getAll(field).length > 1,
              )
            )
              return false;
            if (params.has("id") && params.get("id") !== record.id)
              return false;
            if (params.has("type") && params.get("type") !== record.type)
              return false;
            if (
              params.has("account") &&
              ![record.account, ...record.accountAliases].includes(
                params.get("account")!,
              )
            )
              return false;
            return [...params.keys()].every((field) =>
              [
                "id",
                "account",
                "type",
                "page",
                "pageSize",
                "pageNum",
                "page_size",
                "page_num",
                "limit",
                "offset",
              ].includes(field),
            );
          });
          if (latestRead && !latestRead.recordKeys.includes(key))
            confirmedRead = latestRead;
        } else if (
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
            isDeepStrictEqual(config, expected) &&
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
        (proof) => proof.recordRef !== record.recordRef,
      );
      if (confirmation) this.state.cleanupConfirmations.push(confirmation);
      else if (mutation && record.cleanup.status === "COMPLETED")
        record.cleanup.status = "PENDING";
    }
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
      if ([400, 401, 403, 404, 405, 409, 415, 422].includes(w.status ?? 0))
        return false;
      if (
        w.confirmed &&
        w.status !== null &&
        w.status >= 200 &&
        w.status < 300 &&
        !successful(w.status, parse(w.response))
      )
        return false;
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
      !this.state.writeHistoryTruncated
    )
      return undefined;
    return `${this.state.writeHistoryTruncated ? "提交台账超过保留上限，历史写入需人工对照原始网络证据核对。" : ""}清理未完成：${pending.map((r) => `${r.type ?? "记录"} ${r.id}（${r.cleanup?.status}${r.cleanup?.note ? `：${r.cleanup.note}` : ""}）`).join("、")}${unresolved.length ? `；${unresolved.length} 笔提交尚未确认记录归属，${this.state.cleanupReview?.note ?? "需查询确认，不能直接删除或宣称已清理"}` : ""}`;
  }
  pendingCleanup() {
    return this.state.records.filter(
      (r) => r.cleanup && r.cleanup.status !== "COMPLETED",
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
