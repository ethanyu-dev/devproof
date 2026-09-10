import { randomUUID } from "node:crypto";
import {
  visualObservationSchema,
  type VisualObservation,
  type runtimeActionCommandInputSchema,
} from "@devproof/runtime-protocol";
import { z } from "zod";
import { jsonBytes } from "./model-context.js";
import { compactValue } from "./operation-summary.js";
import { observationContentKey } from "./observation-content.js";

type Command = z.infer<typeof runtimeActionCommandInputSchema>;
interface Observation {
  id: string;
  order: number;
  commandType: string;
  capturedAt: string;
  url?: string;
  title?: string;
  metadataTruncated: boolean;
  format: "text" | "json";
  snapshot: boolean;
  content?: string;
  bytes: number;
  captureTruncated: boolean;
  sourceTruncated: boolean;
  cursors: Set<number>;
  readPages: Map<number, number | null>;
  lastReadCursor?: number;
  visualObservationId?: string;
  contentKey: string;
  readProgressInheritedFrom?: string;
}

export const READ_COMMANDS = new Set([
  "page.snapshot",
  "frame.snapshot",
  "page.get_text",
  "page.get_url",
  "page.get_title",
  "page.errors",
  "page.screenshot",
  "page.dom",
  "page.console",
  "page.network",
  "tab.list",
  "element.state",
  "locator.count",
  "network.status",
  "network.wait_for_hit",
]);
const FORM_INPUT_COMMANDS = new Set([
  "frame.fill",
  "page.fill",
  "page.type",
  "page.check",
  "page.uncheck",
  "page.select",
]);
const OUTPUT_BYTES = 16 * 1_024;
const PAGE_BYTES = 12 * 1_024;
const CAPTURE_BYTES = 256 * 1_024;

export const readObservationInputSchema = z
  .object({
    observationId: z.string().uuid(),
    cursor: z.number().int().nonnegative().default(0),
  })
  .strict();

/** Segment-local observations. Cached page reads never touch the browser. */
export class BrowserObservations {
  private readonly entries = new Map<string, Observation>();
  private readonly capturedResults = new WeakMap<object, Observation>();
  private currentSnapshot: string | null = null;
  private currentSnapshotUrl: string | undefined;
  private readonly exposedRefs = new Set<string>();
  private visual: VisualObservation | undefined;
  private readonly evidenceStages = new Map<
    string,
    "AFTER_ACTION" | "OBSERVATION"
  >();
  private readonly responseStages = new WeakMap<
    object,
    "AFTER_ACTION" | "OBSERVATION"
  >();
  private order = 0;
  private bytes = 0;
  private feedback: unknown;
  private pageDirty = true;
  private snapshotAttempted = false;
  private latestRead: Record<string, unknown> | undefined;

  latestActionFeedback() {
    return this.feedback;
  }

  constructor(
    private readonly cacheBytes = 4 * 1_024 * 1_024,
    private readonly deferRefDelivery = false,
  ) {}

  invalidate() {
    this.visual = undefined;
    this.currentSnapshot = null;
    this.currentSnapshotUrl = undefined;
    this.exposedRefs.clear();
    this.pageDirty = true;
    this.snapshotAttempted = false;
    this.latestRead = undefined;
  }

  staleRef(command: Command): boolean {
    const payload = command.payload as Record<string, unknown>;
    return [payload.target, payload.source, payload.frame].some((target) => {
      const ref = record(target).ref;
      return (
        typeof ref === "string" &&
        (!this.currentSnapshot || !this.exposedRefs.has(ref))
      );
    });
  }

  unreadRef(command: Command): boolean {
    const content = this.currentSnapshot
      ? this.entries.get(this.currentSnapshot)?.content
      : undefined;
    const payload = command.payload as Record<string, unknown>;
    return [payload.target, payload.source, payload.frame].some((target) => {
      const ref = record(target).ref;
      return (
        typeof ref === "string" &&
        !this.exposedRefs.has(ref) &&
        content?.includes(`[ref=${ref}]`)
      );
    });
  }

  unreadRefCorrection(command: Command) {
    if (!this.unreadRef(command) || !this.currentSnapshot) return;
    const entry = this.entries.get(this.currentSnapshot)!;
    const payload = command.payload as Record<string, unknown>;
    const refs = [payload.target, payload.source, payload.frame]
      .map((target) => record(target).ref)
      .filter(
        (ref): ref is string =>
          typeof ref === "string" && !this.exposedRefs.has(ref),
      );
    const previouslyReadCursor = [...entry.readPages.keys()].find((cursor) => {
      const page = this.page(entry, cursor, false);
      return (
        !page.omittedLine &&
        refs.some((ref) => String(page.content).includes(`[ref=${ref}]`))
      );
    });
    if (
      previouslyReadCursor === undefined &&
      this.nextUnreadCursor(entry) === null
    )
      return {
        accepted: false,
        code: "OBSERVATION_CONTENT_OMITTED",
        retryable: true,
        error:
          "该 ref 所在行未完整交付；缓存分页已读完，重复读取不能恢复被跳过的超长行。",
        nextAction:
          "根据当前页面选择可见区域的 selector，用 page.snapshot 的 target 缩小范围后重新定位。",
      };
    return {
      accepted: false,
      code: "OBSERVATION_NOT_READ",
      error:
        "该 ref 尚未交付；请读取当前快照的后续页，不要重新 snapshot 或猜测 cursor。",
      nextAction: this.readAction(
        entry,
        previouslyReadCursor ?? this.nextUnreadCursor(entry) ?? 0,
      ),
      retryable: true,
    };
  }

  needsSnapshot() {
    const entry = this.currentSnapshot
      ? this.entries.get(this.currentSnapshot)
      : undefined;
    if (!entry) return !this.snapshotAttempted;
    return (
      this.pageDirty ||
      Date.now() - Date.parse(entry.capturedAt) > 120_000 ||
      (entry.visualObservationId !== undefined &&
        this.currentVisual()?.observationId !== entry.visualObservationId)
    );
  }

  markSnapshotAttempted() {
    this.snapshotAttempted = true;
  }

  /** The most recently read DOM page is pinned independently of operation summaries. */
  currentPage(): {
    visualStatus: "AVAILABLE" | "UNAVAILABLE";
    snapshot: Record<string, unknown> | null;
    latestObservation: Record<string, unknown> | undefined;
    nextAction?: {
      tool: string;
      arguments: { commandType: string; payload: Record<string, unknown> };
    };
  } {
    const entry = this.currentSnapshot
      ? this.entries.get(this.currentSnapshot)
      : undefined;
    return {
      visualStatus: this.currentVisual() ? "AVAILABLE" : "UNAVAILABLE",
      snapshot:
        entry && !this.pageDirty
          ? {
              ...this.page(entry, entry.lastReadCursor ?? 0, false),
              visualObservationId: entry.visualObservationId,
            }
          : null,
      latestObservation:
        this.latestRead?.observationId !== this.currentSnapshot
          ? this.requestedPage()
          : undefined,
      ...(!entry || this.pageDirty
        ? {
            nextAction: {
              tool: "browser_command",
              arguments: { commandType: "page.snapshot", payload: {} },
            },
          }
        : {}),
    };
  }

  /** Commit only after the final request fits its budget, never a discarded preview. */
  deliverCurrentPage(view: ReturnType<BrowserObservations["currentPage"]>) {
    this.exposedRefs.clear();
    if (view.snapshot) this.deliverPage(view.snapshot, true);
  }

  /** An automatic page refresh must not erase the data the agent just requested. */
  retainLatestObservation(page: Record<string, unknown> | undefined) {
    if (
      page &&
      this.entries.get(String(page.observationId))?.content !== undefined
    )
      this.latestRead = page;
  }

  requestedPage(): Record<string, unknown> | undefined {
    const entry = this.entries.get(String(this.latestRead?.observationId));
    const cursor = this.latestRead?.cursor;
    return entry?.content !== undefined && typeof cursor === "number"
      ? this.page(entry, cursor, false)
      : undefined;
  }

  capture(command: Command, raw: unknown) {
    const previous = this.entries.get(this.currentSnapshot ?? "");
    this.latestRead = undefined;
    const response = record(raw);
    const stage = READ_COMMANDS.has(command.commandType)
      ? "OBSERVATION"
      : "AFTER_ACTION";
    this.responseStages.set(response, stage);
    for (const artifact of Array.isArray(response.artifacts)
      ? response.artifacts
      : []) {
      const item = record(artifact);
      if (item.kind === "SCREENSHOT" && typeof item.id === "string")
        this.evidenceStages.set(`artifact://${item.id}`, stage);
    }
    // Form input need not replace the observed DOM nodes. Keep refs
    // already shown to the model; live element resolution remains authoritative.
    const successfulFormInput =
      FORM_INPUT_COMMANDS.has(command.commandType) &&
      (response.status === "SUCCEEDED" || response.ok === true);
    if (!READ_COMMANDS.has(command.commandType)) {
      this.pageDirty = true;
      if (!successfulFormInput) this.invalidate();
    }
    const result = record(response.result);
    if (result.actionFeedback)
      this.feedback = this.diagnostic(
        result.actionFeedback,
        "browser.action_feedback",
        2_048,
      );
    const snapshot = ["page.snapshot", "frame.snapshot"].includes(
      command.commandType,
    );
    if (
      typeof result.url === "string" &&
      this.currentSnapshot &&
      this.currentSnapshotUrl !== result.url
    )
      this.invalidate();
    if (snapshot) {
      this.invalidate();
      this.snapshotAttempted = true;
    }
    // Images are kept outside text pagination/history and replaced after every
    // state-changing action, including inputs that preserve DOM references.
    if (
      !READ_COMMANDS.has(command.commandType) ||
      snapshot ||
      command.commandType === "page.screenshot"
    )
      this.visual = undefined;
    const visual = visualObservationSchema.safeParse(
      response.visualObservation,
    );
    if (
      visual.success &&
      (response.status === "SUCCEEDED" || response.ok === true)
    )
      this.visual = visual.data;
    if (!response.result || typeof response.result !== "object") return;
    const entry = this.save(
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result),
      command.commandType,
      typeof result.content === "string" ? "text" : "json",
      snapshot && typeof result.content === "string",
      result,
    );
    this.capturedResults.set(response.result, entry);
    if (snapshot && typeof result.content === "string") {
      if (response.status === "SUCCEEDED" || response.ok === true) {
        this.currentSnapshot = entry.id;
        this.currentSnapshotUrl =
          typeof result.url === "string" ? result.url : undefined;
        this.pageDirty = false;
        if (this.visual) entry.visualObservationId = this.visual.observationId;
        if (previous?.contentKey === entry.contentKey)
          this.inheritReadProgress(previous, entry);
      }
    }
  }

  currentVisual() {
    if (
      this.visual &&
      Date.now() - Date.parse(this.visual.capturedAt) > 120_000
    )
      this.visual = undefined;
    return this.visual;
  }

  evidenceStage(reference: string) {
    return this.evidenceStages.get(reference);
  }

  verdictEvidenceError(references: string[]) {
    if (
      !references.some(
        (reference) => this.evidenceStage(reference) === "AFTER_ACTION",
      )
    )
      return;
    return "引用了操作后自动采集的过程截图，页面可能仍在加载并显示旧结果，不能据此提交 PASSED/FAILED。先确认加载遮罩/转圈消失、查询或保存结果更新，再用 page.snapshot 或 page.screenshot 重新观察，替换为新证据；无法确认则记录 INCONCLUSIVE。";
  }

  index() {
    return [...this.entries.values()].map((entry) => this.descriptor(entry));
  }

  read(id: string, cursor: number = 0): Record<string, unknown> {
    const entry = this.entries.get(id);
    if (!entry || entry.content === undefined)
      return {
        accepted: false,
        error: "观察内容已过期或不属于当前执行段；请重新采集所需页面范围。",
      };
    if (!entry.cursors.has(cursor))
      return {
        accepted: false,
        error: "请使用该观察返回的 nextCursor，或从 cursor=0 开始读取。",
      };
    const page = this.page(entry, cursor);
    this.latestRead = page;
    return page;
  }

  /** Checkpoints may quote delivered observations, never invented page facts. */
  hasDeliveredQuote(id: string, cursor: number, quote: string) {
    const entry = this.entries.get(id);
    return Boolean(
      quote.trim() &&
      entry?.content !== undefined &&
      entry.readPages.has(cursor) &&
      String(this.page(entry, cursor, false).content).includes(quote),
    );
  }

  project(raw: unknown, bounded = true): unknown {
    const observationStage = this.responseStages.get(record(raw));
    const observationNotice =
      observationStage === "AFTER_ACTION"
        ? "过程截图：操作完成不等于异步业务结果完成。检查加载状态，等待结果更新后重新观察；此截图不能用于通过/失败验收。"
        : observationStage === "OBSERVATION"
          ? "主动观察仍可能捕获加载中或局部内容。确认图片中无加载遮罩，并核对观察范围；未看见不等于不存在。"
          : undefined;
    if (!bounded) {
      const source = record(raw);
      const entry =
        source.result && typeof source.result === "object"
          ? this.capturedResults.get(source.result)
          : undefined;
      if (
        entry?.id === this.currentSnapshot &&
        typeof record(source.result).content === "string"
      ) {
        for (const match of String(record(source.result).content).matchAll(
          /\[ref=((?:f\d+)?e\d+)\]/gu,
        ))
          this.exposedRefs.add(match[1]!);
      }
      const { dataBase64: _bytes, ...metadata } = record(
        source.visualObservation,
      );
      const recovery = record(source.locatorRecovery);
      return {
        ...source,
        ...(observationNotice ? { observationStage, observationNotice } : {}),
        ...(source.visualObservation ? { visualObservation: metadata } : {}),
        ...(source.locatorRecovery
          ? {
              locatorRecovery: {
                ...recovery,
                snapshot: this.project(recovery.snapshot, false),
              },
            }
          : {}),
      };
    }
    const previouslyExposedRefs = new Set(this.exposedRefs);
    const source = record(raw);
    const projected: Record<string, unknown> = {};
    if (observationNotice)
      Object.assign(projected, { observationStage, observationNotice });
    for (const key of [
      "accepted",
      "status",
      "ok",
      "error",
      "code",
      "requiredGroup",
      "issues",
      "suggestions",
      "nextAction",
      "retryable",
      "visualObservationError",
    ]) {
      if (key in source) projected[key] = source[key];
    }
    const visual = visualObservationSchema.safeParse(source.visualObservation);
    if (visual.success) {
      const { dataBase64: _bytes, ...metadata } = visual.data;
      projected.visualObservation = metadata;
    }
    const result = source.result;
    if (result && typeof result === "object") {
      const entry = this.capturedResults.get(result);
      projected.result = entry
        ? {
            ...this.page(
              entry,
              entry.id === this.currentSnapshot
                ? (entry.lastReadCursor ?? 0)
                : 0,
              false,
            ),
            ...(record(result).actionFeedback
              ? { actionFeedback: this.feedback }
              : {}),
            ...(record(result).interaction
              ? { interaction: record(result).interaction }
              : {}),
          }
        : result;
    }
    if (Array.isArray(source.artifacts))
      projected.artifacts = source.artifacts.map((artifact) => {
        const item = record(artifact);
        return { id: item.id, kind: item.kind };
      });
    if (Array.isArray(source.evidenceRefs))
      projected.evidenceRefs = source.evidenceRefs;
    if (source.locatorRecovery) {
      const { snapshot, ...recovery } = record(source.locatorRecovery);
      projected.locatorRecovery = {
        ...recovery,
        snapshot: snapshot ? this.project(snapshot) : null,
      };
    }
    // Diagnostics cannot move a snapshot's real ID and DOM behind a JSON envelope.
    for (const key of [
      "error",
      "issues",
      "suggestions",
      "artifacts",
      "evidenceRefs",
      "nextAction",
    ]) {
      if (key in projected && jsonBytes(projected[key]) > 1_024)
        projected[key] = this.diagnostic(
          projected[key],
          `browser.${key}`,
          1_024,
        );
    }
    const projectedResult = record(projected.result);
    if (
      projectedResult.interaction &&
      jsonBytes(projectedResult.interaction) > 1_024
    )
      projectedResult.interaction = this.diagnostic(
        projectedResult.interaction,
        "browser.interaction",
        1_024,
      );
    if (jsonBytes(projected) <= OUTPUT_BYTES) {
      this.deliverPage(projectedResult);
      const entry = this.entries.get(String(projectedResult.observationId));
      if (entry && entry.id !== this.currentSnapshot)
        this.latestRead = projectedResult;
      return projected;
    }

    // Preserve a direct, paginated snapshot even when several diagnostics add up.
    if (this.entries.get(String(projectedResult.observationId))?.snapshot) {
      const { result: _result, status, accepted, ...diagnostics } = projected;
      const { actionFeedback, interaction, ...page } = projectedResult;
      const minimal = {
        status,
        accepted,
        result: page,
        diagnostics: this.cacheDetail(
          { ...diagnostics, resultDetails: { actionFeedback, interaction } },
          "browser.diagnostics",
        ),
      };
      this.deliverPage(page);
      return minimal;
    }

    // The preview (including nested recovery snapshots) will not be delivered.
    // Only a later read of the snapshot itself may expose its refs.
    this.exposedRefs.clear();
    if (this.currentSnapshot) {
      for (const ref of previouslyExposedRefs) this.exposedRefs.add(ref);
    }
    // Oversized envelopes use the same capture budget and truncation flags.
    // Do not present a broken JSON prefix as a complete tool response.
    const entry = this.save(
      JSON.stringify(projected),
      "browser.result",
      "json",
      false,
      {},
    );
    const recovery = record(source.locatorRecovery);
    return {
      status: source.status,
      accepted: source.accepted,
      result: {
        ...this.descriptor(entry),
        nextCursor: 0,
        nextAction: {
          tool: "read_observation",
          arguments: { observationId: entry.id, cursor: 0 },
        },
        contentOmitted: true,
      },
      error: source.error
        ? "浏览器操作返回了诊断信息，请读取 result.observationId。"
        : undefined,
      ...(source.locatorRecovery
        ? {
            locatorRecovery: {
              action: "RESNAPSHOT_AND_RETARGET",
              recoveryToken: recovery.recoveryToken,
              exhausted: recovery.exhausted,
              retargetAttempts: recovery.retargetAttempts,
              maxRetargetAttempts: recovery.maxRetargetAttempts,
              guidance:
                "请读取观察中的恢复 snapshot，保留完整 ref 和恢复 token。定位问题不能判定为产品 FAILED。",
            },
          }
        : {}),
    };
  }

  private cacheDetail(value: unknown, commandType: string) {
    const entry = this.save(
      JSON.stringify(value),
      commandType,
      "json",
      false,
      {},
    );
    return {
      ...this.descriptor(entry),
      nextCursor: 0,
      nextAction: this.readAction(entry, 0),
      contentOmitted: true,
    };
  }

  private diagnostic(
    value: unknown,
    commandType: string,
    limit: number,
  ): unknown {
    if (jsonBytes(value) <= limit) return structuredClone(value);
    return {
      summary: compactValue(value, Math.floor(limit / 2)),
      details: this.cacheDetail(value, commandType),
    };
  }

  private save(
    content: string,
    commandType: string,
    format: Observation["format"],
    snapshot: boolean,
    source: Record<string, unknown>,
  ): Observation {
    const cap = Math.min(CAPTURE_BYTES, this.cacheBytes);
    let prefix = utf8Prefix(content, cap);
    if (snapshot && prefix.length < content.length) {
      const newline = prefix.lastIndexOf("\n");
      prefix = newline < 0 ? "" : prefix.slice(0, newline + 1);
    }
    const entry: Observation = {
      id: randomUUID(),
      order: ++this.order,
      commandType,
      capturedAt: new Date().toISOString(),
      ...(typeof source.url === "string"
        ? { url: source.url.slice(0, 240) }
        : {}),
      ...(typeof source.title === "string"
        ? { title: source.title.slice(0, 160) }
        : {}),
      metadataTruncated:
        (typeof source.url === "string" && source.url.length > 240) ||
        (typeof source.title === "string" && source.title.length > 160),
      format,
      snapshot,
      content: prefix,
      bytes: Buffer.byteLength(prefix),
      captureTruncated:
        prefix.length < content.length || source.captureTruncated === true,
      sourceTruncated: source.truncated === true,
      contentKey: observationContentKey(
        prefix,
        typeof source.url === "string" ? source.url : undefined,
      ),
      cursors: new Set([0]),
      readPages: new Map(),
    };
    this.entries.set(entry.id, entry);
    this.bytes += entry.bytes;
    for (const candidate of this.entries.values()) {
      if (this.bytes <= this.cacheBytes) break;
      this.evict(candidate);
    }
    while (this.entries.size > 256) {
      const oldest = this.entries.values().next().value!;
      this.evict(oldest);
      this.entries.delete(oldest.id);
    }
    return entry;
  }

  private evict(entry: Observation) {
    this.bytes -= entry.bytes;
    entry.bytes = 0;
    delete entry.content;
    entry.cursors.clear();
    entry.readPages.clear();
    if (entry.id === this.currentSnapshot) this.invalidate();
  }

  private descriptor(entry: Observation) {
    return {
      observationId: entry.id,
      order: entry.order,
      commandType: entry.commandType,
      contentKey: entry.contentKey,
      readProgressInheritedFrom: entry.readProgressInheritedFrom,
      capturedAt: entry.capturedAt,
      url: entry.url,
      title: entry.title,
      format: entry.format,
      metadataTruncated: entry.metadataTruncated,
      availability: entry.content === undefined ? "EVICTED" : "AVAILABLE",
      ...(entry.snapshot
        ? {
            refState:
              entry.id === this.currentSnapshot ? "CURRENT" : "HISTORICAL",
          }
        : {}),
      ...(entry.lastReadCursor === undefined
        ? {}
        : {
            lastReadCursor: entry.lastReadCursor,
            readCursors: [...entry.readPages.keys()],
            nextUnreadCursor: this.nextUnreadCursor(entry),
          }),
      captureTruncated: entry.captureTruncated,
      sourceTruncated: entry.sourceTruncated,
    };
  }

  private page(
    entry: Observation,
    cursor: number,
    deliver = true,
  ): Record<string, unknown> {
    if (entry.content === undefined)
      return {
        ...this.descriptor(entry),
        error: "观察内容已过期，请重新采集。",
      };
    const rest = entry.content.slice(cursor);
    // JSON escaping counts against the page budget, not just raw text bytes.
    let low = 0;
    let high = rest.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (jsonBytes(rest.slice(0, middle)) <= PAGE_BYTES) low = middle;
      else high = middle - 1;
    }
    if (low && /[\uD800-\uDBFF]/u.test(rest[low - 1]!)) low -= 1;
    let omittedLine = false;
    let content = rest.slice(0, low);
    let consumed = low;
    if (entry.snapshot && low < rest.length) {
      const newline = content.lastIndexOf("\n");
      if (newline >= 0) {
        content = content.slice(0, newline + 1);
        consumed = content.length;
      } else {
        const end = rest.indexOf("\n");
        consumed = end < 0 ? rest.length : end + 1;
        content = "[一行过长，已跳过；请缩小 snapshot 的 target 或 depth。]";
        omittedLine = true;
      }
    }
    const next = cursor + consumed;
    if (next < entry.content.length) entry.cursors.add(next);
    const page = {
      ...this.descriptor(entry),
      content,
      cursor,
      nextCursor: next < entry.content.length ? next : null,
      totalCapturedChars: entry.content.length,
      ...(omittedLine ? { omittedLine: true } : {}),
    };
    if (deliver) this.deliverPage(page);
    const nextUnread = this.nextUnreadCursor(entry);
    return {
      ...page,
      ...this.descriptor(entry),
      ...(nextUnread !== null
        ? { nextAction: this.readAction(entry, nextUnread) }
        : {}),
    };
  }

  private inheritReadProgress(previous: Observation, entry: Observation) {
    if (previous.content === undefined || entry.content === undefined) return;
    // Ref width may change (f9 -> f10), so offsets cannot be copied verbatim.
    const lineAt = (text: string, offset: number) =>
      text.slice(0, offset).split("\n").length - 1;
    const lineEnd = (text: string, offset: number) =>
      lineAt(text, offset) + (offset > 0 && text[offset - 1] !== "\n" ? 1 : 0);
    const readLines = new Set<number>();
    for (const [start, end] of previous.readPages) {
      if (this.page(previous, start, false).omittedLine) continue;
      const first = lineAt(previous.content, start);
      const last = lineEnd(previous.content, end ?? previous.content.length);
      for (let line = first; line < last; line++) readLines.add(line);
    }
    const focusLine = lineAt(previous.content, previous.lastReadCursor ?? 0);
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = this.page(entry, cursor, false);
      const next = page.nextCursor as number | null;
      const first = lineAt(entry.content, cursor);
      const last = lineEnd(entry.content, next ?? entry.content.length);
      if (
        Array.from({ length: last - first }, (_, i) => first + i).every(
          (line) => readLines.has(line),
        )
      )
        entry.readPages.set(cursor, next);
      if (first <= focusLine && (next === null || focusLine < last))
        entry.lastReadCursor = cursor;
      cursor = next;
    }
    entry.readProgressInheritedFrom = previous.id;
  }

  private deliverPage(
    page: Record<string, unknown>,
    exposeRefs = !this.deferRefDelivery,
  ) {
    const entry = this.entries.get(String(page.observationId));
    if (
      !entry ||
      entry.content === undefined ||
      typeof page.cursor !== "number" ||
      typeof page.content !== "string" ||
      !entry.cursors.has(page.cursor)
    )
      return;
    // Only an exact page from our captured observation can expose refs.
    const expected = this.page(entry, page.cursor, false);
    if (
      expected.content !== page.content ||
      expected.nextCursor !== page.nextCursor
    )
      return;
    entry.lastReadCursor = page.cursor;
    entry.readPages.set(page.cursor, page.nextCursor as number | null);
    Object.assign(page, this.descriptor(entry));
    delete page.nextAction;
    const unread = this.nextUnreadCursor(entry);
    if (unread !== null) page.nextAction = this.readAction(entry, unread);
    if (exposeRefs && entry.id === this.currentSnapshot && !page.omittedLine)
      for (const match of page.content.matchAll(/\[ref=((?:f\d+)?e\d+)\]/gu))
        this.exposedRefs.add(match[1]!);
  }

  private nextUnreadCursor(entry: Observation): number | null {
    let cursor: number | null = 0;
    while (cursor !== null && entry.readPages.has(cursor))
      cursor = entry.readPages.get(cursor)!;
    return cursor;
  }

  private readAction(entry: Observation, cursor: number) {
    return {
      tool: "read_observation",
      arguments: { observationId: entry.id, cursor },
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
