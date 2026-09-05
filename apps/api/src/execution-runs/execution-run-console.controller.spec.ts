import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ExecutionRunConsoleController } from "./execution-run-console.controller.js";

describe("authenticated evidence streaming", () => {
  it.each([false, true])(
    "streams evidence with correct headers (range=%s)",
    async (partial) => {
      const body = Readable.from([Buffer.from("video")]);
      const downloadEvidence = vi.fn().mockResolvedValue({
        body,
        contentLength: 5,
        contentType: "video/webm",
        ...(partial ? { contentRange: "bytes 5-9/10" } : {}),
      });
      const controller = new ExecutionRunConsoleController({
        downloadEvidence,
      } as never);
      const reply = {
        header: vi.fn().mockReturnThis(),
        type: vi.fn().mockReturnThis(),
        code: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };
      const current = {
        user: { id: "user", name: "User" },
        team: { id: "team" },
      };
      await controller.downloadEvidence(
        current as never,
        "run",
        "evidence",
        reply as never,
        partial ? "bytes=5-9" : undefined,
      );
      expect(downloadEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ team: { id: "team" } }),
        "run",
        "evidence",
        partial ? "bytes=5-9" : undefined,
      );
      expect(reply.header).toHaveBeenCalledWith(
        "cache-control",
        "private, no-store",
      );
      expect(reply.header).toHaveBeenCalledWith("accept-ranges", "bytes");
      expect(reply.send).toHaveBeenCalledWith(body);
      if (partial) {
        expect(reply.code).toHaveBeenCalledWith(206);
        expect(reply.header).toHaveBeenCalledWith(
          "content-range",
          "bytes 5-9/10",
        );
      } else expect(reply.code).not.toHaveBeenCalled();
    },
  );
});
