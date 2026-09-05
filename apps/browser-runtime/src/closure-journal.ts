import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { BrowserProcessIdentity } from "./browser-processes.js";

import {
  runtimeClosureEvidenceSchema,
  runtimeCommandResultSchema,
  type RuntimeClosureEvidence,
  type RuntimeClosureRecovery,
} from "@devproof/runtime-protocol";

const execute = promisify(execFile);
const daemonInstanceId = randomUUID();
export interface RuntimeProcessIdentity {
  hostInstanceId: string;
  daemonInstanceId: string;
}
export interface BrowserLaunchIdentity extends RuntimeProcessIdentity {
  version: 1;
  id: string;
  marker: string;
}
interface SessionEpoch {
  sessionId: string;
  leaseToken: string;
  fencingToken: string;
}
interface ClosureRecord extends SessionEpoch {
  version: 1;
  revokedAt?: string;
  launch?: BrowserLaunchIdentity;
  processIdentity?: BrowserProcessIdentity;
  closed?: {
    method: RuntimeClosureEvidence["method"];
    completedAt: string;
  };
  evidence: RuntimeClosureEvidence[];
}
type CommandResult = ReturnType<typeof runtimeCommandResultSchema.parse>;

export function closureError(code: string, message: string) {
  return Object.assign(new Error(message), { code, retryable: false });
}

let processIdentity: Promise<RuntimeProcessIdentity> | undefined;
/** A boot + PID namespace identifies the process scope; copied state is not a host ID. */
export function runtimeProcessIdentity(): Promise<RuntimeProcessIdentity> {
  processIdentity ??= (async () => {
    let scope: string;
    if (process.platform === "linux") {
      const [boot, namespace] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readlink("/proc/self/ns/pid"),
      ]);
      scope = `linux:${boot.trim()}:${namespace}`;
    } else if (process.platform === "darwin") {
      const { stdout } = await execute("/usr/sbin/sysctl", [
        "-n",
        "kern.bootsessionuuid",
      ]);
      if (!stdout.trim())
        throw closureError(
          "CLOSURE_UNVERIFIED",
          "Host boot identity is unavailable.",
        );
      scope = `darwin:${stdout.trim()}`;
    } else {
      throw closureError(
        "CLOSURE_UNVERIFIED",
        "This platform has no supported process-scope identity.",
      );
    }
    return {
      hostInstanceId: createHash("sha256").update(scope).digest("hex"),
      daemonInstanceId,
    };
  })();
  return processIdentity;
}

/** fsync the content and its containing directory before a success may be sent. */
export async function durableJsonWrite(path: string, value: unknown) {
  const parent = dirname(path);
  const created = await mkdir(parent, { recursive: true, mode: 0o700 });
  const syncDirectory = async (directoryPath: string) => {
    const directory = await open(directoryPath, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  if (created) {
    // Persist the new directories' links too, including closure/ itself on the
    // first launch; syncing only the file's immediate directory is insufficient.
    const existingParent = dirname(created);
    for (let directory = parent; ; directory = dirname(directory)) {
      await syncDirectory(directory);
      if (directory === existingParent || dirname(directory) === directory)
        break;
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncDirectory(parent);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Never evicts closure tombstones. Delivery acknowledgement removes only the outbox copy. */
export class SessionClosureJournal {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.catch(() => undefined).then(operation);
    this.pending = next;
    return next;
  }

  private sessionPath(sessionId: string) {
    if (!/^[a-f\d-]{36}$/iu.test(sessionId))
      throw closureError("CLOSURE_UNVERIFIED", "Invalid session identity.");
    return join(this.root, "sessions", `${sessionId}.json`);
  }

  async read(sessionId: string): Promise<ClosureRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.sessionPath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value = JSON.parse(raw) as ClosureRecord;
    if (
      value.version !== 1 ||
      value.sessionId !== sessionId ||
      typeof value.leaseToken !== "string" ||
      typeof value.fencingToken !== "string" ||
      !Array.isArray(value.evidence) ||
      (value.launch &&
        (value.launch.version !== 1 ||
          typeof value.launch.id !== "string" ||
          typeof value.launch.hostInstanceId !== "string" ||
          typeof value.launch.marker !== "string"))
    )
      throw closureError(
        "CLOSURE_UNVERIFIED",
        "The local closure journal is invalid.",
      );
    value.evidence = value.evidence.map((item) =>
      runtimeClosureEvidenceSchema.parse(item),
    );
    return value;
  }

  private assertEpoch(record: SessionEpoch, epoch: SessionEpoch) {
    if (
      record.sessionId !== epoch.sessionId ||
      record.leaseToken !== epoch.leaseToken ||
      record.fencingToken !== epoch.fencingToken
    )
      throw closureError(
        "SESSION_LOST",
        "Closure evidence belongs to a different session epoch.",
      );
  }

  async assertCanLaunch(epoch: SessionEpoch) {
    const existing = await this.read(epoch.sessionId);
    if (!existing) return;
    this.assertEpoch(existing, epoch);
    if (existing.revokedAt || existing.closed)
      throw closureError(
        "SESSION_PERMIT_EXPIRED",
        "A durably revoked session cannot launch again.",
      );
    // A launch record surviving a daemon restart describes a possibly live process.
    throw closureError(
      "CLOSURE_UNVERIFIED",
      "An earlier launch must be closed before opening this session.",
    );
  }

  recordLaunch(
    epoch: SessionEpoch,
    identity: RuntimeProcessIdentity,
    marker: string,
    launchIdentityId?: string,
  ) {
    return this.serialize(async () => {
      await this.assertCanLaunch(epoch);
      const launch: BrowserLaunchIdentity = {
        ...identity,
        version: 1,
        id: launchIdentityId ?? randomUUID(),
        marker,
      };
      await durableJsonWrite(this.sessionPath(epoch.sessionId), {
        sessionId: epoch.sessionId,
        leaseToken: epoch.leaseToken,
        fencingToken: epoch.fencingToken,
        version: 1,
        launch,
        evidence: [],
      });
      return launch;
    });
  }

  revoke(epoch: SessionEpoch) {
    return this.serialize(async () => {
      const record = (await this.read(epoch.sessionId)) ?? {
        sessionId: epoch.sessionId,
        leaseToken: epoch.leaseToken,
        fencingToken: epoch.fencingToken,
        version: 1 as const,
        evidence: [],
      };
      this.assertEpoch(record, epoch);
      record.revokedAt ??= new Date().toISOString();
      await durableJsonWrite(this.sessionPath(epoch.sessionId), record);
    });
  }

  attachProcess(epoch: SessionEpoch, processIdentity: BrowserProcessIdentity) {
    return this.serialize(async () => {
      const record = await this.read(epoch.sessionId);
      if (!record?.launch || record.closed)
        throw closureError(
          "SESSION_PERMIT_EXPIRED",
          "A closed launch cannot acquire another process.",
        );
      this.assertEpoch(record, epoch);
      record.processIdentity = processIdentity;
      await durableJsonWrite(this.sessionPath(epoch.sessionId), record);
    });
  }

  /** The same daemon waited for its own launch task to stop before it could spawn. */
  recordAbortedLaunch(
    epoch: SessionEpoch,
    identity: RuntimeProcessIdentity,
    marker: string,
    launchIdentityId?: string,
  ) {
    return this.serialize(async () => {
      const record = await this.read(epoch.sessionId);
      if (!record?.revokedAt || record.launch) return;
      this.assertEpoch(record, epoch);
      record.launch = {
        ...identity,
        version: 1,
        id: launchIdentityId ?? randomUUID(),
        marker,
      };
      record.closed = {
        method: "IDENTIFIED_PROCESS_SET_TERMINATED",
        completedAt: new Date().toISOString(),
      };
      await durableJsonWrite(this.sessionPath(epoch.sessionId), record);
    });
  }

  /** Only the physical close path calls this, after process termination and network revocation. */
  complete(
    epoch: SessionEpoch,
    identity: RuntimeProcessIdentity,
    method: RuntimeClosureEvidence["method"],
  ) {
    return this.serialize(async () => {
      const record = await this.read(epoch.sessionId);
      if (
        !record?.launch ||
        record.launch.hostInstanceId !== identity.hostInstanceId ||
        !record.revokedAt
      )
        throw closureError(
          "CLOSURE_UNVERIFIED",
          "No durable launch scope and revocation exist on this host.",
        );
      this.assertEpoch(record, epoch);
      record.closed ??= { method, completedAt: new Date().toISOString() };
      await durableJsonWrite(this.sessionPath(epoch.sessionId), record);
    });
  }

  evidence(request: RuntimeClosureRecovery, identity: RuntimeProcessIdentity) {
    return this.serialize(async () => {
      const record = await this.read(request.sessionId);
      if (
        !record?.closed ||
        !record.launch ||
        record.launch.hostInstanceId !== identity.hostInstanceId
      )
        throw closureError(
          "CLOSURE_UNVERIFIED",
          "No verified closure tombstone exists on this host.",
        );
      this.assertEpoch(record, {
        sessionId: request.sessionId,
        leaseToken: request.expectedLeaseToken,
        fencingToken: request.expectedFencingToken,
      });
      if (
        request.expectedLaunchIdentity &&
        request.expectedLaunchIdentity !== record.launch.id
      )
        throw closureError(
          "SESSION_LOST",
          "The closure challenge targets a different launch.",
        );
      const previous = record.evidence.find(
        (row) =>
          row.requestId === request.requestId &&
          row.daemonInstanceId === identity.daemonInstanceId,
      );
      if (previous) {
        if (previous.recoveryId !== request.recoveryId)
          throw closureError(
            "SESSION_LOST",
            "A closure challenge was reused for another recovery.",
          );
        return previous;
      }
      const proof = runtimeClosureEvidenceSchema.parse({
        evidenceId: randomUUID(),
        recoveryId: request.recoveryId,
        requestId: request.requestId,
        sessionId: record.sessionId,
        leaseToken: record.leaseToken,
        fencingToken: record.fencingToken,
        ...identity,
        launchIdentityVersion: 1,
        method: record.closed.method,
        networkRevoked: true,
        closureCompletedAt: record.closed.completedAt,
      });
      record.evidence.push(proof);
      await durableJsonWrite(this.sessionPath(request.sessionId), record);
      return proof;
    });
  }

  async queueResult(result: CommandResult) {
    runtimeClosureEvidenceSchema.parse(result.result?.closureEvidence);
    await durableJsonWrite(
      join(this.root, "outbox", `${result.commandId}.json`),
      result,
    );
  }

  async pendingResults(identity: RuntimeProcessIdentity) {
    let files: string[];
    try {
      files = await readdir(join(this.root, "outbox"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const results: CommandResult[] = [];
    for (const file of files.filter((name) =>
      /^[a-f\d-]{36}\.json$/iu.test(name),
    )) {
      const result = runtimeCommandResultSchema.parse(
        JSON.parse(await readFile(join(this.root, "outbox", file), "utf8")),
      );
      const proof = runtimeClosureEvidenceSchema.parse(
        result.result?.closureEvidence,
      );
      // A different daemon must answer a new authenticated challenge from its tombstone.
      if (
        proof.hostInstanceId === identity.hostInstanceId &&
        proof.daemonInstanceId === identity.daemonInstanceId
      )
        results.push(result);
    }
    return results;
  }

  async acknowledge(commandId: string) {
    if (!/^[a-f\d-]{36}$/iu.test(commandId)) return;
    await rm(join(this.root, "outbox", `${commandId}.json`), { force: true });
  }
}
