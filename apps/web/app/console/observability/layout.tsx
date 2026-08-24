import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "系统监控" };

export default function ObservabilityLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
