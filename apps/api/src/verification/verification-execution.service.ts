import { Injectable } from "@nestjs/common";

import { ExecutionRunnerRegistry } from "./execution-runner-registry.service.js";

@Injectable()
export class VerificationExecutionService {
  constructor(private readonly runners: ExecutionRunnerRegistry) {}

  async listRunners(teamId: string) {
    const groups = await Promise.all(
      this.runners.all().map((runner) => runner.describe(teamId)),
    );
    return groups.flat();
  }
}
