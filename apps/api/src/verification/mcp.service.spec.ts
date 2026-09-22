import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { VerificationMcpService } from "./mcp.service.js";

const current: ToolAuthContext = {
  credential: {
    id: "credential-1",
    name: "Task integration",
    scopes: ["run:read", "run:write", "run:cancel"],
  },
  team: { id: "team-1", name: "DevProof", slug: "devproof" },
};

describe("VerificationMcpService", () => {
  it("publishes only the unified Task and Run tools", async () => {
    const invocations = {
      run: vi.fn(async (_input: unknown, operation: () => Promise<unknown>) =>
        operation(),
      ),
    };
    const createTask = vi.fn(async () => ({
      id: "72b2525c-b0d7-4451-82fc-ee210541016d",
      lifecycle: "QUEUED",
    }));
    const provideAnalysisInput = vi.fn(async () => ({
      id: "72b2525c-b0d7-4451-82fc-ee210541016d",
      lifecycle: "QUEUED",
    }));
    const listPage = vi.fn().mockResolvedValue({
      items: [],
      page: 2,
      pageSize: 10,
      total: 0,
      totalPages: 1,
    });
    const events = vi.fn().mockResolvedValue([]);
    const rerunCase = vi.fn().mockResolvedValue({
      id: "72b2525c-b0d7-4451-82fc-ee210541016d",
      lifecycle: "QUEUED",
    });
    const service = new VerificationMcpService(
      invocations as never,
      {} as never,
      {
        create: createTask,
        provideAnalysisInput,
        listPage,
        events,
        rerunCase,
      } as never,
    );
    const createServer = Reflect.get(service, "createServer") as (
      current: ToolAuthContext,
      client: { name?: string; version?: string },
    ) => McpServer;
    const server = createServer.call(service, current, {
      name: "mcp-command-guide-test",
      version: "1.0.0",
    });
    const client = new Client(
      { name: "mcp-command-guide-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const toolNames = tools.tools.map(({ name }) => name);
      expect(toolNames).toEqual([
        "get_integration_status",
        "create_task",
        "list_tasks",
        "get_task",
        "provide_task_analysis_input",
        "set_task_deployment_target",
        "retry_task_stage",
        "cancel_task",
        "get_run",
        "resolve_run_intervention",
        "read_run_evidence",
        "list_task_events",
        "get_task_acceptance_report",
        "set_task_deployments",
        "provide_task_test_accounts",
        "rerun_task",
        "rerun_task_case",
        "rerun_task_cases",
        "rerun_task_cases_as_task",
        "rerun_task_acceptance_review",
        "list_authorized_profiles",
      ]);

      const task = await client.callTool({
        arguments: {
          request: {
            idempotencyKey: "mcp-task-test",
            issueRef: "ENG-123",
            kind: "ISSUE_SPEC",
          },
        },
        name: "create_task",
      });
      expect(task.structuredContent).toMatchObject({ lifecycle: "QUEUED" });
      expect(
        tools.tools.find(({ name }) => name === "create_task")?.outputSchema,
      ).toHaveProperty("properties.id");
      const paged = await client.callTool({
        name: "list_tasks",
        arguments: {
          query: { page: 2, pageSize: 10, source: "ci", externalId: "build-1" },
        },
      });
      expect(paged.isError).not.toBe(true);
      expect(listPage).toHaveBeenCalledWith(current, 2, 10, {
        source: "ci",
        externalId: "build-1",
      });
      await client.callTool({
        name: "list_task_events",
        arguments: {
          taskId: "72b2525c-b0d7-4451-82fc-ee210541016d",
          after: "9007199254740993",
        },
      });
      expect(events).toHaveBeenCalledWith(
        current,
        "72b2525c-b0d7-4451-82fc-ee210541016d",
        9007199254740993n,
      );
      await client.callTool({
        name: "rerun_task_case",
        arguments: {
          taskId: "72b2525c-b0d7-4451-82fc-ee210541016d",
          caseId: "285146a8-5230-4b02-832a-5eef19e8dc8a",
          idempotencyKey: "case-retry-key",
        },
      });
      expect(rerunCase).toHaveBeenCalledWith(
        current,
        "72b2525c-b0d7-4451-82fc-ee210541016d",
        "285146a8-5230-4b02-832a-5eef19e8dc8a",
        undefined,
        { idempotencyKey: "case-retry-key" },
      );

      expect(createTask).toHaveBeenCalledWith(
        current,
        expect.objectContaining({
          analysisMaxAttempts: 3,
          issueRef: "ENG-123",
          kind: "ISSUE_SPEC",
        }),
      );

      const taskId = "72b2525c-b0d7-4451-82fc-ee210541016d";
      const analysisInput = {
        expectedAttemptId: "11111111-1111-4111-8111-111111111111",
        pullRequestUrls: ["https://github.com/acme/web/pull/42"],
      };
      const resumed = await client.callTool({
        name: "provide_task_analysis_input",
        arguments: { taskId, ...analysisInput },
      });
      expect(resumed.structuredContent).toMatchObject({ lifecycle: "QUEUED" });
      expect(provideAnalysisInput).toHaveBeenCalledWith(
        current,
        taskId,
        expect.objectContaining(analysisInput),
      );

      const resources = await client.listResources();
      expect(resources.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mimeType: "application/json",
            name: "devproof-task-tool-guide",
            uri: "devproof://task-tools",
          }),
        ]),
      );
      const resource = await client.readResource({
        uri: "devproof://task-tools",
      });
      expect(resource.contents[0]).toMatchObject({
        mimeType: "application/json",
        uri: "devproof://task-tools",
      });
      expect(JSON.parse(resource.contents[0]?.text ?? "{}")).toMatchObject({
        controlPlane: "Task Execution",
        preferredTools: expect.arrayContaining([
          "create_task",
          "provide_task_analysis_input",
          "read_run_evidence",
          "list_task_events",
          "get_task_acceptance_report",
          "set_task_deployments",
          "provide_task_test_accounts",
          "rerun_task",
          "rerun_task_case",
          "list_authorized_profiles",
        ]),
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("filters discovered tools and resources by credential scope", async () => {
    const invocations = {
      run: vi.fn(async (_input: unknown, operation: () => Promise<unknown>) =>
        operation(),
      ),
    };
    const service = new VerificationMcpService(invocations as never);
    const createServer = Reflect.get(service, "createServer") as (
      current: ToolAuthContext,
      client: { name?: string; version?: string },
    ) => McpServer;
    const server = createServer.call(
      service,
      {
        ...current,
        credential: { ...current.credential, scopes: ["run:read"] },
      },
      { name: "mcp-read-only-test", version: "1.0.0" },
    );
    const client = new Client(
      { name: "mcp-read-only-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual([
        "get_integration_status",
        "list_tasks",
        "get_task",
        "get_run",
        "read_run_evidence",
        "list_task_events",
        "get_task_acceptance_report",
        "list_authorized_profiles",
      ]);
      const resources = await client.listResources();
      expect(resources.resources.map(({ uri }) => uri)).toEqual([
        "devproof://task-tools",
      ]);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
