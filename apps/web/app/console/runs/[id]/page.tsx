import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "任务详情" };

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/console/runs?task=${encodeURIComponent(id)}`);
}
