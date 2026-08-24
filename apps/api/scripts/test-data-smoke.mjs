import assert from "node:assert/strict";

import { AuditService } from "../dist/console/audit.service.js";
import { PrismaService } from "../dist/database/prisma.service.js";
import { CredentialCipherService } from "../dist/security/credential-cipher.service.js";
import { TestDataService } from "../dist/test-data/test-data.service.js";

const prisma = new PrismaService();
await prisma.$connect();

try {
  const team = await prisma.team.create({
    data: {
      feishuTenantKey: "smoke-tenant",
      name: "Smoke Team",
      slug: "smoke-team",
    },
  });
  const otherTeam = await prisma.team.create({
    data: {
      feishuTenantKey: "other-smoke-tenant",
      name: "Other Smoke Team",
      slug: "other-smoke-team",
    },
  });
  const user = await prisma.user.create({
    data: { email: "smoke@devproof.local", name: "Smoke User" },
  });
  await prisma.teamMembership.create({
    data: { role: "ADMIN", teamId: team.id, userId: user.id },
  });

  const current = {
    sessionId: "smoke-session",
    team: { id: team.id, name: team.name, slug: team.slug },
    user: {
      avatarUrl: null,
      email: user.email,
      id: user.id,
      name: user.name,
    },
  };
  const service = new TestDataService(
    prisma,
    new CredentialCipherService(),
    new AuditService(prisma),
  );

  const project = await service.createProject(current, {
    description: "Data smoke test",
    name: "Checkout",
    slug: "checkout",
    status: "ACTIVE",
  });
  const environment = await service.createEnvironment(current, project.id, {
    baseUrl: "https://staging.example.com",
    enabled: true,
    name: "Staging",
    secrets: { LOGIN_PASSWORD: "do-not-leak" },
    slug: "staging",
    variables: { locale: "zh-CN" },
  });
  assert.equal("secretsEnc" in environment, false);
  assert.deepEqual(environment.secretKeys, ["LOGIN_PASSWORD"]);

  const testCase = await service.createCase(current, project.id, {
    description: "Checkout happy path",
    name: "Checkout succeeds",
    slug: "checkout-succeeds",
    status: "ACTIVE",
  });
  const version = await service.createCaseVersion(current, testCase.id, {
    changeSummary: "Initial version",
    definition: {
      profile: { mode: "EPHEMERAL" },
      schemaVersion: 1,
      steps: [
        { id: "open", type: "browser.navigate", url: "/checkout" },
        {
          clear: true,
          id: "password",
          selector: "[name=password]",
          type: "browser.type",
          value: { key: "LOGIN_PASSWORD", kind: "ENV_SECRET" },
        },
      ],
      timeoutSeconds: 900,
    },
  });
  assert.equal(version.version, 1);

  const runInput = {
    caseId: testCase.id,
    environmentId: environment.id,
    idempotencyKey: "smoke-run-1",
    trigger: "MANUAL",
  };
  const run = await service.createRun(current, runInput);
  const retried = await service.createRun(current, runInput);
  assert.equal(retried.id, run.id);
  assert.equal(
    JSON.stringify(run.environmentSnapshot).includes("do-not-leak"),
    false,
  );

  const trace = await service.appendTraceEvent(team.id, run.id, {
    actor: "BROWSER",
    kind: "browser.type",
    payload: { password: "do-not-leak", selector: "[name=password]" },
    status: "SUCCEEDED",
    stepId: "password",
  });
  assert.equal(trace.payload.password, "••••redacted••••");
  assert.match(trace.sequence, /^\d+$/u);

  await service.linkArtifact(team.id, run.id, {
    kind: "SCREENSHOT",
    label: "after password",
    metadata: {},
    storageKey: `smoke/${run.id}/after-password.png`,
    traceEventId: trace.id,
  });
  const checkpoint = await service.createCheckpoint(team.id, run.id, {
    context: { reason: "visual confirmation" },
    prompt: "Confirm checkout state",
    stepId: "approval",
  });
  const resolved = await service.resolveCheckpoint(
    current,
    run.id,
    checkpoint.id,
    { response: { approved: true } },
  );
  assert.equal(resolved.status, "RESOLVED");

  await assert.rejects(
    prisma.$executeRawUnsafe(
      `UPDATE "test_case_versions" SET "change_summary" = 'mutated' WHERE "id" = $1::uuid`,
      version.id,
    ),
    /immutable/u,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `UPDATE "test_run_trace_events" SET "kind" = 'mutated' WHERE "id" = $1::uuid`,
      trace.id,
    ),
    /append-only/u,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `UPDATE "test_runs" SET "definition_snapshot" = '{}'::jsonb WHERE "id" = $1::uuid`,
      run.id,
    ),
    /immutable/u,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "test_environments"
        ("id", "team_id", "project_id", "name", "slug", "base_url", "updated_at")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'Cross team', 'cross-team', 'https://example.com', now())`,
      otherTeam.id,
      project.id,
    ),
    /foreign key/u,
  );

  const detail = await service.runDetail(current, run.id);
  assert.equal(detail.traceEvents.length, 1);
  assert.equal(detail.artifacts.length, 1);
  assert.equal(detail.checkpoints.length, 1);
  process.stdout.write("test-data smoke passed\n");
} finally {
  await prisma.$disconnect();
}
