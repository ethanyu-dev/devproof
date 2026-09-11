import type { Metadata } from "next";
import { TaskDetailClient } from "../task-detail-client";

export const metadata: Metadata = { title: "任务详情" };

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TaskDetailClient id={id} key={id} />;
}
