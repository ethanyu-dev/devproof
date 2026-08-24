import type { ReactNode } from "react";

export function PageHeader({
  actions,
  title,
}: {
  actions?: ReactNode;
  title: string;
}) {
  return (
    <header className="dp-page-head">
      <h1>{title}</h1>
      {actions ? <div>{actions}</div> : null}
    </header>
  );
}
