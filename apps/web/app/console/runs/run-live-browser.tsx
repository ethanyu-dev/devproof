"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { CircleAlert, LoaderCircle, MonitorPlay, Radio, X } from "lucide-react";
import { Badge, Button } from "@devproof/ui";

import { consoleApi } from "@/lib/api";
import { displayLabel, displayMessage } from "@/lib/display-text";

interface BrowserPreviewStatus {
  lifecycle: string;
  ready: boolean;
  runId: string;
  runtimeSession: {
    id: string;
    profileId: string | null;
    profileMode: string;
    runtime: { id: string; name: string; status: string };
    status: string;
  } | null;
  unavailableReason:
    | "NO_SESSION"
    | "PROTOCOL_UNSUPPORTED"
    | "RUNTIME_OFFLINE"
    | "SESSION_UNAVAILABLE"
    | null;
}

interface PreviewFrame {
  capturedAt: string;
  dataBase64: string;
  height: number;
  title: string;
  type: "frame";
  url: string;
  width: number;
}

const STALE_FRAME_MS = 6_000;
const PANEL_EDGE_GAP = 8;
const PANEL_MIN_WIDTH = 200;
const PANEL_MAX_WIDTH = 1_000;
const PREVIEW_ASPECT_RATIO = 16 / 9;

type ResizeCorner = "bottom-left" | "bottom-right" | "top-left" | "top-right";

const RESIZE_HANDLES: Array<{
  corner: ResizeCorner;
  label: string;
}> = [
  { corner: "top-left", label: "从左上角调整窗口大小" },
  { corner: "top-right", label: "从右上角调整窗口大小" },
  { corner: "bottom-left", label: "从左下角调整窗口大小" },
  { corner: "bottom-right", label: "从右下角调整窗口大小" },
];

interface PanelPosition {
  x: number;
  y: number;
}

interface DragState extends PanelPosition {
  pointerId: number;
  startX: number;
  startY: number;
}

interface ResizeGeometry {
  chromeHeight: number;
  frameInset: number;
}

interface ResizeState extends ResizeGeometry {
  bottom: number;
  corner: ResizeCorner;
  left: number;
  pointerId: number;
  right: number;
  startWidth: number;
  startX: number;
  startY: number;
  top: number;
}

export function RunLiveBrowser({
  onClose,
  runId,
}: {
  onClose: () => void;
  runId: string;
}) {
  const [status, setStatus] = useState<BrowserPreviewStatus | null>(null);
  const [streamStatus, setStreamStatus] = useState<
    "idle" | "connecting" | "live" | "interrupted"
  >("idle");
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const [panelPosition, setPanelPosition] = useState<PanelPosition | null>(
    null,
  );
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const dragState = useRef<DragState | null>(null);
  const resizeState = useRef<ResizeState | null>(null);
  const lastFrameAt = useRef(0);

  const loadStatus = useCallback(async () => {
    try {
      const nextStatus = await consoleApi<BrowserPreviewStatus>(
        `/runs/${runId}/browser`,
      );
      setStatus(nextStatus);
      setStatusError(null);
    } catch (loadError) {
      setStatusError((loadError as Error).message);
    }
  }, [runId]);

  useEffect(() => {
    setOverlayHost(document.getElementById("dp-console-workspace-overlay"));
  }, []);

  useEffect(() => {
    if (!overlayHost || !panelRef.current || !panelPosition) return;
    const panel = panelRef.current;
    const keepPanelInBounds = () => {
      const geometry = panelResizeGeometry(panel);
      setPanelWidth((current) => {
        if (current === null) return current;
        const next = clampPanelWidth(current, overlayHost, geometry);
        return Math.abs(next - current) < 0.5 ? current : next;
      });
      setPanelPosition((current) =>
        current ? clampPanelPosition(current, overlayHost, panel) : current,
      );
    };
    const observer = new ResizeObserver(keepPanelInBounds);
    observer.observe(overlayHost);
    observer.observe(panel);
    window.addEventListener("resize", keepPanelInBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", keepPanelInBounds);
    };
  }, [overlayHost, panelPosition !== null]);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  useEffect(() => {
    if (!status?.ready) {
      setFrame(null);
      setStreamStatus("idle");
      setStreamError(null);
      return;
    }

    lastFrameAt.current = Date.now();
    setStreamStatus("connecting");
    const source = new EventSource(
      `/console/api/runs/${runId}/browser/stream`,
      { withCredentials: true },
    );
    source.onmessage = (message) => {
      const event = parsePreviewEvent(message.data);
      if (event.type === "frame") {
        lastFrameAt.current = Date.now();
        setFrame(event);
        setStreamStatus("live");
        setStreamError(null);
      } else if (event.type === "error") {
        setStreamStatus("interrupted");
        setStreamError(displayMessage(event.error));
      }
    };
    source.onerror = () => {
      setStreamStatus("interrupted");
      setStreamError("实时画面连接中断，正在自动恢复。");
    };
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastFrameAt.current > STALE_FRAME_MS) {
        setStreamStatus("interrupted");
        setStreamError("暂时没有收到新画面，正在等待 Browser Runtime 恢复。");
      }
    }, 1_000);
    return () => {
      window.clearInterval(watchdog);
      source.close();
    };
  }, [runId, status?.ready, status?.runtimeSession?.id]);

  if (!overlayHost) return null;

  const startDragging = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.target;
    if (
      event.button !== 0 ||
      (target instanceof Element &&
        target.closest("button, a, input, select, textarea"))
    ) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const hostRect = overlayHost.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const origin = {
      x: panelRect.left - hostRect.left,
      y: panelRect.top - hostRect.top,
    };
    dragState.current = {
      ...origin,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    setPanelPosition(origin);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const movePanel = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    if (event.buttons === 0) {
      stopDragging(event);
      return;
    }
    setPanelPosition(
      clampPanelPosition(
        {
          x: drag.x + event.clientX - drag.startX,
          y: drag.y + event.clientY - drag.startY,
        },
        overlayHost,
        panel,
      ),
    );
  };

  const stopDragging = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const startResizing = (
    event: ReactPointerEvent<HTMLButtonElement>,
    corner: ResizeCorner,
  ) => {
    if (event.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    const hostRect = overlayHost.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const left = panelRect.left - hostRect.left;
    const top = panelRect.top - hostRect.top;
    resizeState.current = {
      ...panelResizeGeometry(panel),
      bottom: top + panelRect.height,
      corner,
      left,
      pointerId: event.pointerId,
      right: left + panelRect.width,
      startWidth: panelRect.width,
      startX: event.clientX,
      startY: event.clientY,
      top,
    };
    setPanelPosition({ x: left, y: top });
    setPanelWidth(panelRect.width);
    setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const resizePanel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeState.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (event.buttons === 0) {
      stopResizing(event);
      return;
    }
    const horizontalDelta = resize.corner.endsWith("left")
      ? resize.startX - event.clientX
      : event.clientX - resize.startX;
    const verticalDelta =
      (resize.corner.startsWith("top")
        ? resize.startY - event.clientY
        : event.clientY - resize.startY) * PREVIEW_ASPECT_RATIO;
    const delta =
      Math.abs(horizontalDelta) >= Math.abs(verticalDelta)
        ? horizontalDelta
        : verticalDelta;
    const width = clampPanelWidth(
      resize.startWidth + delta,
      overlayHost,
      resize,
    );
    const height = panelHeightForWidth(width, resize);
    const position = clampPanelPositionForSize(
      {
        x: resize.corner.endsWith("left") ? resize.right - width : resize.left,
        y: resize.corner.startsWith("top")
          ? resize.bottom - height
          : resize.top,
      },
      overlayHost,
      width,
      height,
    );
    setPanelWidth(width);
    setPanelPosition(position);
  };

  const stopResizing = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeState.current?.pointerId !== event.pointerId) return;
    resizeState.current = null;
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const resizePanelWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    corner: ResizeCorner,
  ) => {
    if (!event.key.startsWith("Arrow")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const grows = horizontal
      ? (corner.endsWith("left") && event.key === "ArrowLeft") ||
        (corner.endsWith("right") && event.key === "ArrowRight")
      : (corner.startsWith("top") && event.key === "ArrowUp") ||
        (corner.startsWith("bottom") && event.key === "ArrowDown");
    const hostRect = overlayHost.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const geometry = panelResizeGeometry(panel);
    const width = clampPanelWidth(
      panelRect.width + (grows ? 1 : -1) * (event.shiftKey ? 50 : 10),
      overlayHost,
      geometry,
    );
    const height = panelHeightForWidth(width, geometry);
    const left = panelRect.left - hostRect.left;
    const top = panelRect.top - hostRect.top;
    setPanelWidth(width);
    setPanelPosition(
      clampPanelPositionForSize(
        {
          x: corner.endsWith("left") ? left + panelRect.width - width : left,
          y: corner.startsWith("top") ? top + panelRect.height - height : top,
        },
        overlayHost,
        width,
        height,
      ),
    );
    event.preventDefault();
  };

  const error = streamError ?? statusError;
  const panel = (
    <section
      aria-label="Runtime 实时运行状态"
      className={`dp-run-live-preview${dragging ? " is-dragging" : ""}${resizing ? " is-resizing" : ""}`}
      ref={panelRef}
      style={
        panelPosition || panelWidth
          ? {
              ...(panelPosition
                ? {
                    left: panelPosition.x,
                    right: "auto",
                    top: panelPosition.y,
                  }
                : {}),
              ...(panelWidth ? { width: panelWidth } : {}),
            }
          : undefined
      }
    >
      <header
        onLostPointerCapture={stopDragging}
        onPointerCancel={stopDragging}
        onPointerDown={startDragging}
        onPointerMove={movePanel}
        onPointerUp={stopDragging}
        title="拖拽移动实时运行窗口"
      >
        <span>
          <MonitorPlay />
          <span>
            <b>实时运行状态</b>
            <small>
              {status?.runtimeSession?.runtime.name ?? "Browser Runtime"}
            </small>
          </span>
        </span>
        <div>
          <Badge tone={streamStatus === "live" ? "success" : "neutral"}>
            {streamLabel(streamStatus)}
          </Badge>
          <Button
            aria-label="关闭实时运行状态"
            onClick={onClose}
            title="关闭实时运行状态"
            variant="secondary"
          >
            <X />
          </Button>
        </div>
      </header>

      <div className="dp-run-live-preview-frame">
        {frame ? (
          <img
            alt="Browser Runtime 只读实时画面"
            draggable={false}
            src={`data:image/jpeg;base64,${frame.dataBase64}`}
          />
        ) : !status ? (
          <div className="dp-run-live-preview-placeholder">
            <LoaderCircle className="dp-run-live-preview-spinner" />
            正在检查 Browser Runtime…
          </div>
        ) : !status.ready ? (
          <div className="dp-run-live-preview-placeholder">
            <CircleAlert />
            <span>
              <b>{unavailableCopy(status).title}</b>
              <small>{unavailableCopy(status).detail}</small>
            </span>
          </div>
        ) : (
          <div className="dp-run-live-preview-placeholder">
            <LoaderCircle className="dp-run-live-preview-spinner" />
            正在连接浏览器实时画面…
          </div>
        )}

        {frame ? (
          <div className="dp-run-live-preview-meta">
            <span>{frame.title || "未命名页面"}</span>
            <small>{frame.url}</small>
          </div>
        ) : null}
        {error ? (
          <div className="dp-run-live-preview-error" role="status">
            <CircleAlert /> {error}
          </div>
        ) : null}
      </div>

      <footer>
        <Radio /> 只读实时画面 · 无法向浏览器发送键盘、鼠标或触控输入
      </footer>

      {RESIZE_HANDLES.map(({ corner, label }) => (
        <button
          aria-label={label}
          className={`dp-run-live-preview-resize-handle is-${corner}`}
          key={corner}
          onKeyDown={(event) => resizePanelWithKeyboard(event, corner)}
          onLostPointerCapture={stopResizing}
          onPointerCancel={stopResizing}
          onPointerDown={(event) => startResizing(event, corner)}
          onPointerMove={resizePanel}
          onPointerUp={stopResizing}
          title={label}
          type="button"
        />
      ))}
    </section>
  );

  return createPortal(panel, overlayHost);
}

function parsePreviewEvent(
  value: string,
): PreviewFrame | { error: string; type: "error" } {
  try {
    return JSON.parse(value) as PreviewFrame;
  } catch {
    return { error: "实时画面流返回了无效数据。", type: "error" };
  }
}

function streamLabel(status: "idle" | "connecting" | "live" | "interrupted") {
  if (status === "live") return "实时";
  if (status === "interrupted") return "恢复中";
  if (status === "connecting") return "连接中";
  return "等待中";
}

function unavailableCopy(status: BrowserPreviewStatus) {
  if (status.unavailableReason === "NO_SESSION") {
    return {
      detail: "任务运行后会自动接入实时画面。",
      title: "正在等待浏览器会话",
    };
  }
  if (status.unavailableReason === "PROTOCOL_UNSUPPORTED") {
    return {
      detail: "请更新并重启 Browser Runtime 后重新发起任务。",
      title: "当前 Runtime 不支持实时预览",
    };
  }
  if (status.unavailableReason === "RUNTIME_OFFLINE") {
    return {
      detail: "Runtime 重新上线后会自动恢复画面。",
      title: "Browser Runtime 当前离线",
    };
  }
  return {
    detail: `会话状态：${displayLabel(status.runtimeSession?.status ?? "未知")}。`,
    title: "浏览器会话暂不可用",
  };
}

function clampPanelPosition(
  position: PanelPosition,
  host: HTMLElement,
  panel: HTMLElement,
): PanelPosition {
  const maxX = Math.max(
    PANEL_EDGE_GAP,
    host.clientWidth - panel.offsetWidth - PANEL_EDGE_GAP,
  );
  const maxY = Math.max(
    PANEL_EDGE_GAP,
    host.clientHeight - panel.offsetHeight - PANEL_EDGE_GAP,
  );
  return {
    x: Math.min(maxX, Math.max(PANEL_EDGE_GAP, position.x)),
    y: Math.min(maxY, Math.max(PANEL_EDGE_GAP, position.y)),
  };
}

function clampPanelPositionForSize(
  position: PanelPosition,
  host: HTMLElement,
  width: number,
  height: number,
): PanelPosition {
  const maxX = Math.max(
    PANEL_EDGE_GAP,
    host.clientWidth - width - PANEL_EDGE_GAP,
  );
  const maxY = Math.max(
    PANEL_EDGE_GAP,
    host.clientHeight - height - PANEL_EDGE_GAP,
  );
  return {
    x: Math.min(maxX, Math.max(PANEL_EDGE_GAP, position.x)),
    y: Math.min(maxY, Math.max(PANEL_EDGE_GAP, position.y)),
  };
}

function clampPanelWidth(
  width: number,
  host: HTMLElement,
  geometry: ResizeGeometry,
) {
  const maxByHeight =
    (host.clientHeight - PANEL_EDGE_GAP * 2 - geometry.chromeHeight) *
      PREVIEW_ASPECT_RATIO +
    geometry.frameInset;
  const maxWidth = Math.max(
    0,
    Math.min(
      PANEL_MAX_WIDTH,
      host.clientWidth - PANEL_EDGE_GAP * 2,
      maxByHeight,
    ),
  );
  const minWidth = Math.min(PANEL_MIN_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, width));
}

function panelHeightForWidth(width: number, geometry: ResizeGeometry) {
  return (
    geometry.chromeHeight +
    Math.max(0, width - geometry.frameInset) / PREVIEW_ASPECT_RATIO
  );
}

function panelResizeGeometry(panel: HTMLElement): ResizeGeometry {
  const frame = panel.querySelector<HTMLElement>(".dp-run-live-preview-frame");
  if (!frame) {
    return {
      chromeHeight: 0,
      frameInset: 0,
    };
  }
  return {
    chromeHeight: panel.offsetHeight - frame.offsetHeight,
    frameInset: panel.offsetWidth - frame.offsetWidth,
  };
}
