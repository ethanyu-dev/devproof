import type { Metadata } from "next";
import { ExecutionContextTimeline } from "../../execution-context-timeline";
export const metadata: Metadata = { title: "Step Context 详情" };
export default async function Page({
  params,
}: {
  params: Promise<{ runId: string; attempt: string }>;
}) {
  const { runId, attempt } = await params;
  return <ExecutionContextTimeline runId={runId} attempt={attempt} />;
}
