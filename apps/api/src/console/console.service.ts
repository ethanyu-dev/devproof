import { Injectable } from "@nestjs/common";
import type { RuntimeSettingsInput } from "@devproof/contracts";

import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "./audit.service.js";

@Injectable()
export class ConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  getRuntimeSettings(current: AuthContext) {
    return this.prisma.runtimeSettings.upsert({
      create: { teamId: current.team.id },
      update: {},
      where: { teamId: current.team.id },
    });
  }

  async saveRuntimeSettings(current: AuthContext, input: RuntimeSettingsInput) {
    const row = await this.prisma.runtimeSettings.upsert({
      create: { ...input, teamId: current.team.id },
      update: input,
      where: { teamId: current.team.id },
    });
    await this.audit.record(
      current,
      "runtime.settings.updated",
      "runtime_settings",
      row.id,
    );
    return row;
  }
}
