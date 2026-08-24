import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { redirectFound } from "./auth.controller.js";

describe("authentication redirects", () => {
  it("uses a redirect status instead of a successful empty response", () => {
    const redirect = vi.fn().mockReturnValue("redirected");
    const status = vi.fn().mockReturnValue({ redirect });
    const reply = { status } as unknown as FastifyReply;

    expect(redirectFound(reply, "https://accounts.feishu.cn/example")).toBe(
      "redirected",
    );
    expect(status).toHaveBeenCalledWith(302);
    expect(redirect).toHaveBeenCalledWith("https://accounts.feishu.cn/example");
  });
});
