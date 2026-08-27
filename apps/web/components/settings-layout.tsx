import { AlertCircle, Inbox, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function SettingsLayout({
  editor,
  list,
}: {
  editor: ReactNode;
  list: ReactNode;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.7fr)]">
      <section className="min-w-0">{list}</section>
      <section className="min-w-0">{editor}</section>
    </div>
  );
}

export function LoadingState({ label = "正在读取数据…" }: { label?: string }) {
  return (
    <div
      aria-live="polite"
      className="flex min-h-40 items-center justify-center gap-2 px-6 py-10 text-sm text-muted-foreground"
      role="status"
    >
      <LoaderCircle className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export function EmptyState({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="grid min-h-44 place-items-center px-6 py-10 text-center">
      <div>
        <span className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
          <Inbox className="size-5" />
        </span>
        <strong className="block text-sm font-medium">{title}</strong>
        <span className="mt-1.5 block max-w-sm text-sm leading-6 text-muted-foreground">
          {description}
        </span>
      </div>
    </div>
  );
}

export function FormMessage({
  message,
  tone,
}: {
  message: string;
  tone: "error" | "success";
}) {
  return (
    <Alert
      className="mb-4"
      variant={tone === "error" ? "destructive" : "success"}
    >
      <AlertCircle />
      <div>
        <AlertDescription>{message}</AlertDescription>
      </div>
    </Alert>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid min-h-48 place-items-center px-6 py-10 text-center">
      <div className="max-w-md">
        <span className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-destructive/10 text-destructive">
          <AlertCircle className="size-5" />
        </span>
        <strong className="block text-sm font-medium">暂时无法读取数据</strong>
        <span className="mt-1.5 block text-sm leading-6 text-muted-foreground">
          {message}
        </span>
        <Button className="mt-4" onClick={onRetry} size="sm" variant="outline">
          重新加载
        </Button>
      </div>
    </div>
  );
}
