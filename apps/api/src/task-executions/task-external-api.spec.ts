import { describe, expect, it, vi } from "vitest";
import {
  taskExecutionCreateInputSchema,
  taskListQuerySchema,
  taskWebhookCreateInputSchema,
} from "@devproof/contracts";
import { TaskExecutionController } from "./task-execution.controller.js";
import { TaskExecutionService } from "./task-execution.service.js";
import { taskApiContract } from "./task-api-contract.js";
import { ToolAuthService } from "../tool-auth/tool-auth.service.js";
const current = {
  credential: { id: "token", scopes: ["run:read", "run:write"] },
  team: { id: "team" },
} as never;

describe("external task contracts", () => {
  it("accepts local HTTP callbacks in the public input contract", () => {
    expect(
      taskWebhookCreateInputSchema.parse({
        url: "http://127.0.0.1:8090/events",
      }).url,
    ).toBe("http://127.0.0.1:8090/events");
    expect(
      taskWebhookCreateInputSchema.safeParse({ url: "file:///tmp/events" })
        .success,
    ).toBe(false);
  });
  it("preserves the legacy list and validates paginated filters", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const listPage = vi.fn().mockResolvedValue({ items: [] });
    const controller = new TaskExecutionController({ list, listPage } as never);
    await controller.list(current);
    expect(list).toHaveBeenCalledWith(current);
    await controller.list(current, {
      page: "2",
      pageSize: "10",
      source: "ci",
      externalId: "build-3",
      createdAfter: "2026-09-20T00:00:00Z",
    });
    expect(listPage).toHaveBeenCalledWith(current, 2, 10, {
      source: "ci",
      externalId: "build-3",
      createdAfter: new Date("2026-09-20T00:00:00Z"),
    });
    expect(() => controller.list(current, { pageSize: "100000" })).toThrow();
    expect(() => controller.list(current, { page: "1.5" })).toThrow();
    expect(() =>
      controller.list(current, { status: "NOT_A_STATUS" }),
    ).toThrow();
    expect(() =>
      controller.list({ ...current, credential: { scopes: [] } } as never, {}),
    ).toThrow();
  });
  it("keeps source association independent from the issue and rejects incomplete references", () => {
    const input = taskExecutionCreateInputSchema.parse({
      kind: "SPEC_TASK",
      goal: "Check homepage",
      idempotencyKey: "ci-build-123",
      externalReference: { source: "ci", externalId: "build-123" },
    });
    expect(input.externalReference).toEqual({
      source: "ci",
      externalId: "build-123",
    });
    expect(
      taskExecutionCreateInputSchema.safeParse({
        ...input,
        externalReference: { source: "ci" },
      }).success,
    ).toBe(false);
    expect(taskListQuerySchema.safeParse({ unknown: "ignored?" }).success).toBe(
      false,
    );
  });
  it("generates a serializable OpenAPI contract from real validators", () => {
    const contract = JSON.parse(JSON.stringify(taskApiContract()));
    expect(contract.openapi).toBe("3.1.0");
    expect(
      contract.paths["/v2/tasks"].post.requestBody.content["application/json"]
        .schema,
    ).toHaveProperty("oneOf");
    expect(
      contract.paths["/v2/tasks"].get.parameters.map(
        (item: { name: string }) => item.name,
      ),
    ).toContain("externalId");
    expect(contract.paths["/v2/tasks/{taskId}/webhooks"].post).toHaveProperty(
      "security",
    );
  });
  it("requires profile ownership to grant a token access", async () => {
    const tx = {
      userBrowserProfile: { findFirst: vi.fn().mockResolvedValue(null) },
      toolCredential: { findFirst: vi.fn().mockResolvedValue({ id: "token" }) },
      toolProfileGrant: { upsert: vi.fn() },
    };
    const prisma = {
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    };
    const service = new ToolAuthService(prisma as never, {} as never);
    await expect(
      service.setProfileGrant(
        { team: { id: "team" }, user: { id: "owner" } } as never,
        "token",
        "profile",
        true,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(tx.userBrowserProfile.findFirst).toHaveBeenCalledWith({
      where: { id: "profile", teamId: "team", ownerUserId: "owner" },
      select: { id: true },
    });
    expect(tx.toolProfileGrant.upsert).not.toHaveBeenCalled();
  });
  it("creates an explicitly authorized machine task without impersonating the owner", async () => {
    const create = vi.fn();
    const tx = {
      taskExecution: { create },
      taskExecutionStage: { createMany: vi.fn() },
      taskStageAttempt: { create: vi.fn() },
      taskProfileBinding: { create: vi.fn() },
      taskExecutionEvent: { create: vi.fn() },
    };
    const prisma = {
      taskExecution: { findUnique: vi.fn().mockResolvedValue(null) },
      toolProfileGrant: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ profile: { ownerUserId: "owner" } }),
      },
      userBrowserProfile: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "aa57d9c6-0603-4097-92f4-e5746ec01077" }),
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    };
    const service = new TaskExecutionService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(service, "detail").mockResolvedValue({ id: "task" } as never);
    await service.create(current, {
      kind: "SPEC_TASK",
      goal: "Check home",
      idempotencyKey: "authorized-token-task",
      externalReference: { source: "ci", externalId: "123" },
      profilePolicy: {
        strategy: "EXPLICIT_PROFILE",
        profileId: "aa57d9c6-0603-4097-92f4-e5746ec01077",
      },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestedByKind: "CREDENTIAL",
        requestedByUserId: null,
        externalSource: "ci",
        externalId: "123",
      }),
    });
    expect(prisma.toolProfileGrant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          credentialId: "token",
          profile: { teamId: "team" },
          credential: expect.objectContaining({
            teamId: "team",
            revokedAt: null,
          }),
        }),
      }),
    );
  });
});
