import { describe, expect, it, vi } from "vitest";
import { VerificationService } from "./verification.service.js";

const current = { team: { id: "team-1" } } as never;

describe("read-only verification history", () => {
  it("keeps signed artifact access and serializable event cursors", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "history-1",
      artifacts: [
        { id: "artifact-1", storageKey: "evidence/screenshot" },
        { id: "artifact-2", storageKey: null },
      ],
      events: [{ sequence: 9007199254740993n, kind: "completed" }],
    });
    const signedDownloadUrl = vi
      .fn()
      .mockResolvedValue("https://storage.example/signed");
    const service = new VerificationService(
      { verificationRun: { findFirst } } as never,
      { signedDownloadUrl } as never,
    );
    const result = await service.detail(current, "history-1");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "history-1", teamId: "team-1" } }),
    );
    expect(result.events[0].sequence).toBe("9007199254740993");
    expect(result.artifacts).toMatchObject([
      {
        evidenceRef: "artifact://artifact-1",
        downloadUrl: "https://storage.example/signed",
      },
      { evidenceRef: "artifact://artifact-2", downloadUrl: null },
    ]);
    expect(signedDownloadUrl).toHaveBeenCalledExactlyOnceWith(
      "evidence/screenshot",
    );
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("checks ownership before reading historical events", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const findMany = vi.fn();
    const service = new VerificationService(
      {
        verificationRun: { findFirst },
        verificationEvent: { findMany },
      } as never,
      {} as never,
    );
    await expect(
      service.events(current, "other-team-history", 12n),
    ).rejects.toThrow("not found");
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "other-team-history", teamId: "team-1" },
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});
