import type {
  BrowserConnection,
  BrowserHumanInputEvent,
} from "@devproof/runtime-protocol";
import { consoleApi } from "./api";

/** The transport is negotiated explicitly. A failed direct connection never relays input. */
export class BrowserControlConnection {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private source: EventSource | undefined;
  private socket: WebSocket | undefined;
  private mode: "direct" | "relay" | undefined;
  private ready = false;
  private closed = false;
  private renewal: ReturnType<typeof setTimeout> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Map<
    string,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly options: {
      connectionPath: string;
      connectionBody?: unknown;
      streamUrl: string;
      relayInput: (events: BrowserHumanInputEvent[]) => Promise<unknown>;
      onTransportChange?: (transport: BrowserConnection["transport"]) => void;
    },
  ) {
    void this.connect();
  }

  private ticket() {
    return consoleApi<BrowserConnection>(this.options.connectionPath, {
      method: "POST",
      ...(this.options.connectionBody
        ? { body: JSON.stringify(this.options.connectionBody) }
        : {}),
    });
  }

  private async connect() {
    try {
      const connection = await this.ticket();
      if (this.closed) return;
      // Do not downgrade an established direct channel on renewal/reconnect.
      if (this.mode === "direct" && connection.transport !== "direct")
        throw new Error("Direct browser connection is unavailable.");
      this.mode = connection.transport;
      this.options.onTransportChange?.(connection.transport);
      if (connection.transport === "relay") {
        this.source = new EventSource(this.options.streamUrl, {
          withCredentials: true,
        });
        this.ready = true;
        this.source.onmessage = (event) => this.onmessage?.(event);
        this.source.onerror = () => this.onerror?.();
        return;
      }
      if (new URL(connection.url).protocol !== "wss:")
        throw new Error("A secure browser connection is required.");
      const socket = new WebSocket(connection.url);
      this.socket = socket;
      const opening = setTimeout(() => socket.close(), 8000);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({ type: "authenticate", ticket: connection.ticket }),
        );
      socket.onmessage = (event) => {
        try {
          const value = JSON.parse(String(event.data));
          if (value.type === "ready") {
            clearTimeout(opening);
            this.ready = true;
            this.scheduleRenewal(socket);
          } else if (value.type === "ack" || value.type === "input-error") {
            const pending = this.pending.get(value.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(value.id);
            if (value.type === "ack") pending.resolve();
            else pending.reject(new Error(value.error));
          } else this.onmessage?.({ data: String(event.data) });
        } catch {
          socket.close();
        }
      };
      socket.onerror = () => this.onerror?.();
      socket.onclose = () => {
        clearTimeout(opening);
        clearTimeout(this.renewal);
        this.ready = false;
        this.rejectPending();
        if (!this.closed) {
          this.onerror?.();
          this.reconnect = setTimeout(() => void this.connect(), 2000);
        }
      };
    } catch {
      if (!this.closed) {
        this.onerror?.();
        this.reconnect = setTimeout(() => void this.connect(), 2000);
      }
    }
  }

  private scheduleRenewal(socket: WebSocket) {
    clearTimeout(this.renewal);
    this.renewal = setTimeout(async () => {
      try {
        const next = await this.ticket();
        if (
          this.closed ||
          socket !== this.socket ||
          socket.readyState !== WebSocket.OPEN
        )
          return;
        if (next.transport !== "direct" || next.url !== socket.url)
          throw new Error();
        socket.send(
          JSON.stringify({ type: "authenticate", ticket: next.ticket }),
        );
      } catch {
        socket.close();
      }
    }, 5000);
  }

  async input(events: BrowserHumanInputEvent[]) {
    if (this.closed || !this.ready)
      throw new Error("浏览器尚未连接，请等待画面恢复。");
    if (this.mode === "relay") {
      await this.options.relayInput(events);
      return;
    }
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new Error("浏览器直连已中断。");
    const id = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("浏览器输入确认超时，请检查页面状态。"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ type: "input", id, events }));
    });
  }

  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("浏览器连接已中断，输入结果未确认。"));
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.renewal);
    clearTimeout(this.reconnect);
    this.source?.close();
    this.socket?.close();
    this.rejectPending();
  }
}
