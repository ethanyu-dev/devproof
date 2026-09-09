import { createHash } from "node:crypto";
import type { ElementHandle, Locator } from "playwright";

export const FEEDBACK_ACTIONS = new Set([
  "page.navigate",
  "page.click",
  "frame.click",
  "page.press",
  "page.fill",
  "frame.fill",
  "page.type",
  "page.select",
  "page.check",
  "page.uncheck",
]);

interface RequestEntry {
  sequence: number;
  pageId: string;
  details: Record<string, unknown>;
  response?: Record<string, unknown>;
}

/** Session-local, bounded request windows. Temporal proximity is not causality. */
export class ActionFeedbackTracker {
  private sequence = 0;
  private readonly requests = new WeakMap<object, RequestEntry>();
  private readonly entries: RequestEntry[] = [];
  private action?: {
    commandId: string;
    commandType: string;
    pageId: string;
    afterSequence: number;
    startedAt: string;
    inputCompleted: boolean;
  };

  begin(commandId: string, commandType: string, pageId: string) {
    this.action = {
      commandId,
      commandType,
      pageId,
      afterSequence: this.sequence,
      startedAt: new Date().toISOString(),
      inputCompleted: false,
    };
  }

  completed(commandId: string) {
    if (this.action?.commandId === commandId) this.action.inputCompleted = true;
  }

  request(request: object, pageId: string, details: Record<string, unknown>) {
    const entry = { sequence: ++this.sequence, pageId, details };
    this.requests.set(request, entry);
    this.entries.push(entry);
    if (this.entries.length > 200) this.entries.shift();
  }

  response(request: object, response: Record<string, unknown>) {
    const entry = this.requests.get(request);
    if (entry) entry.response = response;
  }

  snapshot(pageId: string) {
    const action = this.action;
    if (!action || action.pageId !== pageId) return undefined;
    const entries = this.entries.filter(
      (entry) =>
        entry.pageId === pageId && entry.sequence > action.afterSequence,
    );
    const candidates = entries.slice(-8);
    const requests = candidates.map((entry) => {
      const response = entry.response;
      const body = response?.responseBody;
      const serialized = body === undefined ? undefined : JSON.stringify(body);
      return {
        requestId: entry.sequence,
        method: String(entry.details.method ?? "").slice(0, 16),
        url: String(entry.details.url ?? "").slice(0, 512),
        frameUrl:
          typeof entry.details.frameUrl === "string"
            ? entry.details.frameUrl.slice(0, 512)
            : undefined,
        metadataTruncated: [entry.details.url, entry.details.frameUrl].some(
          (value) => typeof value === "string" && value.length > 512,
        ),
        status: response?.status ?? null,
        errorText:
          typeof response?.errorText === "string"
            ? response.errorText.slice(0, 512)
            : undefined,
        pending: !response,
        bodyPending: response?.bodyPending === true,
        responseSummary: serialized?.slice(0, 1800),
        responseTruncated:
          Boolean(serialized && serialized.length > 1800) ||
          response?.responseBodyTruncated === true,
        responseBodyOmitted: response?.responseBodyOmitted,
      };
    });
    const feedback = {
      version: 1,
      commandId: action.commandId,
      commandType: action.commandType,
      startedAt: action.startedAt,
      inputCompleted: action.inputCompleted,
      association: "temporal",
      coverage: "page-fetch-xhr; same-origin JSON bodies only",
      coverageIncomplete:
        entries.length === 0 ||
        entries.length > 8 ||
        (this.entries[0]?.sequence ?? 0) > action.afterSequence + 1 ||
        requests.some(
          (entry) =>
            entry.pending ||
            entry.bodyPending ||
            entry.metadataTruncated ||
            entry.responseTruncated ||
            entry.responseBodyOmitted,
        ),
      pending: requests.some((entry) => entry.pending || entry.bodyPending),
      requests,
    };
    // Bound the serialized UTF-8 payload, including escaped URLs and multibyte bodies.
    while (
      Buffer.byteLength(JSON.stringify(feedback)) > 12 * 1024 &&
      feedback.requests.length
    ) {
      feedback.requests.shift();
      feedback.coverageIncomplete = true;
    }
    return feedback;
  }
}

/** Stable target and field-state hashes; never return form values to telemetry. */
export async function actionTarget(locator: Locator | ElementHandle<Element>) {
  const read = (node: Element) => {
    const path = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && depth < 16; depth++) {
        const parent: Element | null = current.parentElement;
        parts.unshift(
          `${current.tagName}:${parent ? Array.from(parent.children).indexOf(current) : 0}`,
        );
        const root: Node = current.getRootNode();
        current = parent ?? (root instanceof ShadowRoot ? root.host : null);
      }
      return parts.join("/");
    };
    const target = node.closest("button,a,input,select,textarea") ?? node;
    let region: Element =
      target.closest("form") ?? target.parentElement ?? target;
    for (
      let depth = 0;
      !region.querySelector("input,select,textarea") &&
      region.parentElement &&
      depth < 4;
      depth++
    )
      region = region.parentElement;
    const fields = Array.from(region.querySelectorAll("input,select,textarea"))
      .slice(0, 50)
      .map((field) => {
        const input = field as HTMLInputElement;
        return {
          path: path(field),
          value: input.value,
          checked: input.checked,
        };
      });
    return {
      target: {
        path: path(target),
        text: target.textContent?.trim().slice(0, 160),
        frame: location.href,
      },
      fields,
    };
  };
  const identity =
    "elementHandle" in locator
      ? await locator.evaluate(read, undefined, { timeout: 1000 })
      : await locator.evaluate(read);
  const hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    targetKey: hash(identity.target),
    stateKey: hash(identity.fields),
    hasFormInputs: identity.fields.length > 0,
  };
}
