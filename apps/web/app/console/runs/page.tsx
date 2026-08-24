import type { Metadata } from "next";

import { TasksClient } from "./tasks-client";

export const metadata: Metadata = { title: "任务执行" };

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ task?: string | string[] }>;
}) {
  const task = (await searchParams).task;
  return (
    <TasksClient initialId={typeof task === "string" ? task : undefined} />
  );
}
