import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { UserBrowserProfilesService } from "./user-browser-profiles.service.js";
import { RuntimeHumanControlRelay } from "../runtime/runtime-human-control-relay.service.js";

it.each([1, 3])(
  "forwards the active Profile control generation %s through the actual input relay",
  async (controlGeneration) => {
    const current = { team: { id: randomUUID() }, user: { id: randomUUID() } };
    const profileId = randomUUID();
    const session = {
      id: randomUUID(),
      runtimeId: randomUUID(),
      fencingToken: 7n,
      leaseToken: randomUUID(),
      controlGeneration,
    };
    const send = vi.fn().mockImplementation(async (runtimeId, message) => {
      relay.acceptInputResult(runtimeId, {
        ...message,
        type: "human.input.result",
        ok: true,
      });
    });
    const relay = new RuntimeHumanControlRelay({ send } as never);
    const service = new UserBrowserProfilesService(
      {
        userBrowserProfile: {
          findFirst: vi.fn().mockResolvedValue({ id: profileId }),
        },
        browserRuntimeSession: {
          findFirst: vi.fn().mockResolvedValue(session),
        },
      } as never,
      {} as never,
      {} as never,
      relay,
      {} as never,
      {} as never,
    );
    const events = [{ type: "text" as const, text: "profile login input" }];
    await expect(
      service.input(current as never, profileId, events),
    ).resolves.toEqual({ accepted: true });
    expect(send).toHaveBeenCalledExactlyOnceWith(
      session.runtimeId,
      expect.objectContaining({
        controlGeneration,
        events,
        fencingToken: "7",
        leaseToken: session.leaseToken,
        sessionId: session.id,
        type: "human.input.dispatch",
      }),
    );
  },
);
