import type { BrowserConnection } from "@devproof/runtime-protocol";
import { Badge } from "@/components/ui/badge";

export function BrowserTransportBadge({
  transport,
}: {
  transport: BrowserConnection["transport"] | null;
}) {
  const label =
    transport === "direct"
      ? "直连"
      : transport === "relay"
        ? "服务端转发"
        : "模式待确认";
  const description =
    transport === "direct"
      ? "direct：通过 WSS 直接连接浏览器执行节点。"
      : transport === "relay"
        ? "relay：通过 DevProof 服务端转发连接浏览器执行节点。"
        : "连接模式将在建立浏览器通道时确认。";

  return (
    <Badge
      aria-label={`连接模式：${label}`}
      title={description}
      tone={transport ? "info" : "neutral"}
    >
      {label}
    </Badge>
  );
}
