import { randomUUID, createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import type { AgentRuntimeTask, Prisma } from "@prisma/client";
import { z } from "zod";
import {
  bindObservationInputSchema,
  boundCriterionError,
  evaluateObservationTarget,
  observationBindingSchema,
  observationCoverage,
  readBindingsInputSchema,
  runtimeTaskSnapshotSchema,
  visualComparisonInputSchema,
  visualComparisonReviewSchema,
  type ObservationBinding,
  type VisualComparisonReview,
} from "@devproof/agent-runtime-protocol";
import { observationDigest } from "@devproof/agent-runtime-protocol/observation-digest";
import {
  structuredObservationSchema,
  STRUCTURED_OBSERVATION_MAX_BYTES,
  VISUAL_OBSERVATION_MAX_BYTES,
  visualObservationMetadataSchema,
} from "@devproof/runtime-protocol";
import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";

const json = (v: unknown) => v as Prisma.InputJsonValue;
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
type CaptureCommand = {
  id: string;
  status: string;
  artifacts: Array<{
    id: string;
    kind: string;
    metadata: unknown;
    contentType: string;
    storageKey: string;
    byteSize: number;
    sha256?: string | null;
  }>;
};

/** Binds only canonical artifacts from this attempt, never model-supplied state. */
@Injectable()
export class ObservationBindingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  private async assertLease(
    tx: Prisma.TransactionClient,
    task: AgentRuntimeTask,
  ) {
    const active = await tx.agentRuntimeTask.findFirst({
      where: {
        id: task.id,
        attemptId: task.attemptId,
        fencingToken: task.fencingToken,
        leaseToken: task.leaseToken,
        leaseOwner: task.leaseOwner,
        leaseExpiresAt: { gt: new Date() },
        status: "RUNNING",
        run: { lifecycle: "RUNNING" },
      },
      select: { id: true },
    });
    if (!active) throw new ConflictException("RUNTIME_LEASE_LOST");
  }

  async capture(
    task: AgentRuntimeTask,
    command: CaptureCommand,
    selection?: z.infer<typeof bindObservationInputSchema>,
  ) {
    const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
    if (
      !snapshot.criteria.some((c) => c.observationContract) ||
      command.status !== "SUCCEEDED"
    )
      return {
        bindings: [] as ObservationBinding[],
        coverage: [] as unknown[],
      };
    const artifact = command.artifacts.find(
      (a) =>
        a.kind === "DOM" &&
        a.contentType === "application/json" &&
        record(a.metadata).observationSchemaVersion === 2,
    );
    if (!artifact)
      return {
        bindings: [] as ObservationBinding[],
        coverage: [],
        observationError: "STRUCTURED_OBSERVATION_UNAVAILABLE",
      };
    if (artifact.byteSize > STRUCTURED_OBSERVATION_MAX_BYTES)
      throw new BadRequestException("OBSERVATION_TOO_LARGE");
    const stored = await this.storage.get(artifact.storageKey, {
      start: 0,
      end: STRUCTURED_OBSERVATION_MAX_BYTES,
    });
    if (
      stored.body.byteLength !== artifact.byteSize ||
      (artifact.sha256 &&
        createHash("sha256").update(stored.body).digest("hex") !==
          artifact.sha256)
    )
      throw new BadRequestException("OBSERVATION_INTEGRITY_ERROR");
    const observation = structuredObservationSchema.parse(
      JSON.parse(stored.body.toString("utf8")),
    );
    if (selection && selection.observationId !== observation.captureId)
      throw new BadRequestException("OBSERVATION_NOT_AVAILABLE");
    const artifacts = command.artifacts.filter(
      (a) => record(a.metadata).captureId === observation.captureId,
    );
    const evidenceRefs = artifacts.map((a) => `artifact://${a.id}`);
    const bindings: ObservationBinding[] = [];
    const diagnostics: unknown[] = [];
    for (const criterion of snapshot.criteria) {
      const contract = criterion.observationContract;
      if (!contract) continue;
      for (const target of contract.targets) {
        if (selection && selection.targetId !== target.targetId) continue;
        const evaluated = evaluateObservationTarget(
          target,
          observation,
          artifacts.map((a) => a.kind),
          selection,
        );
        if (!evaluated.binding) {
          diagnostics.push({
            criterionId: criterion.id,
            targetId: target.targetId,
            observationId: observation.captureId,
            ...evaluated,
          });
          continue;
        }
        const binding = observationBindingSchema.parse({
          ...evaluated.binding,
          id: randomUUID(),
          runId: task.runId,
          attemptId: task.attemptId,
          criterionId: criterion.id,
          contractDigest: observationDigest(contract),
          observationId: observation.captureId,
          captureId: observation.captureId,
          sourceCommandId: command.id,
          evidenceRefs,
          capturedAt: observation.capturedUntil,
        });
        const { id: _id, ...facts } = binding;
        const bindingDigest = observationDigest(facts);
        const unique = {
          attemptId: task.attemptId,
          targetId: target.targetId,
          contractDigest: binding.contractDigest,
          observationId: observation.captureId,
        };
        const saved = await this.prisma.$transaction(async (tx) => {
          await this.assertLease(tx, task);
          await tx.runObservationBinding.createMany({
            data: [
              {
                id: binding.id,
                teamId: snapshot.teamId,
                runId: task.runId,
                ...unique,
                criterionId: criterion.id,
                sourceCommandId: command.id,
                snapshotArtifactId: artifact.id,
                bindingDigest,
                facts: json(facts),
              },
            ],
            skipDuplicates: true,
          });
          const row = await tx.runObservationBinding.findUniqueOrThrow({
            where: { attemptId_targetId_contractDigest_observationId: unique },
          });
          if (row.bindingDigest !== bindingDigest)
            throw new ConflictException(
              "BINDING_CONFLICT: an immutable observation cannot be overwritten.",
            );
          return observationBindingSchema.parse({
            ...record(row.facts),
            id: row.id,
          });
        });
        bindings.push(saved);
      }
    }
    return {
      bindings,
      coverage: diagnostics.slice(0, 200),
      observationId: observation.captureId,
    };
  }

  async bind(
    task: AgentRuntimeTask,
    input: z.infer<typeof bindObservationInputSchema>,
  ) {
    const evidence = await this.prisma.runEvidence.findFirst({
      where: {
        runId: task.runId,
        attemptId: task.attemptId,
        kind: "DOM",
        metadata: { path: ["captureId"], equals: input.observationId },
      },
      include: {
        runtimeArtifact: {
          include: { command: { include: { artifacts: true } } },
        },
      },
    });
    const command = evidence?.runtimeArtifact?.command;
    if (!command || command.ownerTaskId !== task.id)
      throw new BadRequestException("OBSERVATION_NOT_AVAILABLE");
    return this.capture(task, command, input);
  }

  async read(
    task: AgentRuntimeTask,
    input: z.infer<typeof readBindingsInputSchema>,
  ) {
    let after: string | undefined;
    let kind: "BINDING" | "REVIEW" = "BINDING";
    const token = (kind: string, after?: string) =>
      Buffer.from(
        JSON.stringify({ attemptId: task.attemptId, kind, after }),
      ).toString("base64url");
    if (input.continuationToken) {
      try {
        const value = JSON.parse(
          Buffer.from(input.continuationToken, "base64url").toString("utf8"),
        );
        if (
          value.attemptId !== task.attemptId ||
          !["BINDING", "REVIEW"].includes(value.kind) ||
          (value.after && !z.string().uuid().safeParse(value.after).success)
        )
          throw new Error();
        after = value.after;
        kind = value.kind;
      } catch {
        throw new BadRequestException(
          "INVALID_CONTINUATION_TOKEN: restart observation-bindings/read without a token.",
        );
      }
    }
    if (kind === "REVIEW") {
      const rows = await this.prisma.runEvent.findMany({
        where: {
          runId: task.runId,
          attemptId: task.attemptId,
          kind: "observation.visual.reviewed",
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: "asc" },
        take: 11,
      });
      const reviews: VisualComparisonReview[] = [];
      for (const row of rows.slice(0, 10)) {
        const review = visualComparisonReviewSchema.parse({
          ...record(row.payload),
          id: row.id,
        });
        if (Buffer.byteLength(JSON.stringify([...reviews, review])) > 24 * 1024)
          break;
        reviews.push(review);
      }
      const continuationToken =
        rows.length > reviews.length && reviews.length
          ? token("REVIEW", reviews.at(-1)!.id)
          : null;
      return {
        bindings: [] as ObservationBinding[],
        artifacts: [],
        reviews,
        continuationToken,
        ...(continuationToken
          ? {
              nextAction: {
                tool: "read_observation_bindings",
                arguments: { continuationToken },
              },
            }
          : {}),
      };
    }
    const rows = await this.prisma.runObservationBinding.findMany({
      where: {
        runId: task.runId,
        attemptId: task.attemptId,
        ...(input.bindingIds
          ? { id: { in: input.bindingIds } }
          : after
            ? { id: { gt: after } }
            : {}),
      },
      orderBy: { id: "asc" },
      take: 21,
    });
    const bindings: ObservationBinding[] = [];
    for (const row of rows.slice(0, 20)) {
      const binding = observationBindingSchema.parse({
        ...record(row.facts),
        id: row.id,
      });
      if (Buffer.byteLength(JSON.stringify([...bindings, binding])) > 20 * 1024)
        break;
      bindings.push(binding);
    }
    const continuationToken = input.bindingIds
      ? null
      : rows.length > bindings.length && bindings.length
        ? token("BINDING", bindings.at(-1)!.id)
        : token("REVIEW");
    const evidence = await this.prisma.runEvidence.findMany({
      where: {
        runId: task.runId,
        attemptId: task.attemptId,
        externalId: { in: bindings.flatMap((b) => b.evidenceRefs) },
      },
      select: { runtimeArtifactId: true, kind: true },
    });
    const artifacts = evidence
      .filter((e) => e.runtimeArtifactId)
      .map((e) => ({ id: e.runtimeArtifactId!, kind: e.kind }));
    if (input.bindingIds && rows.length !== new Set(input.bindingIds).size)
      throw new BadRequestException("BINDING_NOT_AVAILABLE");
    if (rows.length && !bindings.length)
      throw new BadRequestException("BINDING_READ_BUDGET_EXCEEDED");
    const omittedBindingIds =
      input.bindingIds?.filter((id) => !bindings.some((b) => b.id === id)) ??
      [];
    return {
      bindings,
      artifacts,
      reviews: [] as VisualComparisonReview[],
      continuationToken,
      omittedBindingIds,
      ...(continuationToken
        ? {
            nextAction: {
              tool: "read_observation_bindings",
              arguments: { continuationToken },
            },
          }
        : omittedBindingIds.length
          ? {
              nextAction: {
                tool: "read_observation_bindings",
                arguments: { bindingIds: omittedBindingIds },
              },
            }
          : {}),
    };
  }

  async all(
    task: Pick<AgentRuntimeTask, "runId" | "attemptId">,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const rows = await tx.runObservationBinding.findMany({
      where: { runId: task.runId, attemptId: task.attemptId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) =>
      observationBindingSchema.parse({ ...record(r.facts), id: r.id }),
    );
  }

  async images(task: AgentRuntimeTask, bindingIds: string[]) {
    const { bindings } = await this.read(task, { bindingIds });
    if (bindings.length !== new Set(bindingIds).size)
      throw new BadRequestException("BINDING_NOT_AVAILABLE");
    const images: unknown[] = [];
    for (const id of bindingIds) {
      const binding = bindings.find((b) => b.id === id)!;
      const evidence = await this.prisma.runEvidence.findFirst({
        where: {
          runId: task.runId,
          attemptId: task.attemptId,
          externalId: { in: binding.evidenceRefs },
          kind: "SCREENSHOT",
        },
        include: { runtimeArtifact: true },
      });
      const artifact = evidence?.runtimeArtifact;
      if (
        !artifact ||
        artifact.byteSize > VISUAL_OBSERVATION_MAX_BYTES ||
        !["image/png", "image/jpeg"].includes(artifact.contentType) ||
        record(artifact.metadata).captureId !== binding.captureId
      )
        throw new BadRequestException("EVIDENCE_UNAVAILABLE");
      const image = await this.storage.get(artifact.storageKey, {
        start: 0,
        end: VISUAL_OBSERVATION_MAX_BYTES,
      });
      if (
        image.body.byteLength !== artifact.byteSize ||
        (artifact.sha256 &&
          createHash("sha256").update(image.body).digest("hex") !==
            artifact.sha256)
      )
        throw new BadRequestException("EVIDENCE_UNAVAILABLE");
      images.push({
        bindingId: id,
        purpose: "REFERENCE_EVIDENCE",
        artifactId: artifact.id,
        contentType: artifact.contentType,
        dataBase64: image.body.toString("base64"),
        ...visualObservationMetadataSchema.parse(
          record(artifact.metadata).visualObservation,
        ),
      });
    }
    const deliveryId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await this.assertLease(tx, task);
      await tx.runEvent.create({
        data: {
          id: deliveryId,
          teamId: runtimeTaskSnapshotSchema.parse(task.snapshot).teamId,
          runId: task.runId,
          attemptId: task.attemptId,
          taskId: task.id,
          actor: "API",
          kind: "observation.images.prepared",
          payload: json({
            bindingIds,
            fencingToken: task.fencingToken.toString(),
          }),
        },
      });
    });
    return { deliveryId, images };
  }

  async deliver(
    task: AgentRuntimeTask,
    input: {
      modelRequestId: string;
      bindingIds: string[];
      imageDeliveryId?: string | undefined;
    },
  ) {
    const own = await this.prisma.runObservationBinding.count({
      where: {
        runId: task.runId,
        attemptId: task.attemptId,
        id: { in: [...new Set(input.bindingIds)] },
      },
    });
    if (own !== new Set(input.bindingIds).size)
      throw new BadRequestException("BINDING_NOT_AVAILABLE");
    if (input.imageDeliveryId) {
      const prepared = await this.prisma.runEvent.findFirst({
        where: {
          id: input.imageDeliveryId,
          runId: task.runId,
          attemptId: task.attemptId,
          taskId: task.id,
          actor: "API",
          kind: "observation.images.prepared",
        },
      });
      if (
        !prepared ||
        record(prepared.payload).fencingToken !== task.fencingToken.toString()
      )
        throw new BadRequestException("IMAGE_DELIVERY_UNAVAILABLE");
    }
    await this.prisma.$transaction(async (tx) => {
      await this.assertLease(tx, task);
      await tx.runEvent.createMany({
        data: [
          {
            id: input.modelRequestId,
            teamId: runtimeTaskSnapshotSchema.parse(task.snapshot).teamId,
            runId: task.runId,
            attemptId: task.attemptId,
            taskId: task.id,
            actor: "AGENT_RUNTIME",
            kind: "observation.model.delivered",
            payload: json({
              ...input,
              fencingToken: task.fencingToken.toString(),
            }),
          },
        ],
        skipDuplicates: true,
      });
      const saved = await tx.runEvent.findFirst({
        where: {
          id: input.modelRequestId,
          runId: task.runId,
          attemptId: task.attemptId,
          taskId: task.id,
          kind: "observation.model.delivered",
        },
      });
      if (
        !saved ||
        observationDigest(saved.payload) !==
          observationDigest({
            ...input,
            fencingToken: task.fencingToken.toString(),
          })
      )
        throw new ConflictException("MODEL_DELIVERY_CONFLICT");
    });
    return { accepted: true };
  }

  async compare(
    task: AgentRuntimeTask,
    input: z.infer<typeof visualComparisonInputSchema>,
  ) {
    const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
    const criterion = snapshot.criteria.find((c) =>
      c.observationContract?.comparisons.some(
        (r) => r.comparisonId === input.comparisonId,
      ),
    );
    const requirement = criterion?.observationContract?.comparisons.find(
      (r) => r.comparisonId === input.comparisonId,
    );
    if (!criterion?.observationContract || !requirement)
      throw new BadRequestException("COMPARISON_NOT_AVAILABLE");
    const prepared = await this.prisma.runEvent.findFirst({
      where: {
        id: input.deliveryId,
        runId: task.runId,
        attemptId: task.attemptId,
        taskId: task.id,
        kind: "observation.images.prepared",
        actor: "API",
      },
    });
    const delivered = await this.prisma.runEvent.findFirst({
      where: {
        runId: task.runId,
        attemptId: task.attemptId,
        taskId: task.id,
        kind: "observation.model.delivered",
        payload: { path: ["imageDeliveryId"], equals: input.deliveryId },
      },
    });
    if (
      !prepared ||
      !delivered ||
      record(prepared.payload).fencingToken !== task.fencingToken.toString() ||
      input.bindingIds.some(
        (id) => !(record(prepared.payload).bindingIds as string[]).includes(id),
      )
    )
      throw new BadRequestException("COMPARISON_IMAGES_NOT_DELIVERED");
    const { bindings } = await this.read(task, {
      bindingIds: input.bindingIds,
    });
    const digest = observationDigest(criterion.observationContract);
    for (const [index, targetId] of [
      requirement.subjectTargetId,
      requirement.referenceTargetId,
    ].entries()) {
      const binding = bindings.find((b) => b.id === input.bindingIds[index]);
      const target = criterion.observationContract.targets.find(
        (t) => t.targetId === targetId,
      )!;
      if (
        !binding ||
        binding.targetId !== targetId ||
        binding.contractDigest !== digest ||
        binding.criterionId !== criterion.id ||
        binding.phase !== target.phase ||
        binding.readiness !== "READY"
      )
        throw new BadRequestException("COMPARISON_BINDING_INVALID");
    }
    if (
      requirement.dimensions.some((d) => !input.dimensions.includes(d)) ||
      input.dimensions.some((d) => !requirement.dimensions.includes(d))
    )
      throw new BadRequestException("COMPARISON_DIMENSIONS_REQUIRED");
    if (input.supersedesReviewId) {
      const previous = await this.prisma.runEvent.findFirst({
        where: {
          id: input.supersedesReviewId,
          runId: task.runId,
          attemptId: task.attemptId,
          kind: "observation.visual.reviewed",
        },
      });
      const review = previous
        ? visualComparisonReviewSchema.parse(previous.payload)
        : undefined;
      if (
        !review ||
        review.comparisonId !== input.comparisonId ||
        review.contractDigest !== digest ||
        review.bindingIds.join() !== input.bindingIds.join()
      )
        throw new BadRequestException("COMPARISON_SUPERSESSION_INVALID");
    }
    return this.prisma.$transaction(async (tx) => {
      await this.assertLease(tx, task);
      const previous = await tx.runEvent.findFirst({
        where: {
          runId: task.runId,
          attemptId: task.attemptId,
          kind: "observation.visual.reviewed",
          payload: { path: ["deliveryId"], equals: input.deliveryId },
        },
      });
      if (previous) {
        const review = visualComparisonReviewSchema.parse({
          ...record(previous.payload),
          id: previous.id,
        });
        const {
          id: _id,
          criterionId: _criterion,
          contractDigest: _digest,
          ...oldInput
        } = review;
        if (observationDigest(oldInput) !== observationDigest(input))
          throw new ConflictException(
            "COMPARISON_REVIEW_CONFLICT: read images again for a new review.",
          );
        return review;
      }
      // One image delivery accepts one immutable review, including simultaneous
      // retries handled by different API processes. The event PK is the arbiter.
      const reviewKey = observationDigest([task.attemptId, input.deliveryId]);
      const reviewId = `${reviewKey.slice(0, 8)}-${reviewKey.slice(8, 12)}-4${reviewKey.slice(13, 16)}-a${reviewKey.slice(17, 20)}-${reviewKey.slice(20, 32)}`;
      const review: VisualComparisonReview = {
        ...input,
        id: reviewId,
        criterionId: criterion.id,
        contractDigest: digest,
      };
      await tx.runEvent.createMany({
        data: [
          {
            id: review.id,
            teamId: snapshot.teamId,
            runId: task.runId,
            attemptId: task.attemptId,
            taskId: task.id,
            actor: "AGENT_RUNTIME",
            kind: "observation.visual.reviewed",
            payload: json(review),
          },
        ],
        skipDuplicates: true,
      });
      const saved = await tx.runEvent.findFirst({
        where: {
          id: review.id,
          runId: task.runId,
          attemptId: task.attemptId,
          kind: "observation.visual.reviewed",
        },
      });
      if (
        !saved ||
        observationDigest(saved.payload) !== observationDigest(review)
      )
        throw new ConflictException(
          "COMPARISON_REVIEW_CONFLICT: read images again for a new review.",
        );
      return visualComparisonReviewSchema.parse(saved.payload);
    });
  }

  async validate(
    task: Pick<AgentRuntimeTask, "runId" | "attemptId" | "snapshot">,
    results: Array<{
      criterionId: string;
      status: string;
      bindingIds?: string[] | undefined;
      comparisonReviewIds?: string[] | undefined;
    }>,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const snapshot = runtimeTaskSnapshotSchema.parse(task.snapshot);
    if (!snapshot.criteria.some((c) => c.observationContract)) return;
    const bindings = await this.all(task, tx);
    const events = await tx.runEvent.findMany({
      where: {
        runId: task.runId,
        attemptId: task.attemptId,
        kind: {
          in: ["observation.visual.reviewed", "observation.model.delivered"],
        },
      },
    });
    const reviews = events
      .filter((e) => e.kind === "observation.visual.reviewed")
      .map((e) =>
        visualComparisonReviewSchema.parse({ ...record(e.payload), id: e.id }),
      );
    const delivered = new Set(
      events
        .filter((e) => e.kind === "observation.model.delivered")
        .flatMap(
          (e) => (record(e.payload).bindingIds as string[] | undefined) ?? [],
        ),
    );
    for (const result of results) {
      const criterion = snapshot.criteria.find(
        (c) => c.id === result.criterionId,
      );
      if (!criterion?.observationContract) continue;
      const bindingIds = result.bindingIds ?? [];
      if (bindingIds.some((id) => !delivered.has(id)))
        throw new BadRequestException("BINDING_NOT_DELIVERED");
      const error = boundCriterionError({
        contract: criterion.observationContract,
        contractDigest: observationDigest(criterion.observationContract),
        criterionId: criterion.id,
        status: result.status,
        bindingIds,
        comparisonReviewIds: result.comparisonReviewIds ?? [],
        bindings,
        reviews,
      });
      if (error)
        throw new BadRequestException({
          code: "BOUND_EVIDENCE_REQUIRED",
          message: `${criterion.id}: ${error}`,
          coverage: observationCoverage(
            criterion.observationContract,
            bindings.filter((b) => b.criterionId === criterion.id),
          ),
        });
    }
  }

  async validateReferences(
    task: Pick<AgentRuntimeTask, "runId" | "attemptId">,
    bindingIds: string[],
    reviewIds: string[],
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const bindings = await tx.runObservationBinding.count({
      where: {
        runId: task.runId,
        attemptId: task.attemptId,
        id: { in: [...new Set(bindingIds)] },
      },
    });
    const reviews = await tx.runEvent.count({
      where: {
        runId: task.runId,
        attemptId: task.attemptId,
        kind: "observation.visual.reviewed",
        id: { in: [...new Set(reviewIds)] },
      },
    });
    if (
      bindings !== new Set(bindingIds).size ||
      reviews !== new Set(reviewIds).size
    )
      throw new BadRequestException("CHECKPOINT_BINDING_NOT_AVAILABLE");
  }
}
