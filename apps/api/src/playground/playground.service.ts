import { Injectable } from "@nestjs/common";
import type {
  PlaygroundRunInput,
  SpecificationPlaygroundInput,
} from "@devproof/contracts";

import type { AuthContext } from "../auth/auth.types.js";
import { BrowserRuntimeService } from "../console/browser-runtime.service.js";
import { env } from "../config/env.js";
import { IssueContextResolverService } from "../specifications/issue-context-resolver.service.js";
import { taskToolContext } from "../task-executions/task-execution-console.controller.js";
import { TaskExecutionService } from "../task-executions/task-execution.service.js";

@Injectable()
export class PlaygroundService {
  constructor(
    private readonly runtimes: BrowserRuntimeService,
    private readonly tasks: TaskExecutionService,
    private readonly issueResolver: IssueContextResolverService,
  ) {}

  async readiness(current: AuthContext) {
    const browserRuntimes = await this.runtimes.list(current);
    const onlineRuntimes = browserRuntimes.filter(
      (browserRuntime) => browserRuntime.status === "ONLINE",
    );
    const specification = this.issueResolver.readiness();
    return {
      apiUrl: env().API_PUBLIC_URL,
      canExecuteNow: onlineRuntimes.length > 0,
      canSubmit: true,
      components: {
        agentRuntime: {
          endpoint: `${env().API_PUBLIC_URL}/internal/v2/runtime/tasks/claim`,
          name: "devproof-agent-runtime",
          provider: "LEASED_WORKER",
          ready: true,
          status: "LEASE_ENDPOINT_READY",
        },
        execution: {
          matchingRunners: onlineRuntimes.length,
          ready: onlineRuntimes.length > 0,
          status: onlineRuntimes.length > 0 ? "READY" : "NO_MATCHING_RUNNER",
        },
        specification,
      },
      ready: true,
      runners: onlineRuntimes.map((browserRuntime) => ({
        id: browserRuntime.id,
        name: browserRuntime.name,
        status: browserRuntime.status,
      })),
      setupRequired: false,
      status:
        onlineRuntimes.length > 0 && specification.ready ? "READY" : "DEGRADED",
    };
  }

  createRun(current: AuthContext, input: PlaygroundRunInput) {
    return this.tasks.create(
      taskToolContext(current),
      {
        idempotencyKey: `playground-task:${input.submissionId}`,
        kind: "DIRECT_RUN",
        run: {
          businessReferences: [],
          browserPolicy: {
            availabilityPolicy: "WAIT",
            profile: { mode: "EPHEMERAL" },
            requiredCapabilities: ["browser"],
          },
          criteria: [
            {
              description: input.acceptanceCriterion,
              id: "playground-criterion-1",
              required: true,
              requiredEvidenceKinds: [],
            },
          ],
          deadlineSeconds: 900,
          environment: {
            hitlEnabled: input.hitlEnabled,
            targetUrl: input.targetUrl,
          },
          goal: input.goal,
          hitlPolicy: {
            enabled: input.hitlEnabled,
            notificationChannels: input.hitlEnabled ? ["FEISHU"] : [],
            onTimeout: "INCONCLUSIVE",
            timeoutSeconds: 3600,
          },
          idempotencyKey: `playground-run:${input.submissionId}`,
          retryPolicy: {
            maxAttempts: 3,
            retryOn: [
              "TOOL_EXECUTION",
              "PROVIDER",
              "LIFECYCLE_PROTOCOL",
              "BROWSER_RUNTIME",
              "RUNTIME_LOST",
            ],
          },
          source: { kind: "PLAYGROUND" },
        },
      },
      { kind: "USER", triggerSource: "CONSOLE", userId: current.user.id },
    );
  }

  async resolveSpecification(
    current: AuthContext,
    input: SpecificationPlaygroundInput,
  ) {
    return this.tasks.create(
      taskToolContext(current),
      {
        idempotencyKey: `playground-issue-task:${input.submissionId}`,
        issueRef: input.issueRef,
        kind: "ISSUE_SPEC",
        profilePolicy: input.profilePolicy,
        ...(input.targetUrl ? { targetUrl: input.targetUrl } : {}),
      },
      { kind: "USER", triggerSource: "CONSOLE", userId: current.user.id },
    );
  }
}
