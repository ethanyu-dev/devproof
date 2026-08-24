import type { Metadata } from "next";

import { RunsClient } from "../../runs/runs-client";

export const metadata: Metadata = { title: "执行详情" };

export default async function ExecutionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <RunsClient initialId={id} />;
}
