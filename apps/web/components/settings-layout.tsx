import type { ReactNode } from "react";

export function SettingsLayout({
  editor,
  list,
}: {
  editor: ReactNode;
  list: ReactNode;
}) {
  return (
    <div className="dp-settings-grid">
      <section className="dp-resource-list">{list}</section>
      <section className="dp-resource-editor">{editor}</section>
    </div>
  );
}

export function LoadingState() {
  return (
    <div aria-live="polite" className="dp-loading" role="status">
      读取团队配置…
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
    <div className="dp-empty">
      <i />
      <strong>{title}</strong>
      <span>{description}</span>
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
    <div
      aria-live={tone === "error" ? "assertive" : "polite"}
      className={"dp-form-message " + tone}
      role={tone === "error" ? "alert" : "status"}
    >
      {message}
    </div>
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
    <div className="dp-error-state" role="alert">
      <strong>暂时无法读取数据</strong>
      <span>{message}</span>
      <button onClick={onRetry} type="button">
        重新加载
      </button>
    </div>
  );
}
