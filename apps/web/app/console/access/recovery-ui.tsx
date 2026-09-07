"use client";

import { useRef, useState, type ReactNode } from "react";
import { Clipboard } from "lucide-react";
import type { RuntimeRecoverySummary } from "@devproof/contracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import {
  recoveryClosureLabel,
  recoveryWriteLabel,
} from "./runtime-recovery-display";

export const recoveryDate = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN") : "—";
export const evidenceRefs = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
export const recoveryPath = "/console/access/recoveries";
export const runtimeRecoveryPath = (id: string) =>
  `/console/access/runtimes/${encodeURIComponent(id)}/recovery`;

export function RecoveryCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 gap-4 p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </Card>
  );
}
export function RecoveryFeedback({
  error,
  notice,
}: {
  error: string | null;
  notice?: string | null;
}) {
  return (
    <>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {notice ? (
        <Alert variant="success" role="status">
          {notice}
        </Alert>
      ) : null}
    </>
  );
}
export function RecoveryBadges({ item }: { item: RuntimeRecoverySummary }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge
        tone={
          item.closureState === "VERIFIED"
            ? "success"
            : item.closureState === "NEEDS_OPERATOR"
              ? "warning"
              : "neutral"
        }
      >
        {recoveryClosureLabel(item.closureState)}
      </Badge>
      <Badge
        tone={
          ["UNKNOWN", "UNASSESSED"].includes(item.writeOutcomeState)
            ? "warning"
            : "neutral"
        }
      >
        {recoveryWriteLabel(item.writeOutcomeState)}
      </Badge>
    </div>
  );
}
export function CopyId({ label, value }: { label: string; value: string }) {
  const [message, setMessage] = useState("");
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <code className="break-all">{value}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`复制${label}`}
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => setMessage("已复制"),
            () => setMessage("复制失败，请手动复制"),
          );
        }}
      >
        <Clipboard />
      </Button>
      <span role="status" className="text-muted-foreground">
        {message}
      </span>
    </div>
  );
}

export function useRecoveryAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const locked = useRef(false);
  const keys = useRef(new Map<string, { body: string; key: string }>());
  function idempotencyKey(scope: string, body: unknown) {
    const encoded = JSON.stringify(body);
    const previous = keys.current.get(scope);
    if (previous?.body === encoded) return previous.key;
    const key = crypto.randomUUID();
    keys.current.set(scope, { body: encoded, key });
    return key;
  }
  async function act(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { busy, error, notice, setNotice, act, idempotencyKey };
}
