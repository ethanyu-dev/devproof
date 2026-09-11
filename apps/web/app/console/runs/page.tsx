import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { TasksClient } from "./tasks-client";
import { taskDetailHref } from "./task-navigation";

export const metadata: Metadata = { title: "任务执行" };

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ task?: string | string[] }>;
}) {
  const task = (await searchParams).task;
  if (typeof task === "string" && task.trim()) redirect(taskDetailHref(task));
  return <TasksClient />;
}
