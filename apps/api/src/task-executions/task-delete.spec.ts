import { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";
import type { PrismaService } from "../database/prisma.service.js";
import { deleteTask } from "./task-delete.js";

function prismaError(code: string, sqlState?: string) {
  return new Prisma.PrismaClientKnownRequestError("Database request failed", {
    clientVersion: "7",
    code,
    ...(sqlState ? { meta: { code: sqlState } } : {}),
  });
}

function adapterError(sqlState: string) {
  return new Prisma.PrismaClientKnownRequestError("Raw query failed", {
    clientVersion: "7",
    code: "P2010",
    meta: { driverAdapterError: { cause: { originalCode: sqlState } } },
  });
}

it.each([
  prismaError("P2034"),
  prismaError("P2010", "40001"),
  prismaError("P2010", "40P01"),
  adapterError("40001"),
  adapterError("40P01"),
])(
  "returns a retryable conflict for a rolled-back deletion ($code, $meta)",
  async (error) => {
    const transaction = vi.fn().mockRejectedValue(error);
    const prisma = { $transaction: transaction } as unknown as PrismaService;
    await expect(deleteTask(prisma, "team", "task")).rejects.toMatchObject({
      status: 409,
      message: "任务状态刚刚发生变化，请刷新后重试删除。",
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  },
);

it.each([
  prismaError("P2010", "23503"),
  prismaError("P2010"),
  prismaError("P2002"),
  adapterError("23503"),
  new Error("Unexpected failure 40001"),
])("preserves unrelated deletion errors", async (error) => {
  const prisma = {
    $transaction: vi.fn().mockRejectedValue(error),
  } as unknown as PrismaService;
  await expect(deleteTask(prisma, "team", "task")).rejects.toBe(error);
});
