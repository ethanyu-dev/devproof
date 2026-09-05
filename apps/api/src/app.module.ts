import { Module } from "@nestjs/common";
import { SessionRecoveryService } from "./runtime/session-recovery.service.js";
import { SessionClosureService } from "./runtime/session-closure.service.js";
import { SessionRecoveryWorker } from "./runtime/session-recovery.worker.js";
import { RuntimeDrainService } from "./runtime/runtime-drain.service.js";
import { RuntimeRecoveryController } from "./runtime/runtime-recovery.controller.js";
import { APP_INTERCEPTOR } from "@nestjs/core";

import { AgentRuntimeTaskController } from "./agent-runtime/agent-runtime-task.controller.js";
import { AgentRuntimeTaskService } from "./agent-runtime/agent-runtime-task.service.js";
import { AgentRuntimeControlController } from "./agent-runtime/agent-runtime-control.controller.js";
import { AgentRuntimeControlService } from "./agent-runtime/agent-runtime-control.service.js";
import { UnifiedBrowserExecutionService } from "./agent-runtime/unified-browser-execution.service.js";
import { SpecAnalysisRuntimeController } from "./agent-runtime/spec-analysis-runtime.controller.js";
import { SpecAnalysisRuntimeService } from "./agent-runtime/spec-analysis-runtime.service.js";
import { PostRunAnalysisRuntimeController } from "./agent-runtime/post-run-analysis-runtime.controller.js";
import { PostRunAnalysisRuntimeService } from "./agent-runtime/post-run-analysis-runtime.service.js";

import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { FeishuOAuthClient } from "./auth/feishu-oauth.client.js";
import { UserBrowserProfilesController } from "./browser-profiles/user-browser-profiles.controller.js";
import { UserBrowserProfilesService } from "./browser-profiles/user-browser-profiles.service.js";
import { BrowserProfileLifecycleWorker } from "./browser-profiles/browser-profile-lifecycle.worker.js";
import { BrowserRuntimeService } from "./console/browser-runtime.service.js";
import { ConsoleController } from "./console/console.controller.js";
import { ConsoleService } from "./console/console.service.js";
import { AuditService } from "./console/audit.service.js";
import { PrismaService } from "./database/prisma.service.js";
import { HealthService } from "./observability/health.service.js";
import { MetricsService } from "./observability/metrics.service.js";
import { ObservabilityController } from "./observability/observability.controller.js";
import { ObservabilityService } from "./observability/observability.service.js";
import { ToolInvocationInterceptor } from "./observability/tool-invocation.interceptor.js";
import { ToolInvocationService } from "./observability/tool-invocation.service.js";
import { ToolInvocationSweeper } from "./observability/tool-invocation-sweeper.service.js";
import { WorkerMonitorService } from "./observability/worker-monitor.service.js";
import { RetentionWorker } from "./observability/retention-worker.service.js";
import { ConsoleObservabilityController } from "./observability/console-observability.controller.js";
import { OperationalMetricsService } from "./observability/operational-metrics.service.js";
import { ObjectStorageService } from "./infrastructure/object-storage.service.js";
import { FeishuEventsController } from "./integrations/feishu-events.controller.js";
import { FeishuIntegrationService } from "./integrations/feishu-integration.service.js";
import { ExecutionRunController } from "./execution-runs/execution-run.controller.js";
import { ExecutionRunConsoleController } from "./execution-runs/execution-run-console.controller.js";
import { ExecutionRunService } from "./execution-runs/execution-run.service.js";
import { RunBrowserPreviewController } from "./execution-runs/run-browser-preview.controller.js";
import { RunBrowserPreviewService } from "./execution-runs/run-browser-preview.service.js";
import { UnifiedRunCleanupWorker } from "./execution-runs/unified-run-cleanup.worker.js";
import { RunHitlBrowserController } from "./execution-runs/run-hitl-browser.controller.js";
import { RunHitlBrowserService } from "./execution-runs/run-hitl-browser.service.js";
import { RedisService } from "./infrastructure/redis.service.js";
import { GithubPullRequestClient } from "./specifications/github-pull-request.client.js";
import { IssueContextResolverService } from "./specifications/issue-context-resolver.service.js";
import { KnowledgeContextClient } from "./specifications/knowledge-context.client.js";
import { LinearContextClient } from "./specifications/linear-context.client.js";
import { TestSpecificationConsoleController } from "./specifications/test-specification-console.controller.js";
import { TestSpecificationController } from "./specifications/test-specification.controller.js";
import { TestSpecificationService } from "./specifications/test-specification.service.js";
import { PlaygroundController } from "./playground/playground.controller.js";
import { PlaygroundService } from "./playground/playground.service.js";
import { RuntimeCommandDispatcher } from "./runtime/runtime-command-dispatcher.service.js";
import { RuntimeConnectionHub } from "./runtime/runtime-connection-hub.service.js";
import { RuntimeController } from "./runtime/runtime.controller.js";
import { RuntimeGatewayService } from "./runtime/runtime-gateway.service.js";
import { RuntimeHumanControlRelay } from "./runtime/runtime-human-control-relay.service.js";
import { RuntimeLeaseSweeper } from "./runtime/runtime-lease-sweeper.service.js";
import { RuntimeSessionsService } from "./runtime/runtime-sessions.service.js";
import { RuntimeRoutingService } from "./console/runtime-routing.service.js";
import { GithubAccessService } from "./console/github-access.service.js";
import { AgentModelConfigurationService } from "./console/agent-model-configuration.service.js";
import { CredentialCipherService } from "./security/credential-cipher.service.js";
import { TestDataController } from "./test-data/test-data.controller.js";
import { TestDataService } from "./test-data/test-data.service.js";
import { ToolAuthGuard } from "./tool-auth/tool-auth.guard.js";
import { ToolAuthService } from "./tool-auth/tool-auth.service.js";
import { ToolCredentialsController } from "./tool-auth/tool-credentials.controller.js";
import { TaskExecutionConsoleController } from "./task-executions/task-execution-console.controller.js";
import { TaskExecutionController } from "./task-executions/task-execution.controller.js";
import { TaskExecutionService } from "./task-executions/task-execution.service.js";
import { TaskProfileResolverService } from "./task-executions/task-profile-resolver.service.js";
import { ProfileReservationService } from "./task-executions/profile-reservation.service.js";
import { TaskExecutionWorker } from "./task-executions/task-execution.worker.js";
import { PostRunAnalysisConsoleController } from "./post-run-analysis/post-run-analysis-console.controller.js";
import { PostRunAnalysisService } from "./post-run-analysis/post-run-analysis.service.js";
import { PostRunAnalysisWorker } from "./post-run-analysis/post-run-analysis.worker.js";
import { TaskLogBundleService } from "./post-run-analysis/task-log-bundle.service.js";
import { VerificationController } from "./verification/verification.controller.js";
import { VerificationService } from "./verification/verification.service.js";
import { BrowserExecutionRunner } from "./verification/browser-execution-runner.service.js";
import { BrowserAdmissionService } from "./verification/browser-admission.service.js";
import { BrowserAdmissionWorker } from "./verification/browser-admission.worker.js";
import { ExecutionRunnerController } from "./verification/verification.controller.js";
import { ExecutionRunnerRegistry } from "./verification/execution-runner-registry.service.js";
import { NotificationOutboxWorker } from "./verification/notification-outbox-worker.service.js";
import { VerificationConsoleController } from "./verification/verification-console.controller.js";
import { VerificationExecutionService } from "./verification/verification-execution.service.js";
import { VerificationLifecycleService } from "./verification/verification-lifecycle.service.js";
import { VerificationMcpController } from "./verification/mcp.controller.js";
import { VerificationMcpService } from "./verification/mcp.service.js";

@Module({
  controllers: [
    AgentRuntimeControlController,
    AgentRuntimeTaskController,
    SpecAnalysisRuntimeController,
    PostRunAnalysisRuntimeController,
    AuthController,
    UserBrowserProfilesController,
    ConsoleController,
    FeishuEventsController,
    ConsoleObservabilityController,
    ObservabilityController,
    PlaygroundController,
    RuntimeController,
    RuntimeRecoveryController,
    TestDataController,
    ToolCredentialsController,
    ExecutionRunnerController,
    ExecutionRunController,
    ExecutionRunConsoleController,
    RunBrowserPreviewController,
    RunHitlBrowserController,
    TaskExecutionController,
    TaskExecutionConsoleController,
    PostRunAnalysisConsoleController,
    TestSpecificationController,
    TestSpecificationConsoleController,
    VerificationController,
    VerificationConsoleController,
    VerificationMcpController,
  ],
  providers: [
    AgentRuntimeControlService,
    AgentModelConfigurationService,
    AgentRuntimeTaskService,
    SpecAnalysisRuntimeService,
    PostRunAnalysisRuntimeService,
    UnifiedBrowserExecutionService,
    AuditService,
    AuthGuard,
    AuthService,
    UserBrowserProfilesService,
    BrowserRuntimeService,
    BrowserProfileLifecycleWorker,
    BrowserAdmissionService,
    BrowserAdmissionWorker,
    BrowserExecutionRunner,
    ConsoleService,
    CredentialCipherService,
    ExecutionRunnerRegistry,
    ExecutionRunService,
    RunBrowserPreviewService,
    RunHitlBrowserService,
    GithubPullRequestClient,
    GithubAccessService,
    UnifiedRunCleanupWorker,
    FeishuOAuthClient,
    FeishuIntegrationService,
    IssueContextResolverService,
    KnowledgeContextClient,
    LinearContextClient,
    HealthService,
    MetricsService,
    NotificationOutboxWorker,
    ObjectStorageService,
    ObservabilityService,
    OperationalMetricsService,
    PlaygroundService,
    PrismaService,
    RedisService,
    RetentionWorker,
    RuntimeCommandDispatcher,
    RuntimeConnectionHub,
    RuntimeGatewayService,
    RuntimeHumanControlRelay,
    RuntimeLeaseSweeper,
    RuntimeRoutingService,
    RuntimeSessionsService,
    SessionRecoveryService,
    SessionClosureService,
    SessionRecoveryWorker,
    RuntimeDrainService,
    TaskExecutionService,
    TaskProfileResolverService,
    ProfileReservationService,
    TaskExecutionWorker,
    PostRunAnalysisService,
    PostRunAnalysisWorker,
    TaskLogBundleService,
    TestDataService,
    TestSpecificationService,
    ToolAuthGuard,
    ToolAuthService,
    ToolInvocationService,
    ToolInvocationSweeper,
    WorkerMonitorService,
    VerificationService,
    VerificationExecutionService,
    VerificationLifecycleService,
    VerificationMcpService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ToolInvocationInterceptor,
    },
  ],
})
export class AppModule {}
