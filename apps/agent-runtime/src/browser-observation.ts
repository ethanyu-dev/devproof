import { randomUUID } from "node:crypto";
import {
  visualObservationSchema,
  type VisualObservation,
  type runtimeActionCommandInputSchema,
} from "@devproof/runtime-protocol";
import { z } from "zod";
import { jsonBytes } from "./model-context.js";

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
}

const READ_COMMANDS = new Set([
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
  private order = 0;
  private bytes = 0;

  constructor(private readonly cacheBytes = 4 * 1_024 * 1_024) {}

  invalidate() {
    this.visual = undefined;
    this.currentSnapshot = null;
    this.currentSnapshotUrl = undefined;
    this.exposedRefs.clear();
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

  capture(command: Command, raw: unknown) {
    const response = record(raw);
    // Form input need not replace the observed DOM nodes. Keep refs
    // already shown to the model; live element resolution remains authoritative.
    const successfulFormInput =
      FORM_INPUT_COMMANDS.has(command.commandType) &&
      (response.status === "SUCCEEDED" || response.ok === true);
    if (!READ_COMMANDS.has(command.commandType) && !successfulFormInput)
      this.invalidate();
    const result = record(response.result);
    const snapshot = ["page.snapshot", "frame.snapshot"].includes(
      command.commandType,
    );
    if (
      typeof result.url === "string" &&
      this.currentSnapshot &&
      this.currentSnapshotUrl !== result.url
    )
      this.invalidate();
    if (snapshot) this.invalidate();
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
      snapshot,
      result,
    );
    this.capturedResults.set(response.result, entry);
    if (snapshot) {
      if (response.status === "SUCCEEDED" || response.ok === true) {
        this.currentSnapshot = entry.id;
        this.currentSnapshotUrl =
          typeof result.url === "string" ? result.url : undefined;
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
    return this.page(entry, cursor);
  }

  project(raw: unknown, bounded = true): unknown {
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
      projected.result = entry ? this.page(entry, 0) : result;
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
    if (jsonBytes(projected) <= OUTPUT_BYTES) return projected;

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
      cursors: new Set([0]),
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
    if (entry.id === this.currentSnapshot) this.invalidate();
  }

  private descriptor(entry: Observation) {
    return {
      observationId: entry.id,
      order: entry.order,
      commandType: entry.commandType,
      capturedAt: entry.capturedAt,
      url: entry.url,
      title: entry.title,
      format: entry.format,
      metadataTruncated: entry.metadataTruncated,
      availability: entry.content === undefined ? "EVICTED" : "AVAILABLE",
      refState:
        entry.snapshot && entry.id === this.currentSnapshot
          ? "CURRENT"
          : "HISTORICAL",
      captureTruncated: entry.captureTruncated,
      sourceTruncated: entry.sourceTruncated,
    };
  }

  private page(entry: Observation, cursor: number): Record<string, unknown> {
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
    if (entry.id === this.currentSnapshot && !omittedLine) {
      for (const match of content.matchAll(/\[ref=((?:f\d+)?e\d+)\]/gu))
        this.exposedRefs.add(match[1]!);
    }
    return {
      ...this.descriptor(entry),
      content,
      cursor,
      nextCursor: next < entry.content.length ? next : null,
      ...(next < entry.content.length
        ? {
            nextAction: {
              tool: "read_observation",
              arguments: { observationId: entry.id, cursor: next },
            },
          }
        : {}),
      totalCapturedChars: entry.content.length,
      ...(omittedLine ? { omittedLine: true } : {}),
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
