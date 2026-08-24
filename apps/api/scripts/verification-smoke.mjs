import assert from "node:assert/strict";

import { verificationRequestSchema } from "@devproof/contracts";

import { AuditService } from "../dist/console/audit.service.js";
import { PrismaService } from "../dist/database/prisma.service.js";
import { ToolAuthService } from "../dist/tool-auth/tool-auth.service.js";
import { VerificationService } from "../dist/verification/verification.service.js";
import { VerificationLifecycleService } from "../dist/verification/verification-lifecycle.service.js";
import { HitlCoordinator } from "../dist/verification/hitl-coordinator.service.js";
import { ObjectStorageService } from "../dist/infrastructure/object-storage.service.js";

const prisma = new PrismaService();
await prisma.$connect();

try {
  const team = await prisma.team.create({
    data: {
      feishuTenantKey: "verification-smoke-tenant",
      name: "Verification Smoke Team",
      slug: "verification-smoke-team",
    },
  });
  const user = await prisma.user.create({
    data: { email: "verification-smoke@devproof.local", name: "Smoke User" },
  });
  await prisma.teamMembership.create({
    data: { role: "ADMIN", teamId: team.id, userId: user.id },
  });
  const current = {
    sessionId: "verification-smoke-session",
    team: { id: team.id, name: team.name, slug: team.slug },
    user: {
      avatarUrl: null,
      email: user.email,
      id: user.id,
      name: user.name,
    },
  };

  const toolAuth = new ToolAuthService(prisma, new AuditService(prisma));
  const issued = await toolAuth.create(current, {
    expiresAt: null,
    name: "Codex smoke",
    scopes: ["verification:read", "verification:write", "verification:cancel"],
  });
  assert.match(issued.token, /^dvp_sk_/u);
  const stored = await prisma.toolCredential.findUniqueOrThrow({
    where: { id: issued.id },
  });
  assert.notEqual(stored.tokenHash, issued.token);
  assert.equal(JSON.stringify(stored).includes(issued.token), false);

  const toolContext = await toolAuth.authenticate(`Bearer ${issued.token}`);
  const verifications = new VerificationService(
    prisma,
    new VerificationLifecycleService(prisma),
    new ObjectStorageService(),
  );
  const request = verificationRequestSchema.parse({
    acceptanceCriteria: [
      {
        description: "The target page loads successfully.",
        id: "page-loads",
      },
    ],
    agentRuntime: { externalRunId: "codex-smoke-1", provider: "CODEX" },
    execution: { requiredCapabilities: ["browser"] },
    goal: "Verify the smoke target.",
    idempotencyKey: "verification-smoke-1",
    secretRefs: {
      LOGIN_PASSWORD: "environment://smoke/LOGIN_PASSWORD",
    },
  });
  const created = await verifications.create(toolContext, request);
  const retried = await verifications.create(toolContext, request);
  assert.equal(created.id, retried.id);
  assert.equal(created.status, "QUEUED");
  assert.equal(created.agentProvider, "CODEX");
  assert.equal(
    JSON.stringify(created.requestSnapshot).includes("PASSWORD"),
    true,
  );
  assert.equal(
    JSON.stringify(created.requestSnapshot).includes("do-not-store"),
    false,
  );

  await assert.rejects(
    verifications.create(toolContext, {
      ...request,
      goal: "A different goal with the same key.",
    }),
    /Idempotency key/u,
  );
  const cancelled = await verifications.cancel(toolContext, created.id);
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok(cancelled.finishedAt);

  await assert.rejects(
    prisma.$executeRawUnsafe(
      `UPDATE "verification_runs" SET "goal" = 'mutated' WHERE "id" = $1::uuid`,
      created.id,
    ),
    /immutable/u,
  );

  const lifecycle = new VerificationLifecycleService(prisma);
  const orchestratedRequest = verificationRequestSchema.parse({
    acceptanceCriteria: [
      {
        description: "A human approves the verification.",
        id: "human-approval",
      },
    ],
    agentRuntime: { provider: "GENERIC" },
    execution: { requiredCapabilities: ["browser"] },
    goal: "Exercise Worker and HITL orchestration.",
    idempotencyKey: "verification-orchestration-smoke-1",
  });
  const orchestrated = await verifications.create(
    toolContext,
    orchestratedRequest,
  );
  await lifecycle.transition({
    actor: "AGENT",
    eventKind: "verification.started",
    expected: ["QUEUED"],
    runId: orchestrated.id,
    teamId: team.id,
    to: "RUNNING",
  });
  assert.equal(
    (
      await prisma.verificationRun.findUniqueOrThrow({
        where: { id: orchestrated.id },
      })
    ).status,
    "RUNNING",
  );

  const hitl = new HitlCoordinator(prisma);
  const checkpoint = await hitl.request(team.id, orchestrated.id, {
    context: { source: "smoke" },
    prompt: "Approve the smoke verification?",
    responseSchema: {},
  });
  assert.equal(checkpoint.status, "PENDING");
  assert.equal(
    (
      await prisma.verificationRun.findUniqueOrThrow({
        where: { id: orchestrated.id },
      })
    ).status,
    "WAITING_HUMAN",
  );
  assert.equal(
    await prisma.notificationOutbox.count({
      where: { checkpointId: checkpoint.id },
    }),
    1,
  );
  await hitl.resolve(current, checkpoint.id, {
    response: { approved: true },
  });
  const completed = await verifications.complete(toolContext, orchestrated.id, {
    criteria: [
      {
        criterionId: "human-approval",
        evidenceRefs: [],
        status: "PASSED",
        summary: "A human approved the checkpoint.",
      },
    ],
    evidenceRefs: [],
    summary: "Worker and HITL orchestration passed.",
    verdict: "PASSED",
  });
  assert.equal(completed.status, "PASSED");
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `UPDATE "verification_runs" SET "result" = '{"verdict":"FAILED"}'::jsonb WHERE "id" = $1::uuid`,
      orchestrated.id,
    ),
    /terminal verification outcome is immutable/u,
  );
  const event = await prisma.verificationEvent.findFirstOrThrow({
    where: { runId: orchestrated.id },
  });
  await assert.rejects(
    prisma.verificationEvent.update({
      data: { kind: "mutated.event" },
      where: { id: event.id },
    }),
    /append-only/u,
  );

  await toolAuth.revoke(current, issued.id);
  await assert.rejects(
    toolAuth.authenticate(`Bearer ${issued.token}`),
    /invalid or expired/u,
  );
  process.stdout.write("verification broker smoke passed\n");
} finally {
  await prisma.$disconnect();
}
