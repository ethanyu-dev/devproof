import { Injectable, NotFoundException } from "@nestjs/common";

import { BrowserExecutionRunner } from "./browser-execution-runner.service.js";
import type { ExecutionRunner } from "./runtime-adapters.js";

@Injectable()
export class ExecutionRunnerRegistry {
  constructor(private readonly browser: BrowserExecutionRunner) {}

  get(kind = "BROWSER"): ExecutionRunner {
    if (kind === this.browser.kind) return this.browser;
    throw new NotFoundException(`Execution Runner ${kind} is not registered.`);
  }

  all(): ExecutionRunner[] {
    return [this.browser];
  }
}
