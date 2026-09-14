import {
  executionStateSchema,
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
        .replace(/\/[^/]+$/, (match) => (/^\/\d+$/.test(match) ? "" : match))
        .replace(/\/$/, "")
    );
  } catch {
    return url;
  }
};
const recordKey = (id: unknown, type: unknown, url?: string) =>
  `${url ? resource(url) : ""}:${String(type ?? "")}:${String(id)}`;
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
  return [v.data, v.list, v.items, v.records].some((child) =>
    Array.isArray(child)
      ? child.length === 0
      : child && typeof child === "object" && emptyList(child),
  );
}

/** Durable facts are distinct from product verdicts and permission to delete.
 * Ownership requires a filtered empty preflight, a successful matching creation,
 * and a subsequent record on the same API resource. HTTP 200 alone is insufficient.
 */
export class ExecutionJournal {
  state: ExecutionState;
  constructor(policy: Record<string, unknown>) {
    this.state = readExecutionState(policy);
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
            requestId: r.timestamp,
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
      const found = records(body);
      if (method === "GET" && successful(q.status, body) && emptyList(body)) {
        try {
          const params = new URL(url).searchParams,
            account = params.get("account"),
            type = params.get("type");
          if (account && type && evidenceRefs.length) {
            const key = `${resource(url)}:${type}:${account}`;
            // A later empty read cannot retroactively authorize an earlier POST.
            if (
              !this.state.writes.some(
                (w) =>
                  resource(w.url) === resource(url) &&
                  object(parse(w.request)).account === account,
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
        typeof q.requestSummary === "string" &&
        evidenceRefs.length
      ) {
        const key = `${String(feedback.commandId ?? "network")}:${String(q.requestId)}`;
        const receipt = {
          key,
          method: method as "POST" | "PUT" | "PATCH" | "DELETE",
          url,
          status: typeof q.status === "number" ? q.status : null,
          confirmed:
            q.bodyPending !== true &&
            q.pending !== true &&
            q.responseBodyOmitted === undefined &&
            typeof q.responseSummary === "string",
          request: q.requestSummary.slice(0, 4000),
          ...(typeof q.responseSummary === "string"
            ? { response: q.responseSummary.slice(0, 4000) }
            : {}),
          evidenceRefs,
        };
        const index = this.state.writes.findIndex((w) => w.key === key);
        if (index >= 0) this.state.writes[index] = receipt;
        else this.state.writes.push(receipt);
        this.state.writes = this.state.writes.slice(-32);
        if (
          receipt.confirmed &&
          successful(receipt.status, body) &&
          this.state.phase !== "CLEANUP"
        ) {
          this.state.phase = "VERIFYING";
          this.state.step =
            "核对已提交的业务结果并记录验收，不重新进行创建前的冲突检查。";
        }
      }
      if (!successful(q.status, body)) continue;
      for (const candidate of found) {
        const id = String(candidate.id),
          type = String(candidate.type),
          key = recordKey(id, type, url);
        const aliases = [
          candidate.account,
          object(candidate.user).uuid,
          object(candidate.user).phone,
          object(candidate.user).email,
        ].filter((v): v is string => typeof v === "string");
        if (this.state.account && aliases.includes(this.state.account))
          this.state.accountAliases = [
            ...new Set([...this.state.accountAliases, ...aliases]),
          ].slice(0, 20);
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
      const creation = this.matchingCreation(record);
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
    return before !== JSON.stringify(this.state);
  }
  private matchingCreation(record: ExecutionState["pendingRecords"][number]) {
    return [...this.state.writes].reverse().find((w) => {
      const request = object(parse(w.request));
      return (
        w.method === "POST" &&
        resource(w.url) === record.resourceUrl &&
        request.type === record.type &&
        record.accountAliases.includes(request.account as string) &&
        this.state.preflightAbsences.includes(
          `${record.resourceUrl}:${record.type}:${String(request.account)}`,
        )
      );
    });
  }
  update(next: ExecutionState) {
    const parsed = executionStateSchema.parse(next);
    if (parsed.account !== undefined && parsed.account !== this.state.account)
      throw new Error(
        "record_progress 不能分配或更换测试账号；请通过 TEST_ACCOUNT 人工输入获取账号。",
      );
    for (const existing of this.state.records)
      if (
        !parsed.records.some(
          (r) =>
            recordKey(r.id, r.type, r.resourceUrl) ===
            recordKey(existing.id, existing.type, existing.resourceUrl),
        )
      )
        throw new Error("不能遗失已有业务对象与清理记录。");
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
          "本次创建归属必须来自已观察的前置查询、提交与结果；不能凭计划声明创建成功。",
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
        !record.evidenceRefs.some((id) => !prior?.evidenceRefs.includes(id))
      )
        throw new Error(
          "清理完成必须引用重新核对结果的证据，不能沿用创建时的证据。",
        );
    }
    this.state = {
      ...parsed,
      ...(this.state.account ? { account: this.state.account } : {}),
      accountAliases: this.state.accountAliases,
      ...(this.state.accountConflict
        ? { accountConflict: this.state.accountConflict }
        : {}),
      pendingRecords: this.state.pendingRecords,
      writes: this.state.writes,
      preflightAbsences: this.state.preflightAbsences,
      existingRecordKeys: this.state.existingRecordKeys,
    };
  }
  modelView() {
    return {
      ...this.state,
      existingRecordKeys: undefined,
      preflightAbsences: undefined,
      writes: this.state.writes.slice(-4).map((w) => ({
        ...w,
        request: w.request?.slice(0, 600),
        response: w.response?.slice(0, 600),
      })),
    };
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
