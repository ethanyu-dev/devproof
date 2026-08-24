import { BadRequestException } from "@nestjs/common";
import type { ZodType } from "zod";

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      error: "VALIDATION_ERROR",
      issues: result.error.issues,
    });
  }

  return result.data;
}
