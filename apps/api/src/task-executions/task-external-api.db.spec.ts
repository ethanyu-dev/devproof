import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { TaskExecutionService } from "./task-execution.service.js";
import { TaskWebhookService } from "./task-webhook.service.js";
import { ToolAuthService } from "../tool-auth/tool-auth.service.js";
const url = process.env.DEVPROOF_EXTERNAL_API_TEST_DATABASE_URL;
if (
  url &&
  !/^\/devproof_external_api_test_[a-f0-9]{8}$/u.test(new URL(url).pathname)
)
  throw new Error("External API tests require a disposable database.");
vi.mock("../config/env.js", () => ({
  env: () => ({
    TASK_WEBHOOK_ALLOWED_ORIGINS: "https://hooks.example.com",
    BACKGROUND_WORKERS_ENABLED: false,
  }),
}));

describe.skipIf(!url)("external task database integration", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: url! }),
    });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  afterEach(() => vi.unstubAllGlobals());
  async function harness() {
    const suffix = randomUUID();
    const team = await db.team.create({
      data: { name: "Integration", slug: suffix, feishuTenantKey: suffix },
    });
    const user = await db.user.create({ data: { name: "Owner" } });
    const token = await db.toolCredential.create({
      data: {
        teamId: team.id,
        createdByUserId: user.id,
        name: "Client",
        tokenHash: suffix,
        tokenHint: "test",
        scopes: ["run:read", "run:write"],
      },
    });
    const current = {
      team,
      credential: {
        id: token.id,
        name: token.name,
        scopes: ["run:read", "run:write"],
      },
    } as never;
    const tasks = new TaskExecutionService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const cipher = {
      encrypt: (value: string) => `encrypted:${value}`,
      decrypt: (value: string) => value.slice(10),
    };
    const hooks = new TaskWebhookService(db as never, cipher as never);
    return { team, user, token, current, tasks, hooks };
  }
  it("persists associations, isolates teams, and enforces owner grants for new tasks", async () => {
    const { team, user, token, current, tasks } = await harness();
    const profile = await db.userBrowserProfile.create({
      data: {
        teamId: team.id,
        ownerUserId: user.id,
        displayName: "Test login",
        runtimeProfileKey: randomUUID(),
        scopeKey: randomUUID(),
        verificationUrl: "https://example.com",
      },
    });
    const input = {
      kind: "SPEC_TASK",
      goal: "Check homepage",
      idempotencyKey: "external-create-1",
      externalReference: { source: "ci", externalId: "build-123" },
      profilePolicy: { strategy: "EXPLICIT_PROFILE", profileId: profile.id },
    };
    await expect(tasks.create(current, input)).rejects.toMatchObject({
      status: 403,
    });
    const auth = new ToolAuthService(db as never, { record: vi.fn() } as never);
    await auth.setProfileGrant(
      { team, user } as never,
      token.id,
      profile.id,
      true,
    );
    const task = await tasks.create(current, input);
    expect(await tasks.authorizedProfiles(current)).toEqual([
      expect.objectContaining({ id: profile.id, siteHostname: "example.com" }),
    ]);
    expect(task.externalReference).toEqual(input.externalReference);
    expect((await tasks.create(current, input)).id).toBe(task.id);
    const row = await db.taskExecution.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.requestedByKind).toBe("CREDENTIAL");
    expect(row.requestedByUserId).toBeNull();
    expect(
      (
        await tasks.listPage(current, 1, 1, {
          source: "ci",
          externalId: "build-123",
        })
      ).total,
    ).toBe(1);
    const other = await harness();
    expect(
      (await other.tasks.listPage(other.current, 1, 20, { source: "ci" }))
        .total,
    ).toBe(0);
    await expect(
      other.hooks.create(other.current, task.id, {
        url: "https://hooks.example.com/callback",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await auth.setProfileGrant(
      { team, user } as never,
      token.id,
      profile.id,
      false,
    );
    await expect(
      tasks.create(current, { ...input, idempotencyKey: "external-create-2" }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await tasks.detail(current, task.id)).id).toBe(task.id);
  });
  it("replays existing events once per subscription and fences competing workers", async () => {
    const { team, current, tasks, hooks } = await harness();
    const task = await tasks.create(current, {
      kind: "SPEC_TASK",
      goal: "Check home",
      idempotencyKey: "webhook-test",
    });
    const event = await db.taskExecutionEvent.create({
      data: {
        taskExecutionId: task.id,
        teamId: team.id,
        actor: "SYSTEM",
        kind: "task.completed",
        payload: { privateInput: "not forwarded" },
      },
    });
    const body = { url: "https://hooks.example.com/callback" };
    const subscription = await hooks.create(current, task.id, body);
    expect((await hooks.create(current, task.id, body)).signingSecret).toBe(
      subscription.signingSecret,
    );
    expect(JSON.stringify(await hooks.list(current, task.id))).not.toContain(
      subscription.signingSecret,
    );
    const send = vi.fn().mockResolvedValue({ ok: true, body: null });
    vi.stubGlobal("fetch", send);
    const otherWorker = new TaskWebhookService(
      db as never,
      { decrypt: (value: string) => value.slice(10) } as never,
    );
    await Promise.all([hooks.poll(), otherWorker.poll()]);
    await hooks.poll();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].body).not.toContain("not forwarded");
    const deliveries = await db.taskWebhookDelivery.findMany({
      where: { webhookId: subscription.id, eventId: event.id },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe("DELIVERED");
    const later = await db.taskExecutionEvent.create({
      data: {
        taskExecutionId: task.id,
        teamId: team.id,
        actor: "SYSTEM",
        kind: "task.stage.failed",
      },
    });
    expect(later.id).toBeTruthy();
    await hooks.disable(current, task.id, subscription.id);
    await hooks.poll();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
