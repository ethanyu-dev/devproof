import { Body, Controller, Get, Headers, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { parseBody } from "../common/validation.js";
import { AuthSnapshotTransferService } from "./auth-snapshot-transfer.service.js";
const uploadSchema = z
  .object({
    generation: z.number().int().positive(),
    envelope: z
      .string()
      .max(24 * 1024 * 1024)
      .regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u),
  })
  .strict();
@Controller("runtime/:runtimeId/sessions/:sessionId/auth-snapshot")
export class AuthSnapshotTransferController {
  constructor(private readonly snapshots: AuthSnapshotTransferService) {}
  @Post()
  upload(
    @Param("runtimeId") runtimeId: string,
    @Param("sessionId") sessionId: string,
    @Headers("authorization") token: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parseBody(uploadSchema, body);
    return this.snapshots.upload(
      runtimeId,
      token,
      sessionId,
      input.generation,
      input.envelope,
    );
  }
  @Get()
  download(
    @Param("runtimeId") runtimeId: string,
    @Param("sessionId") sessionId: string,
    @Headers("authorization") token: string | undefined,
  ) {
    return this.snapshots.download(runtimeId, token, sessionId);
  }
}
