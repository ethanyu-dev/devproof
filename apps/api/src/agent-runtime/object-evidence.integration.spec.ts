import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import {
  observationContractSchema,
  businessCheckSchema,
  compileBusinessCheck,
  runtimeTaskSnapshotSchema,
  observationCoverage,
} from "@devproof/agent-runtime-protocol";
import { structuredObservationSchema } from "@devproof/runtime-protocol";
import { BrowserSessionManager } from "../../../browser-runtime/src/index.js";
import { startSsrfProxy } from "../../../browser-runtime/src/ssrf-proxy.js";
import { ObservationBindingService } from "./observation-binding.service.js";

function database(task: unknown) {
  const bindings: any[] = [],
    events: any[] = [],
    evidence: any[] = [];
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
      if (key === "payload" || key === "metadata")
        return (
          value.path.reduce((v: any, field: string) => v?.[field], row[key]) ===
          value.equals
        );
      if (value && typeof value === "object" && "in" in value)
        return value.in.includes(row[key]);
      if (value && typeof value === "object" && "gt" in value)
        return row[key] > value.gt;
      return row[key] === value;
    });
  const find = (rows: any[], args: any) =>
    rows.filter((row) => matches(row, args.where));
  const prisma: any = {
    agentRuntimeTask: { findFirst: vi.fn().mockImplementation(() => task) },
    runObservationBinding: {
      createMany: vi.fn(({ data }) => {
        for (const row of data)
          if (
            !bindings.some((b) =>
              [
                "attemptId",
                "targetId",
                "contractDigest",
                "observationId",
                "bindingDigest",
              ].every((k) => b[k] === row[k]),
            )
          )
            bindings.push(row);
      }),
      findUniqueOrThrow: vi.fn(({ where }) =>
        bindings.find((b) => matches(b, where.observationResolution)),
      ),
      findMany: vi.fn((args) =>
        find(bindings, args)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, args.take ?? bindings.length),
      ),
      count: vi.fn((args) => find(bindings, args).length),
    },
    runEvent: {
      create: vi.fn(({ data }) => {
        events.push(data);
        return data;
      }),
      createMany: vi.fn(({ data }) => {
        for (const row of data)
          if (!events.some((e) => e.id === row.id)) events.push(row);
      }),
      findFirst: vi.fn((args) => find(events, args)[0]),
      findMany: vi.fn((args) => find(events, args)),
      count: vi.fn((args) => find(events, args).length),
    },
    runEvidence: {
      findMany: vi.fn((args) => find(evidence, args)),
      findFirst: vi.fn((args) => find(evidence, args)[0]),
    },
  };
  prisma.$transaction = (fn: any) => fn(prisma);
  return { prisma, bindings, events, evidence };
}

it("appends explicit resolutions after an automatic partial binding without hiding counterexamples", async () => {
  const contract = observationContractSchema.parse({
    version: 3,
    comparisons: [],
    targets: [
      {
        targetId: "mapping",
        label: "合规模型映射",
        identity: { text: "合规模型映射" },
        phase: "CURRENT",
        assertions: [
          {
            assertionId: "state",
            label: "配置值",
            property: "TEXT",
            expected: "禁用",
          },
        ],
        requiredEvidenceKinds: ["DOM"],
      },
    ],
  });
  const task: any = {
    id: randomUUID(),
    runId: randomUUID(),
    attemptId: randomUUID(),
  };
  task.snapshot = runtimeTaskSnapshotSchema.parse({
    runId: task.runId,
    attemptId: task.attemptId,
    attemptNumber: 1,
    teamId: randomUUID(),
    traceId: "b".repeat(32),
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    goal: "核对配置",
    criteria: [
      { id: "config", description: "禁用", observationContract: contract },
    ],
  });
  const observation = structuredObservationSchema.parse({
    version: 2,
    captureId: randomUUID(),
    capturedFrom: new Date().toISOString(),
    capturedUntil: new Date().toISOString(),
    pageIdentity: "https://example.test/records",
    frames: [],
    nodes: [
      { nodeId: "row", ref: "row", tag: "tr" },
      {
        nodeId: "identity",
        ref: "identity",
        tag: "td",
        parentId: "row",
        text: "合规模型映射",
      },
      {
        nodeId: "disabled",
        ref: "disabled",
        tag: "span",
        parentId: "row",
        text: "禁用",
      },
      {
        nodeId: "enabled",
        ref: "enabled",
        tag: "span",
        parentId: "row",
        text: "启用",
      },
    ].map((n) => ({
      ...n,
      frameId: "frame",
      documentEpoch: "frame",
      visible: true,
      attributes: {},
      relations: [],
      textLocation: { start: 0, end: 0 },
    })),
    regions: [],
    renderedText: "",
    consistency: "VERIFIED",
    coverage: {
      scope: "VIEWPORT",
      completeWithinScope: true,
      truncated: false,
      unavailableFrames: [],
    },
  });
  const body = Buffer.from(JSON.stringify(observation));
  const command = {
    id: randomUUID(),
    status: "SUCCEEDED",
    artifacts: [
      {
        id: randomUUID(),
        kind: "DOM",
        contentType: "application/json",
        storageKey: "observation",
        byteSize: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        metadata: {
          captureId: observation.captureId,
          observationSchemaVersion: 2,
        },
      },
    ],
  };
  const db = database(task);
  const service = new ObservationBindingService(db.prisma, {
    get: vi.fn(async () => ({ body })),
  } as never);
  const automatic = await service.capture(task, command);
  expect(automatic.bindings[0]?.readiness).toBe("PARTIAL");
  const selection = {
    observationId: observation.captureId,
    targetId: "mapping",
    scopeRef: "row",
    entityRef: "identity",
    assertionRefs: { state: "disabled" },
  };
  const resolved = await service.capture(task, command, selection);
  expect(resolved.bindings[0]).toMatchObject({
    readiness: "READY",
    evaluation: "MATCHED",
  });
  expect(
    (await service.capture(task, command, selection)).bindings[0]?.id,
  ).toBe(resolved.bindings[0]?.id);
  const counterexample = await service.capture(task, command, {
    ...selection,
    assertionRefs: { state: "enabled" },
  });
  expect(counterexample.bindings[0]?.evaluation).toBe("MISMATCHED");
  expect(
    observationCoverage(contract, [
      ...automatic.bindings,
      ...resolved.bindings,
      ...counterexample.bindings,
    ])[0]?.readiness,
  ).toBe("CONFLICT");
  expect(db.bindings).toHaveLength(3);
});

it.each([2, 3] as const)(
  "verifies three real modal defaults, persists their screenshots, compares and submits bound evidence (v%s)",
  async (version) => {
    const html = await readFile(
      new URL(
        "../../../browser-runtime/src/fixtures/object-evidence.html",
        import.meta.url,
      ),
      "utf8",
    );
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const proxy = await startSsrfProxy({ allowlist: new Set(["127.0.0.1"]) });
    const manager = new BrowserSessionManager(
      {
        removeSession: vi.fn(),
        replaceSession: vi.fn(),
        value: () => ({ sessions: [] }),
      } as never,
      proxy.server,
      vi.fn(),
      vi.fn(),
    );
    const sessionId = randomUUID(),
      leaseToken = randomUUID();
    const legacyContract = observationContractSchema.parse({
      version: 2,
      targets: ["合规模型映射", "旧版对公转账白名单", "零数据留存 (ZDR)"].map(
        (name, i) => ({
          targetId: `type-${i}`,
          label: name,
          scope: { kind: "DIALOG", names: ["新增用户白名单"] },
          entity: {
            controlKind: "SELECT",
            label: "白名单类型",
            property: "SELECTED_LABEL",
            oneOf: [name],
          },
          phase: "INITIAL_AFTER_OPEN",
          assertions: [
            {
              assertionId: "enabled",
              subject: { kind: "SWITCH", label: "启用状态" },
              property: "CHECKED",
              operator: "EQ",
              expected: true,
            },
          ],
          requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
          temporal: "SAME_OBSERVATION",
        }),
      ),
      comparisons: [0, 1].map((i) => ({
        comparisonId: `compare-${i}`,
        subjectTargetId: `type-${i}`,
        referenceTargetId: "type-2",
        dimensions: ["开关形式"],
        sourceRef: "analysis-source://fixture",
        quote: "开关形式与参照一致",
      })),
    });
    if (legacyContract.version !== 2) throw new Error("Invalid test fixture");
    const contract =
      version === 2
        ? legacyContract
        : compileBusinessCheck(
            businessCheckSchema.parse({
              subjects: ["合规模型映射", "旧版对公转账白名单"],
              state: { label: "启用状态", equals: true },
              when: "INITIAL_AFTER_OPEN",
              compareWith: "零数据留存 (ZDR)",
              dimensions: ["开关形式"],
            }),
            {
              sourceRef: "analysis-source://fixture",
              quote: "开关形式与参照一致",
            },
            ["DOM", "SCREENSHOT"],
          );
    const task: any = {
      id: randomUUID(),
      runId: randomUUID(),
      attemptId: randomUUID(),
      fencingToken: 1n,
      leaseToken,
      leaseOwner: "fixture",
      status: "RUNNING",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    task.snapshot = runtimeTaskSnapshotSchema.parse({
      attemptId: task.attemptId,
      attemptNumber: 1,
      runId: task.runId,
      teamId: randomUUID(),
      traceId: "a".repeat(32),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      goal: "Verify modal defaults.",
      criteria: [
        {
          id: "defaults",
          description: "默认开启且开关形式一致",
          observationContract: contract,
          requiredEvidenceKinds: ["DOM", "SCREENSHOT"],
        },
      ],
    });
    const db = database(task),
      storage = new Map<string, Buffer>();
    const service = new ObservationBindingService(db.prisma, {
      get: vi.fn(async (key: string) => ({ body: storage.get(key)! })),
    } as never);
    async function execute(
      commandType: any,
      payload: Record<string, unknown>,
      combined = false,
    ) {
      const id = randomUUID();
      const output: any = await manager.execute({
        commandId: id,
        commandType,
        payload,
        sessionId,
        leaseToken,
        fencingToken: "1",
        deadlineAt: new Date(Date.now() + 15_000).toISOString(),
        type: "command.execute",
        ...(combined
          ? { after: { observe: "ACTIVE_REGION", timeoutMs: 1500 } }
          : {}),
      });
      const artifacts = (output.artifacts ?? []).map((a: any) => {
        const id = randomUUID(),
          body = Buffer.from(a.dataBase64, "base64");
        storage.set(id, body);
        const artifact = {
          ...a,
          id,
          storageKey: id,
          byteSize: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        };
        db.evidence.push({
          runId: task.runId,
          attemptId: task.attemptId,
          externalId: `artifact://${id}`,
          kind: a.kind,
          runtimeArtifactId: id,
          runtimeArtifact: artifact,
          metadata: a.metadata,
        });
        return artifact;
      });
      const command = { id, artifacts, status: "SUCCEEDED" };
      return { output, command, bound: await service.capture(task, command) };
    }
    const reference = (output: any, tag: string) =>
      output.result.structuredObservation.nodes.find((n: any) => n.tag === tag)
        ?.ref;
    try {
      await execute("session.open", {
        allowedOrigins: [origin],
        profileMode: "EPHEMERAL",
        profileKey: `object-evidence-${randomUUID()}`,
      });
      await execute("page.navigate", { url: origin });
      await execute("page.snapshot", {});
      const ids: string[] = [];
      let last: Awaited<ReturnType<typeof execute>> | undefined;
      for (const target of contract.targets) {
        await execute("page.click", { target: { selector: "#open" } }, true);
        const observed = await execute("page.snapshot", {});
        last = await execute(
          "page.select",
          {
            target: { ref: reference(observed.output, "select") },
            values: [
              "identity" in target
                ? target.identity.text
                : target.entity.oneOf[0],
            ],
          },
          true,
        );
        expect(last.output.result.actionOutcome.status).toBe("SUCCEEDED");
        const binding = last.bound.bindings.find(
          (b) => b.targetId === target.targetId,
        )!;
        expect(binding, JSON.stringify(last.bound)).toMatchObject({
          readiness: "READY",
          evaluation: "MATCHED",
          phaseProven: true,
        });
        ids.push(binding.id);
        expect(
          (await service.capture(task, last.command)).bindings.find(
            (b) => b.targetId === target.targetId,
          )?.id,
        ).toBe(binding.id);
        await execute("page.click", { target: { selector: "#close" } }, true);
      }
      const reviews: string[] = [];
      for (const [i, requirement] of contract.comparisons.entries()) {
        const pair = [ids[i]!, ids[2]!] as [string, string];
        const images = await service.images(task, pair);
        expect(images.images).toHaveLength(2);
        const reviewInput = {
          comparisonId: requirement.comparisonId,
          bindingIds: pair,
          deliveryId: images.deliveryId,
          verdict: "EQUIVALENT" as const,
          dimensions: requirement.dimensions,
          rationale: "Fixture oracle: identical switch component.",
        };
        await expect(service.compare(task, reviewInput)).rejects.toThrow(
          "COMPARISON_IMAGES_NOT_DELIVERED",
        );
        await service.deliver(task, {
          modelRequestId: randomUUID(),
          bindingIds: ids,
          imageDeliveryId: images.deliveryId,
        });
        const [review, concurrentRetry] = await Promise.all([
          service.compare(task, reviewInput),
          service.compare(task, reviewInput),
        ]);
        expect(concurrentRetry.id).toBe(review.id);
        expect((await service.compare(task, reviewInput)).id).toBe(review.id);
        reviews.push(review.id);
      }
      await expect(
        service.validate(task, [
          {
            criterionId: "defaults",
            status: "PASSED",
            bindingIds: ids,
            comparisonReviewIds: reviews,
          },
        ]),
      ).resolves.toBeUndefined();
      await expect(
        service.validate(task, [{ criterionId: "defaults", status: "PASSED" }]),
      ).rejects.toThrow("TARGET_NOT_CONFIRMED");
      await expect(
        service.images({ ...task, attemptId: randomUUID() }, ids.slice(0, 2)),
      ).rejects.toThrow("BINDING_NOT_AVAILABLE");
      await expect(
        service.validateReferences(task, ids, reviews),
      ).resolves.toBeUndefined();
      await expect(
        service.validateReferences(
          { ...task, attemptId: randomUUID() },
          ids,
          reviews,
        ),
      ).rejects.toThrow("CHECKPOINT_BINDING_NOT_AVAILABLE");
      const delivery = { modelRequestId: randomUUID(), bindingIds: [ids[0]!] };
      await service.deliver(task, delivery);
      await expect(
        service.deliver(task, { ...delivery, bindingIds: [ids[1]!] }),
      ).rejects.toThrow("MODEL_DELIVERY_CONFLICT");
      const page = await service.read(task, {});
      expect(page.bindings.length).toBeGreaterThan(0);
      await expect(
        service.read(
          { ...task, attemptId: randomUUID() },
          { continuationToken: page.continuationToken! },
        ),
      ).rejects.toThrow("INVALID_CONTINUATION_TOKEN");
      let token = page.continuationToken;
      const restoredReviews: string[] = [];
      while (token) {
        const next = await service.read(task, { continuationToken: token });
        restoredReviews.push(...next.reviews.map((r) => r.id));
        token = next.continuationToken;
      }
      expect(restoredReviews.sort()).toEqual(reviews.sort());
      // A later image pair must not let finalization ignore an unresolved visual
      // counterexample, even when the selected older pair has an equivalent review.
      const freshIds: string[] = [];
      for (const target of [contract.targets[0]!, contract.targets[2]!]) {
        const opened = await execute(
          "page.click",
          { target: { selector: "#open" } },
          true,
        );
        const selected = await execute(
          "page.select",
          {
            target: { ref: reference(opened.output, "select") },
            values: [
              "identity" in target
                ? target.identity.text
                : target.entity.oneOf[0],
            ],
          },
          true,
        );
        freshIds.push(
          selected.bound.bindings.find((b) => b.targetId === target.targetId)!
            .id,
        );
        await execute("page.click", { target: { selector: "#close" } }, true);
      }
      const pair = freshIds as [string, string];
      const images = await service.images(task, pair);
      await service.deliver(task, {
        modelRequestId: randomUUID(),
        bindingIds: pair,
        imageDeliveryId: images.deliveryId,
      });
      const reviewInput = {
        comparisonId: contract.comparisons[0]!.comparisonId,
        bindingIds: pair,
        deliveryId: images.deliveryId,
        verdict: "DIFFERENT" as const,
        dimensions: contract.comparisons[0]!.dimensions,
        rationale: "Initial visual judgment for a fresh capture pair.",
      };
      const negative = await service.compare(task, reviewInput);
      const completed = [
        {
          criterionId: "defaults",
          status: "PASSED",
          bindingIds: ids,
          comparisonReviewIds: reviews,
        },
      ];
      await expect(service.validate(task, completed)).rejects.toThrow(
        "COMPARISON_REVIEW_CONFLICT",
      );
      await expect(
        service.validate(task, [
          {
            criterionId: "defaults",
            status: "FAILED",
            bindingIds: pair,
            comparisonReviewIds: [negative.id],
          },
        ]),
      ).resolves.toBeUndefined();
      // Re-read the disputed pair and explicitly replace its review; merely
      // selecting another positive pair must never serve as conflict resolution.
      const reread = await service.images(task, pair);
      await service.deliver(task, {
        modelRequestId: randomUUID(),
        bindingIds: pair,
        imageDeliveryId: reread.deliveryId,
      });
      await service.compare(task, {
        ...reviewInput,
        deliveryId: reread.deliveryId,
        verdict: "EQUIVALENT",
        supersedesReviewId: negative.id,
        rationale:
          "Re-reviewed the disputed images: identical fixture switch component.",
      });
      await expect(service.validate(task, completed)).resolves.toBeUndefined();
      db.prisma.agentRuntimeTask.findFirst.mockResolvedValue(null);
      await expect(service.capture(task, last!.command)).rejects.toThrow(
        "RUNTIME_LEASE_LOST",
      );
    } finally {
      await manager.close(sessionId).catch(() => undefined);
      await proxy.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  60_000,
);
