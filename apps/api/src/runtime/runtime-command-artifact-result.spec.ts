import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { RUNTIME_PROTOCOL } from "@devproof/runtime-protocol";
import { describe, expect, it, vi } from "vitest";

import { RuntimeCommandDispatcher } from "./runtime-command-dispatcher.service.js";
import { RuntimeGatewayService } from "./runtime-gateway.service.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture() {
  const context = {
    runtimeId: randomUUID(),
    connectionId: randomUUID(),
    connectionGeneration: 2n,
    negotiatedMinor: 14,
    capabilities: new Set(["closure-evidence-v1"]),
  };
  const session = {
    id: randomUUID(),
    runtimeId: context.runtimeId,
    teamId: randomUUID(),
    protocolMinor: 14,
    leaseToken: randomUUID(),
    fencingToken: 7n,
  };
  const command = {
    id: randomUUID(),
    commandType: "page.navigate",
    sessionId: session.id,
    leaseToken: session.leaseToken,
    fencingToken: session.fencingToken,
    status: "DISPATCHED",
    createdAt: new Date(),
    completedAt: null as Date | null,
    error: null as unknown,
    result: null as unknown,
    session,
  };
  const intents = new Set<string>();
  const artifacts: unknown[] = [];
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    browserRuntime: {
      findFirst: vi.fn().mockResolvedValue({ id: context.runtimeId }),
    },
    browserRuntimeCommand: {
      // A query result is a snapshot, not a reference changed by the timeout.
      findUnique: vi.fn(async () => structuredClone(command)),
      updateMany: vi.fn(({ where, data }) => {
        if (!where.status.in.includes(command.status)) return { count: 0 };
        Object.assign(command, data);
        return { count: 1 };
      }),
    },
    browserRuntimeArtifact: {
      createMany: vi.fn(({ data }) => {
        artifacts.push(...data);
        return { count: data.length };
      }),
    },
    objectStorageDeletionTask: {
      create: vi.fn(({ data }) => {
        intents.add(data.storageKey);
        return data;
      }),
      deleteMany: vi.fn(({ where }) => ({
        count: Number(intents.delete(where.storageKey)),
      })),
    },
  };
  // Model transaction rollback as well as commit: a lost cleanup claim must not
  // leave the preceding command CAS committed without its artifacts.
  prisma.$transaction.mockImplementation(async (operation) => {
    const before = structuredClone(command);
    const beforeIntents = [...intents];
    const beforeArtifacts = [...artifacts];
    try {
      return await operation(prisma);
    } catch (error) {
      Object.assign(command, before);
      intents.clear();
      for (const key of beforeIntents) intents.add(key);
      artifacts.splice(0, artifacts.length, ...beforeArtifacts);
      throw error;
    }
  });
  const uploaded = {
    byteSize: 5,
    sha256: "a".repeat(64),
  };
  const storage = { put: vi.fn(async () => uploaded) };
  const metrics = { increment: vi.fn(), observe: vi.fn() };
  const hub = { send: vi.fn().mockResolvedValue(undefined) };
  const dispatcher = new RuntimeCommandDispatcher(
    prisma as never,
    hub as never,
    storage as never,
    metrics as never,
  );
  const result = {
    type: "command.result" as const,
    commandId: command.id,
    sessionId: session.id,
    leaseToken: session.leaseToken,
    fencingToken: "7",
    ok: true,
    result: { title: "Loaded" },
    artifacts: [
      {
        kind: "SCREENSHOT" as const,
        contentType: "image/png",
        dataBase64: Buffer.from("image").toString("base64"),
        metadata: {},
      },
    ],
  };
  return {
    context,
    command,
    intents,
    artifacts,
    prisma,
    storage,
    metrics,
    hub,
    dispatcher,
    result,
    pauseUpload() {
      const started = barrier();
      const finish = barrier();
      storage.put.mockImplementation(async () => {
        started.release();
        await finish.promise;
        return uploaded;
      });
      return { started: started.promise, finish: finish.release };
    },
  };
}

describe("Runtime command artifact publication", () => {
  it.each(["TIMED_OUT", "CANCELLED", "SUCCEEDED", "FAILED"])(
    "preserves a %s result that wins while its artifacts upload",
    async (status) => {
      const f = fixture();
      const upload = f.pauseUpload();
      const accepting = f.dispatcher.acceptResult(f.result, f.context);
      await upload.started;
      Object.assign(f.command, {
        status,
        completedAt: new Date(),
        error: { code: "EXISTING_OUTCOME" },
        result: { winner: true },
      });
      const terminal = structuredClone(f.command);
      const cleanupKeys = [...f.intents];

      upload.finish();
      await expect(accepting).resolves.toBeUndefined();

      expect(f.command).toEqual(terminal);
      expect(cleanupKeys).toHaveLength(1);
      expect([...f.intents]).toEqual(cleanupKeys);
      expect(
        f.prisma.objectStorageDeletionTask.deleteMany,
      ).not.toHaveBeenCalled();
      expect(f.artifacts).toEqual([]);
      expect(f.metrics.increment).not.toHaveBeenCalled();
      expect(f.metrics.observe).not.toHaveBeenCalled();
    },
  );

  it("publishes a current result and consumes only its cleanup intent", async () => {
    const f = fixture();
    f.intents.add("unrelated-object");

    await f.dispatcher.acceptResult(f.result, f.context);

    expect(f.command.status).toBe("SUCCEEDED");
    expect(f.command.result).toEqual(f.result.result);
    expect(f.artifacts).toHaveLength(1);
    expect([...f.intents]).toEqual(["unrelated-object"]);
    expect(f.metrics.increment).toHaveBeenCalledWith(
      "devproof_runtime_command_results_total",
      expect.any(String),
      { status: "succeeded" },
    );
    expect(f.metrics.observe).toHaveBeenCalledOnce();
  });

  it("leaves uploaded objects reclaimable when the connection changes", async () => {
    const f = fixture();
    const upload = f.pauseUpload();
    const accepting = f.dispatcher.acceptResult(f.result, f.context);
    await upload.started;
    f.prisma.browserRuntime.findFirst.mockResolvedValue(null);

    upload.finish();
    await accepting;

    expect(f.command.status).toBe("DISPATCHED");
    expect(f.intents.size).toBe(1);
    expect(f.artifacts).toEqual([]);
    expect(f.metrics.increment).not.toHaveBeenCalled();
    expect(f.metrics.observe).not.toHaveBeenCalled();
  });

  it("rolls back the command claim and propagates a real publication conflict", async () => {
    const f = fixture();
    f.prisma.objectStorageDeletionTask.deleteMany.mockReturnValue({ count: 0 });

    await expect(
      f.dispatcher.acceptResult(f.result, f.context),
    ).rejects.toMatchObject({ status: 409 });

    expect(f.command.status).toBe("DISPATCHED");
    expect(f.command.completedAt).toBeNull();
    expect(f.intents.size).toBe(1);
    expect(f.artifacts).toEqual([]);
    expect(f.metrics.increment).not.toHaveBeenCalled();
    expect(f.metrics.observe).not.toHaveBeenCalled();
  });

  it("propagates upload failures without consuming their cleanup intents", async () => {
    const f = fixture();
    const failure = new Error("Object storage unavailable");
    f.storage.put.mockRejectedValue(failure);

    await expect(f.dispatcher.acceptResult(f.result, f.context)).rejects.toBe(
      failure,
    );

    expect(f.command.status).toBe("DISPATCHED");
    expect(f.intents.size).toBe(1);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.metrics.increment).not.toHaveBeenCalled();
    expect(f.metrics.observe).not.toHaveBeenCalled();
  });

  it("acknowledges a superseded result without disconnecting its Runtime", async () => {
    const f = fixture();
    const upload = f.pauseUpload();
    const socket = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      send: vi.fn(),
    });
    const gateway = new RuntimeGatewayService(
      f.prisma as never,
      {} as never,
      f.hub as never,
      f.dispatcher,
      {} as never,
    );
    // Keep the real message queue, result processing, ACK and error-close paths.
    Reflect.set(gateway, "handleHello", vi.fn().mockResolvedValue(f.context));
    Reflect.set(
      gateway,
      "isCurrentConnection",
      vi.fn().mockResolvedValue(true),
    );
    gateway.accept(socket as never);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "runtime.hello",
          runtimeId: f.context.runtimeId,
          runtimeToken: "test-only-credential".repeat(2),
          instanceNonce: randomUUID(),
          protocol: RUNTIME_PROTOCOL,
          sentAt: new Date().toISOString(),
        }),
      ),
    );
    socket.emit("message", Buffer.from(JSON.stringify(f.result)));
    await upload.started;
    f.command.status = "TIMED_OUT";

    upload.finish();
    await vi.waitFor(() =>
      expect(f.hub.send).toHaveBeenCalledWith(
        f.context.runtimeId,
        {
          type: "runtime.delivery.ack",
          messageType: "command.result",
          messageId: f.command.id,
        },
        f.context.connectionGeneration,
      ),
    );

    expect(socket.close).not.toHaveBeenCalled();
    expect(f.command.status).toBe("TIMED_OUT");
    expect(f.intents.size).toBe(1);
    expect(f.artifacts).toEqual([]);
    expect(f.metrics.increment).not.toHaveBeenCalled();
  });
});
