import { randomUUID } from "node:crypto";

import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import type {
  BrowserHumanInputEvent,
  RuntimeHumanInputResult,
  RuntimeHumanPreviewFrame,
} from "@devproof/runtime-protocol";

import { RuntimeConnectionHub } from "./runtime-connection-hub.service.js";

interface RuntimeSessionFence {
  controlGeneration?: number;
  fencingToken: bigint;
  id: string;
  leaseToken: string;
  runtimeId: string;
}

export type HumanPreviewEvent =
  | { connected: boolean; type: "status" }
  | ({ type: "frame" } & Omit<RuntimeHumanPreviewFrame, "type">)
  | { error: string; type: "error" };

interface PreviewSubscription {
  emit: (event: HumanPreviewEvent) => void;
  fencingToken: string;
  leaseToken: string;
  runtimeId: string;
  sessionId: string;
}

interface PendingInput {
  fencingToken: string;
  leaseToken: string;
  reject: (error: Error) => void;
  resolve: () => void;
  runtimeId: string;
  sessionId: string;
  timer: NodeJS.Timeout;
}

@Injectable()
export class RuntimeHumanControlRelay {
  private readonly streams = new Map<string, PreviewSubscription>();
  private readonly pendingInputs = new Map<string, PendingInput>();

  constructor(private readonly hub: RuntimeConnectionHub) {}

  async subscribe(
    session: RuntimeSessionFence,
    emit: (event: HumanPreviewEvent) => void,
  ) {
    const streamId = randomUUID();
    const fencingToken = session.fencingToken.toString();
    this.streams.set(streamId, {
      emit,
      fencingToken,
      leaseToken: session.leaseToken,
      runtimeId: session.runtimeId,
      sessionId: session.id,
    });
    emit({ connected: false, type: "status" });
    try {
      await this.hub.send(session.runtimeId, {
        fencingToken,
        intervalMs: 500,
        leaseToken: session.leaseToken,
        quality: 65,
        sessionId: session.id,
        streamId,
        type: "human.preview.subscribe",
      });
    } catch (error) {
      this.streams.delete(streamId);
      throw error;
    }
    return async () => {
      const current = this.streams.get(streamId);
      if (!current) return;
      this.streams.delete(streamId);
      await this.hub
        .send(session.runtimeId, {
          sessionId: session.id,
          streamId,
          type: "human.preview.unsubscribe",
        })
        .catch(() => undefined);
    };
  }

  async dispatch(
    session: RuntimeSessionFence,
    events: BrowserHumanInputEvent[],
  ) {
    const dispatchId = randomUUID();
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInputs.delete(dispatchId);
        reject(new Error("Browser input acknowledgement timed out."));
      }, 5_000);
      timer.unref();
      this.pendingInputs.set(dispatchId, {
        fencingToken: session.fencingToken.toString(),
        leaseToken: session.leaseToken,
        reject,
        resolve,
        runtimeId: session.runtimeId,
        sessionId: session.id,
        timer,
      });
    });
    try {
      await this.hub.send(session.runtimeId, {
        controlGeneration: session.controlGeneration ?? 0,
        dispatchId,
        events,
        fencingToken: session.fencingToken.toString(),
        leaseToken: session.leaseToken,
        sessionId: session.id,
        type: "human.input.dispatch",
      });
      await completion;
    } catch (error) {
      const pending = this.pendingInputs.get(dispatchId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingInputs.delete(dispatchId);
      }
      throw new ServiceUnavailableException(
        error instanceof Error ? error.message : "Browser input failed.",
      );
    }
  }

  acceptFrame(runtimeId: string, frame: RuntimeHumanPreviewFrame) {
    const stream = this.streams.get(frame.streamId);
    if (
      !stream ||
      stream.runtimeId !== runtimeId ||
      stream.sessionId !== frame.sessionId ||
      stream.leaseToken !== frame.leaseToken ||
      stream.fencingToken !== frame.fencingToken
    ) {
      return;
    }
    stream.emit({ ...frame, type: "frame" });
  }

  acceptInputResult(runtimeId: string, result: RuntimeHumanInputResult) {
    const pending = this.pendingInputs.get(result.dispatchId);
    if (
      !pending ||
      pending.runtimeId !== runtimeId ||
      pending.sessionId !== result.sessionId ||
      pending.leaseToken !== result.leaseToken ||
      pending.fencingToken !== result.fencingToken
    ) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingInputs.delete(result.dispatchId);
    if (result.ok) pending.resolve();
    else pending.reject(new Error(result.error ?? "Browser input failed."));
  }

  runtimeDisconnected(runtimeId: string) {
    for (const [streamId, stream] of this.streams) {
      if (stream.runtimeId !== runtimeId) continue;
      stream.emit({
        error: "Browser Runtime connection was interrupted.",
        type: "error",
      });
      this.streams.delete(streamId);
    }
    for (const [dispatchId, pending] of this.pendingInputs) {
      if (pending.runtimeId !== runtimeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error("Browser Runtime connection was interrupted."));
      this.pendingInputs.delete(dispatchId);
    }
  }
}
