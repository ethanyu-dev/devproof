import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { ToolAuthContext } from "../tool-auth/tool-auth.types.js";
import { VerificationMcpService } from "./mcp.service.js";

const current: ToolAuthContext = {
  credential: {
    id: "credential-1",
    name: "Playground",
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
    const service = new VerificationMcpService(
      invocations as never,
      {} as never,
      { create: createTask } as never,
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
        "set_task_deployment_target",
        "retry_task_stage",
        "cancel_task",
        "get_run",
        "resolve_run_intervention",
        "read_run_evidence",
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
      expect(createTask).toHaveBeenCalledWith(
        current,
        expect.objectContaining({
          analysisMaxAttempts: 3,
          issueRef: "ENG-123",
          kind: "ISSUE_SPEC",
        }),
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
          "read_run_evidence",
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
