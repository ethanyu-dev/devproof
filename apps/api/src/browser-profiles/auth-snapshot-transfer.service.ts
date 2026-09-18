import { createHash, randomUUID } from "node:crypto";
import {
  Injectable,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { ObjectStorageService } from "../infrastructure/object-storage.service.js";
import { acquireAdvisoryTransactionLock } from "../database/advisory-lock.js";

export function snapshotDistributionEnabled() {
  return process.env.BROWSER_AUTH_SNAPSHOT_DISTRIBUTION_ENABLED === "true";
}

@Injectable()
export class AuthSnapshotTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorageService,
  ) {}

  private async authorize(
    runtimeId: string,
    token: string | undefined,
    sessionId: string,
    upload: boolean,
  ) {
    if (!snapshotDistributionEnabled() || !token?.startsWith("Bearer "))
      throw new ForbiddenException();
    const runtime = await this.prisma.browserRuntime.findFirst({
      where: {
        id: runtimeId,
        tokenHash: createHash("sha256").update(token.slice(7)).digest("hex"),
        enabled: true,
        revokedAt: null,
        drainState: "NONE",
      },
    });
    if (!runtime || (runtime.protocolMinor ?? 0) < 19)
      throw new ForbiddenException();
    const session = await this.prisma.browserRuntimeSession.findFirst({
      where: {
        id: sessionId,
        runtimeId,
        teamId: runtime.teamId,
        status: {
          in: upload
            ? ["HUMAN_CONTROL"]
            : ["OPENING", "ACTIVE", "HUMAN_CONTROL"],
        },
        leaseExpiresAt: { gt: new Date() },
        quarantinedAt: null,
        closureVerifiedAt: null,
        ...(!upload ? { executionPermitExpiresAt: { gt: new Date() } } : {}),
      },
      include: {
        userBrowserProfile: {
          include: { owner: { include: { memberships: true } } },
        },
      },
    });
    const profile = session?.userBrowserProfile;
    if (
      !session ||
      !profile ||
      profile.teamId !== runtime.teamId ||
      profile.owner.status !== "ACTIVE" ||
      !profile.owner.memberships.some((m) => m.teamId === runtime.teamId)
    )
      throw new ForbiddenException();
    if (upload) {
      if (
        session.purpose !== "PROFILE_PREPARATION" &&
        session.purpose !== "PROFILE_VERIFICATION"
      )
        throw new ForbiddenException();
      if (
        profile.status !== "VERIFYING" ||
        profile.assignedRuntimeId !== runtimeId ||
        session.humanControllerUserId !== profile.ownerUserId ||
        !session.humanControlExpiresAt ||
        session.humanControlExpiresAt <= new Date()
      )
        throw new ForbiddenException();
    } else if (
      session.purpose !== "EXECUTION" ||
      profile.status !== "READY" ||
      profile.executionMode !== "ISOLATED_AUTH" ||
      !profile.inactivityExpiresAt ||
      profile.inactivityExpiresAt <= new Date() ||
      !session.authSnapshotGeneration
    )
      throw new ForbiddenException();
    return { session, profile };
  }

  async upload(
    runtimeId: string,
    token: string | undefined,
    sessionId: string,
    generation: number,
    envelope: string,
  ) {
    const { profile } = await this.authorize(runtimeId, token, sessionId, true);
    if (profile.version !== generation)
      throw new ConflictException("Snapshot publication was superseded.");
    const body = Buffer.from(envelope);
    const checksum = createHash("sha256").update(body).digest("hex");
    // A crash after writing the row remains recoverable by the snapshot collector.
    const reserved = await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, `browser-profile:${profile.id}`);
      const current = await tx.userBrowserProfile.findUniqueOrThrow({
        where: { id: profile.id },
      });
      if (current.status !== "VERIFYING" || current.version !== generation)
        throw new ConflictException("Snapshot publication was superseded.");
      const existing = await tx.browserAuthSnapshot.findUnique({
        where: { profileId_generation: { profileId: profile.id, generation } },
      });
      if (existing) {
        if (existing.deletedAt)
          throw new ConflictException("Snapshot publication was deleted.");
        if (existing.checksum !== checksum)
          throw new ConflictException("Snapshot generations are immutable.");
        return existing;
      }
      const storageKey = `auth-snapshots/${profile.teamId}/${randomUUID()}`;
      return tx.browserAuthSnapshot.create({
        data: {
          profileId: profile.id,
          teamId: profile.teamId,
          generation,
          storageKey,
          checksum,
        },
      });
    });
    if (!reserved.uploadedAt) {
      try {
        await this.storage.put(
          reserved.storageKey,
          "application/octet-stream",
          body,
          {},
        );
        const authorized = await this.authorize(
          runtimeId,
          token,
          sessionId,
          true,
        );
        if (authorized.profile.version !== generation)
          throw new ConflictException("Snapshot publication was superseded.");
        await this.prisma.$transaction(async (tx) => {
          await acquireAdvisoryTransactionLock(
            tx,
            `browser-profile:${profile.id}`,
          );
          const current = await tx.browserAuthSnapshot.findUniqueOrThrow({
            where: { id: reserved.id },
          });
          if (current.deletedAt)
            throw new ConflictException("Snapshot publication was deleted.");
          await tx.browserAuthSnapshot.update({
            where: { id: reserved.id },
            data: { uploadedAt: new Date() },
          });
        });
      } catch (error) {
        // Deletion can win while S3 is writing. Compensate a late write, retaining
        // the durable tombstone even if this process dies or deletion fails.
        await this.cleanupDeletedSnapshot(reserved.id).catch(() => undefined);
        throw error;
      }
    }
    return { generation };
  }

  async download(
    runtimeId: string,
    token: string | undefined,
    sessionId: string,
  ) {
    const { session, profile } = await this.authorize(
      runtimeId,
      token,
      sessionId,
      false,
    );
    const snapshot = await this.prisma.browserAuthSnapshot.findUnique({
      where: {
        profileId_generation: {
          profileId: profile.id,
          generation: session.authSnapshotGeneration!,
        },
      },
    });
    if (!snapshot?.uploadedAt || snapshot.deletedAt)
      throw new NotFoundException("Authentication snapshot is unavailable.");
    const object = await this.storage.get(snapshot.storageKey);
    if (
      createHash("sha256").update(object.body).digest("hex") !==
      snapshot.checksum
    )
      throw new ConflictException(
        "Authentication snapshot integrity check failed.",
      );
    return {
      envelope: object.body.toString(),
      profileKey: profile.runtimeProfileKey,
      generation: snapshot.generation,
    };
  }

  private async cleanupDeletedSnapshot(id: string) {
    const snapshot = await this.prisma.browserAuthSnapshot.findUnique({
      where: { id },
    });
    if (snapshot?.deletedAt) await this.storage.delete(snapshot.storageKey);
    // Never erase a deletion tombstone: a crashed process or a timed-out PUT can
    // still complete later. The collector repeats deletion without losing its key.
  }

  async purgeProfile(profileId: string) {
    const snapshots = await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, `browser-profile:${profileId}`);
      const profile = await tx.userBrowserProfile.findUnique({
        where: { id: profileId },
      });
      if (profile && profile.status !== "DISABLED")
        throw new ConflictException(
          "Disable the identity before deleting snapshots.",
        );
      if (
        await tx.browserRuntimeSession.count({
          where: {
            userBrowserProfileId: profileId,
            closureVerifiedAt: null,
            status: { not: "CLOSED" },
          },
        })
      )
        throw new ConflictException(
          "Browser sessions must close before deleting snapshots.",
        );
      await tx.browserAuthSnapshot.updateMany({
        where: { profileId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      return tx.browserAuthSnapshot.findMany({ where: { profileId } });
    });
    // Commit the tombstone before touching external storage.
    for (const snapshot of snapshots)
      await this.cleanupDeletedSnapshot(snapshot.id);
  }

  /** Preserve live generations; never rely on FK cascading for physical deletion. */
  async collect() {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.browserAuthSnapshot.findMany({
        where: {
          ...(cursor ? { id: { gt: cursor } } : {}),
          OR: [
            { deletedAt: { not: null } },
            { createdAt: { lt: new Date(Date.now() - 60 * 60 * 1000) } },
          ],
        },
        orderBy: { id: "asc" },
        take: 200,
      });
      if (!rows.length) break;
      cursor = rows.at(-1)!.id;
      for (const row of rows) {
        await this.prisma.$transaction(
          async (tx) => {
            await acquireAdvisoryTransactionLock(
              tx,
              `browser-profile:${row.profileId}`,
            );
            const current = await tx.browserAuthSnapshot.findUnique({
              where: { id: row.id },
            });
            if (!current || current.deletedAt) return;
            const profile = await tx.userBrowserProfile.findUnique({
              where: { id: row.profileId },
              include: { owner: { include: { memberships: true } } },
            });
            if (
              profile &&
              profile.inactivityExpiresAt &&
              profile.inactivityExpiresAt > new Date() &&
              profile.owner.status === "ACTIVE" &&
              profile.owner.memberships.some(
                (m) => m.teamId === profile.teamId,
              ) &&
              (profile.authSnapshotGeneration === row.generation ||
                (profile.status === "VERIFYING" &&
                  profile.version === row.generation))
            )
              return;
            if (
              await tx.browserRuntimeSession.count({
                where: {
                  userBrowserProfileId: row.profileId,
                  authSnapshotGeneration: row.generation,
                  closureVerifiedAt: null,
                  status: { not: "CLOSED" },
                },
              })
            )
              return;
            await tx.browserAuthSnapshot.update({
              where: { id: row.id },
              data: { deletedAt: new Date() },
            });
          },
          { timeout: 30_000 },
        );
        await this.cleanupDeletedSnapshot(row.id);
      }
    }
  }
}
