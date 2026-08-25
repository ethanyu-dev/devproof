import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  agentModelConfigurationCreateInputSchema,
  agentModelConfigurationOrderInputSchema,
  agentModelConfigurationUpdateInputSchema,
  agentRuntimeProviderSchema,
  executionRunCreateInputSchema,
  githubAccessCredentialCreateInputSchema,
  githubAccessCredentialUpdateInputSchema,
  playgroundRunInputSchema,
  runInterventionResolveInputSchema,
  runtimeCommandInputSchema,
  runtimeConfigurationInputSchema,
  runtimeRoutingRuleInputSchema,
  runtimeSessionCreateInputSchema,
  runtimeSettingsInputSchema,
  taskDeploymentTargetInputSchema,
  taskExecutionCreateInputSchema,
  testGenerationContextSchema,
  testCaseDefinitionSchema,
  testEnvironmentInputSchema,
  testRunArtifactLinkInputSchema,
  toolCredentialCreateInputSchema,
  userBrowserProfileCreateInputSchema,
  verificationRequestSchema,
  verificationExecutionAcquireInputSchema,
  verificationCheckpointCreateInputSchema,
  verificationCheckpointResolveInputSchema,
  verificationEventAppendInputSchema,
  verificationResultSchema,
} from "./index.js";

describe("DevProof contracts", () => {
  it("uses a generic extension point for custom agent providers", () => {
    expect(agentRuntimeProviderSchema.parse("CUSTOM")).toBe("CUSTOM");
  });

  it("normalizes GitHub credential routing scopes and allows secret-free updates", () => {
    const created = githubAccessCredentialCreateInputSchema.parse({
      name: "Organization A",
      organizations: ["Organization-A", "organization-a"],
      personalAccessToken: "github_pat_abcdefghijklmnop",
      repositories: ["Organization-A/Core-API"],
    });
    expect(created).toMatchObject({
      enabled: true,
      organizations: ["organization-a"],
      priority: 100,
      repositories: ["organization-a/core-api"],
    });
    expect(
      githubAccessCredentialUpdateInputSchema.parse({
        enabled: false,
        name: "Organization A",
        organizations: ["organization-a"],
        priority: 50,
        repositories: [],
      }).personalAccessToken,
    ).toBeUndefined();
    expect(
      githubAccessCredentialCreateInputSchema.safeParse({
        name: "Invalid",
        organizations: ["organization with spaces"],
        personalAccessToken: "github_pat_abcdefghijklmnop",
      }).success,
    ).toBe(false);
  });

  it("validates encrypted Agent model list inputs", () => {
    expect(
      agentModelConfigurationCreateInputSchema.parse({
        apiKey: "sk-model-secret",
        baseUrl: "https://gateway.example.com/v1/",
        displayName: "Primary model",
        modelId: "provider/model-1",
      }),
    ).toEqual({
      apiKey: "sk-model-secret",
      baseUrl: "https://gateway.example.com/v1",
      displayName: "Primary model",
      modelId: "provider/model-1",
    });
    expect(
      agentModelConfigurationUpdateInputSchema.parse({
        baseUrl: "https://gateway.example.com/v1",
        displayName: "Primary model",
        modelId: "provider/model-1",
      }).apiKey,
    ).toBeUndefined();
    expect(
      agentModelConfigurationOrderInputSchema.safeParse({
        ids: [
          "d63bd843-b89d-48ea-90c9-caad5b51d526",
          "d63bd843-b89d-48ea-90c9-caad5b51d526",
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts an HTTP target for a Playground run", () => {
    expect(
      playgroundRunInputSchema.parse({
        acceptanceCriterion: "The title is Example Domain.",
        goal: "Open the page and capture evidence.",
        submissionId: "d63bd843-b89d-48ea-90c9-caad5b51d526",
        targetUrl: "https://example.com",
      }).hitlEnabled,
    ).toBe(false);
    expect(
      playgroundRunInputSchema.safeParse({
        acceptanceCriterion: "Read a local file.",
        goal: "Open a file URL.",
        submissionId: "d63bd843-b89d-48ea-90c9-caad5b51d526",
        targetUrl: "file:///etc/passwd",
      }).success,
    ).toBe(false);
    expect(
      playgroundRunInputSchema.safeParse({
        acceptanceCriterion: "The title is Example Domain.",
        goal: "Open the page and capture evidence.",
        targetUrl: "https://example.com",
      }).success,
    ).toBe(false);
  });

  it("defaults Run v2 HITL policy and rejects credential responses", () => {
    const run = executionRunCreateInputSchema.parse({
      criteria: [{ description: "The page loads.", id: "loads" }],
      goal: "Verify the page.",
      idempotencyKey: "run-v2-hitl-default",
    });
    expect(run.hitlPolicy).toMatchObject({
      enabled: true,
      onTimeout: "INCONCLUSIVE",
      timeoutSeconds: 3600,
    });
    expect(run.deadlinePolicy).toEqual({ mode: "FIXED" });
    expect(run.businessReferences).toEqual([]);
    expect(
      runInterventionResolveInputSchema.safeParse({
        response: { password: "do-not-store" },
      }).success,
    ).toBe(false);
  });

  it("accepts typed business references for Run v2", () => {
    const run = executionRunCreateInputSchema.parse({
      businessReferences: [
        {
          externalId: "reference://spec/spec-1/issue",
          kind: "BUSINESS_REFERENCE",
          label: "ENG-1",
          metadata: {
            source: "LINEAR",
            title: "Issue title",
            url: "https://linear.app/acme/issue/ENG-1",
          },
        },
      ],
      criteria: [
        {
          description: "The requirement is implemented.",
          id: "expected-1",
          requiredEvidenceKinds: ["BUSINESS_REFERENCE"],
        },
      ],
      goal: "Verify ENG-1.",
      idempotencyKey: "spec-case:spec-1",
    });

    expect(run.businessReferences[0]?.kind).toBe("BUSINESS_REFERENCE");
    expect(run.criteria[0]?.requiredEvidenceKinds).toEqual([
      "BUSINESS_REFERENCE",
    ]);
    expect(
      executionRunCreateInputSchema.safeParse({
        businessReferences: [
          {
            externalId: "reference://spec/spec-1/issue",
            kind: "BUSINESS_REFERENCE",
            metadata: { accessToken: "do-not-store" },
          },
        ],
        criteria: [{ description: "The page loads.", id: "loads" }],
        goal: "Verify the page.",
        idempotencyKey: "unsafe-business-reference",
      }).success,
    ).toBe(false);
  });

  it("canonicalizes order-insensitive specification context", () => {
    const context = testGenerationContextSchema.parse({
      issue: {
        description: "Verify the release.",
        id: "issue-1",
        identifier: "ENG-1",
        labels: ["frontend", "critical", "frontend"],
        title: "Release",
        url: "https://linear.app/acme/issue/ENG-1",
      },
      pullRequests: [
        {
          changedFiles: ["z.ts", "a.ts", "z.ts"],
          id: "pr-1",
          isPrimary: true,
          number: 1,
          organization: "acme",
          repository: "acme/web",
          title: "Release",
          url: "https://github.com/acme/web/pull/1",
        },
      ],
    });

    expect(context.issue.labels).toEqual(["critical", "frontend"]);
    expect(context.pullRequests[0]?.changedFiles).toEqual(["a.ts", "z.ts"]);
  });

  it("accepts an asynchronous Issue task with execution defaults", () => {
    const task = taskExecutionCreateInputSchema.parse({
      idempotencyKey: "issue-task:ENG-1:1",
      issueRef: "ENG-1",
      kind: "ISSUE_SPEC",
    });
    expect(task).toMatchObject({
      analysisMaxAttempts: 3,
      deadlineSeconds: 7_200,
      kind: "ISSUE_SPEC",
      retryPolicy: { maxAttempts: 3 },
      runDeadlinePolicy: {
        extensionStepSeconds: 180,
        maxExtensionSeconds: 900,
        mode: "ADAPTIVE",
        slowModelThresholdSeconds: 60,
      },
    });
  });

  it("accepts a direct task wrapper and validates deployment targets", () => {
    expect(
      taskExecutionCreateInputSchema.safeParse({
        idempotencyKey: "direct-task:example:1",
        kind: "DIRECT_RUN",
        run: {
          criteria: [{ description: "The page loads.", id: "loads" }],
          goal: "Verify the page.",
          idempotencyKey: "direct-run:example:1",
        },
      }).success,
    ).toBe(true);
    expect(
      taskDeploymentTargetInputSchema.safeParse({ url: "file:///etc/passwd" })
        .success,
    ).toBe(false);
  });

  it("keeps runtime settings independent from browser selection", () => {
    const result = runtimeSettingsInputSchema.safeParse({
      hitlEnabled: true,
    });

    expect(result.success).toBe(true);
  });

  it("validates console-managed Runtime capacity", () => {
    expect(
      runtimeConfigurationInputSchema.parse({
        maxConcurrency: "4",
        networkAllowlist: ["*.corp.example"],
      }).maxConcurrency,
    ).toBe(4);
    expect(
      runtimeConfigurationInputSchema.safeParse({
        maxConcurrency: 0,
        networkAllowlist: [],
      }).success,
    ).toBe(false);
    expect(
      runtimeConfigurationInputSchema.safeParse({
        maxConcurrency: 33,
        networkAllowlist: [],
      }).success,
    ).toBe(false);
  });

  it("requires a safe key for persistent browser profiles", () => {
    expect(
      runtimeSessionCreateInputSchema.safeParse({
        profileMode: "PERSISTENT",
        runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
      }).success,
    ).toBe(false);
    expect(
      runtimeSessionCreateInputSchema.safeParse({
        profileKey: "../company-session",
        profileMode: "PERSISTENT",
        runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
      }).success,
    ).toBe(false);
  });

  it("makes the verification profile immutable and validates acquisition overrides", () => {
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Dashboard loads", id: "loads" }],
      execution: {
        profile: { key: "fp-issue-cycle", mode: "PERSISTENT" },
        requiredCapabilities: ["browser"],
      },
      goal: "Verify the dashboard",
      idempotencyKey: "profile-request",
    });

    expect(request.execution.profile).toEqual({
      key: "fp-issue-cycle",
      mode: "PERSISTENT",
    });
    expect(
      verificationRequestSchema.safeParse({
        acceptanceCriteria: [{ description: "Dashboard loads", id: "loads" }],
        execution: {
          profile: { mode: "PERSISTENT" },
          requiredCapabilities: ["browser"],
        },
        goal: "Verify the dashboard",
        idempotencyKey: "missing-profile-key",
      }).success,
    ).toBe(false);
    expect(
      verificationExecutionAcquireInputSchema.safeParse({
        profileMode: "PERSISTENT",
      }).success,
    ).toBe(false);
  });

  it("exposes only strict agent browser commands", () => {
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "session.close",
        payload: {},
      }).success,
    ).toBe(false);
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "page.fill",
        payload: { target: { ref: "e8" }, text: "hello" },
      }).success,
    ).toBe(true);
    expect(
      runtimeCommandInputSchema.safeParse({
        commandType: "page.fill",
        payload: { javascript: "alert(1)", selector: "input" },
      }).success,
    ).toBe(false);

    const publicSchema = JSON.stringify(
      z.toJSONSchema(runtimeCommandInputSchema),
    );
    expect(publicSchema).toContain("page.navigate");
    expect(publicSchema).not.toContain("session.open");
    expect(publicSchema).not.toContain("session.close");
    expect(publicSchema).not.toContain("human.takeover");
    expect(publicSchema).not.toContain("human.release");
  });

  it("normalizes Runtime hostname routing patterns", () => {
    expect(
      runtimeRoutingRuleInputSchema.parse({
        hostnamePattern: "*.Staging.Example.com",
        runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
      }).hostnamePattern,
    ).toBe("*.staging.example.com");
    expect(
      runtimeRoutingRuleInputSchema.safeParse({
        hostnamePattern: "app.*.example.com",
        runtimeId: "6f090d88-8987-487f-8338-1a734beab6a6",
      }).success,
    ).toBe(false);
  });

  it("accepts the fixed case definition DSL", () => {
    const definition = testCaseDefinitionSchema.parse({
      profile: { key: "team-login", mode: "PERSISTENT" },
      schemaVersion: 1,
      steps: [
        { id: "open", type: "browser.navigate", url: "/login" },
        {
          id: "password",
          selector: "[name=password]",
          type: "browser.type",
          value: { key: "LOGIN_PASSWORD", kind: "ENV_SECRET" },
        },
        {
          expected: "/dashboard",
          id: "verify",
          operator: "CONTAINS",
          type: "assert.url",
        },
      ],
    });

    expect(definition.steps).toHaveLength(3);
    expect(definition.timeoutSeconds).toBe(900);
  });

  it("rejects duplicate step ids and incomplete persistent profiles", () => {
    expect(
      testCaseDefinitionSchema.safeParse({
        profile: { mode: "PERSISTENT" },
        schemaVersion: 1,
        steps: [
          { id: "same", type: "browser.navigate", url: "/" },
          { id: "same", selector: "button", type: "browser.click" },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps environment secrets separate from public variables", () => {
    const environment = testEnvironmentInputSchema.parse({
      baseUrl: "https://staging.example.com",
      enabled: true,
      name: "Staging",
      secrets: { PASSWORD: "secret" },
      slug: "staging",
      variables: { locale: "zh-CN", retries: 2 },
    });

    expect(environment.secrets).toEqual({ PASSWORD: "secret" });
    expect(environment.variables).toEqual({ locale: "zh-CN", retries: 2 });
  });

  it("requires an artifact to reference durable storage", () => {
    expect(
      testRunArtifactLinkInputSchema.safeParse({ kind: "SCREENSHOT" }).success,
    ).toBe(false);
  });

  it("accepts an agent-neutral verification request", () => {
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [
        { description: "The release page loads.", id: "page-loads" },
      ],
      agentRuntime: { externalRunId: "codex-run-42", provider: "CODEX" },
      execution: { requiredCapabilities: ["browser", "browser"] },
      goal: "Verify the release candidate.",
      idempotencyKey: "release-42",
    });

    expect(request.agentRuntime.provider).toBe("CODEX");
    expect(request.execution).toMatchObject({
      acquireTimeoutSeconds: 300,
      availabilityPolicy: "WAIT",
      runTimeoutSeconds: 1800,
    });
    expect(request.execution.requiredCapabilities).toEqual(["browser"]);
    expect(request.hitlPolicy.notificationChannels).toEqual(["FEISHU"]);
  });

  it("drops legacy task-level origin allowlists", () => {
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Page loads", id: "page-loads" }],
      execution: {
        allowedOrigins: ["https://login.example.com"],
        requiredCapabilities: ["browser"],
      },
      goal: "Verify the release candidate.",
      idempotencyKey: "legacy-origin-policy",
    });

    expect(request.execution).not.toHaveProperty("allowedOrigins");
  });

  it("normalizes unsafe execution timeouts without rejecting legacy callers", () => {
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Page loads", id: "loads" }],
      execution: {
        acquireTimeoutSeconds: 30,
        requiredCapabilities: ["browser"],
        runTimeoutSeconds: 30,
      },
      goal: "Verify the page.",
      idempotencyKey: "safe-timeout-floor",
    });

    expect(request.execution).toMatchObject({
      acquireTimeoutSeconds: 120,
      runTimeoutSeconds: 120,
    });
  });

  it("preserves an explicitly configured run timeout", () => {
    const request = verificationRequestSchema.parse({
      acceptanceCriteria: [{ description: "Page loads", id: "loads" }],
      execution: {
        requiredCapabilities: ["browser"],
        runTimeoutSeconds: 900,
      },
      goal: "Verify the page.",
      idempotencyKey: "extended-run-timeout",
    });

    expect(request.execution.runTimeoutSeconds).toBe(900);
  });

  it("rejects an Agent-selected Runtime", () => {
    expect(
      verificationRequestSchema.safeParse({
        acceptanceCriteria: [{ description: "Page loads", id: "loads" }],
        execution: {
          requiredCapabilities: ["browser"],
          runnerId: "6f090d88-8987-487f-8338-1a734beab6a6",
        },
        goal: "Verify the page.",
        idempotencyKey: "agent-selected-runtime",
      }).success,
    ).toBe(false);
  });

  it("rejects ambiguous execution and duplicate acceptance criteria", () => {
    expect(
      verificationRequestSchema.safeParse({
        acceptanceCriteria: [
          { description: "First", id: "same" },
          { description: "Second", id: "same" },
        ],
        goal: "Verify a target.",
        idempotencyKey: "duplicate-criteria",
      }).success,
    ).toBe(false);
  });

  it("requires secret references instead of inline verification credentials", () => {
    expect(
      verificationRequestSchema.safeParse({
        acceptanceCriteria: [{ description: "Login succeeds", id: "login" }],
        execution: { requiredCapabilities: ["browser"] },
        goal: "Verify login.",
        idempotencyKey: "login-with-inline-secret",
        inputs: { account: { password: "do-not-store" } },
      }).success,
    ).toBe(false);
    expect(
      verificationRequestSchema.parse({
        acceptanceCriteria: [{ description: "Login succeeds", id: "login" }],
        execution: { requiredCapabilities: ["browser"] },
        goal: "Verify login.",
        idempotencyKey: "login-with-secret-ref",
        secretRefs: { LOGIN_PASSWORD: "environment://staging/LOGIN_PASSWORD" },
      }).secretRefs.LOGIN_PASSWORD,
    ).toBe("environment://staging/LOGIN_PASSWORD");
  });

  it("defaults and normalizes tool credential scopes for the Task control plane", () => {
    expect(
      toolCredentialCreateInputSchema.parse({ name: "Codex production" })
        .scopes,
    ).toEqual(["run:read", "run:write", "run:cancel"]);
    expect(
      toolCredentialCreateInputSchema.parse({
        name: "Codex production",
        scopes: ["run:read", "run:read"],
      }).scopes,
    ).toEqual(["run:read"]);
    expect(
      toolCredentialCreateInputSchema.safeParse({
        name: "Untrusted Runtime",
        scopes: ["runtime:lease"],
      }).success,
    ).toBe(false);
  });

  it("requires deterministic and credential-free user Profile verification", () => {
    const base = {
      displayName: "My staging account",
      grants: ["CONSOLE"],
      verificationUrl: "https://app.example.com/account",
    };
    expect(
      userBrowserProfileCreateInputSchema.safeParse({
        ...base,
        verificationRules: { loginUrlPatterns: ["*/login*"] },
      }).success,
    ).toBe(false);
    expect(
      userBrowserProfileCreateInputSchema.safeParse({
        ...base,
        verificationRules: {
          loginUrlPatterns: ["*/login*"],
          successUrlPatterns: ["*/account*"],
        },
      }).success,
    ).toBe(true);
    expect(
      userBrowserProfileCreateInputSchema.safeParse({
        ...base,
        verificationRules: { authenticatedSelector: "[data-user-menu]" },
        verificationUrl: "https://user:password@app.example.com/account",
      }).success,
    ).toBe(false);
  });

  it("validates verification results and HITL checkpoints", () => {
    expect(
      verificationResultSchema.parse({
        criteria: [
          {
            criterionId: "page-loads",
            evidenceRefs: ["artifact://11111111-1111-4111-8111-111111111111"],
            status: "PASSED",
            summary: "The page loaded.",
          },
        ],
        summary: "All required checks passed.",
        verdict: "PASSED",
      }).evidenceRefs,
    ).toEqual([]);
    expect(
      verificationCheckpointCreateInputSchema.safeParse({ prompt: "Approve?" })
        .success,
    ).toBe(true);
  });

  it("requires canonical verification artifact references", () => {
    expect(
      verificationResultSchema.safeParse({
        criteria: [
          {
            criterionId: "page-loads",
            evidenceRefs: ["artifact://screenshot-1"],
            status: "PASSED",
            summary: "The page loaded.",
          },
        ],
        summary: "The page loaded.",
        verdict: "PASSED",
      }).success,
    ).toBe(false);
  });

  it("rejects credentials in events and HITL payloads", () => {
    expect(
      verificationEventAppendInputSchema.safeParse({
        kind: "agent.progress",
        payload: { token: "do-not-store" },
      }).success,
    ).toBe(false);
    expect(
      verificationCheckpointCreateInputSchema.safeParse({
        context: { password: "do-not-store" },
        prompt: "Please continue.",
      }).success,
    ).toBe(false);
    expect(
      verificationCheckpointResolveInputSchema.safeParse({
        response: { apiKey: "do-not-store" },
      }).success,
    ).toBe(false);
  });
});
