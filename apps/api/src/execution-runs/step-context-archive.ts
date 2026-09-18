import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { stepContextArchiveSchema } from "@devproof/agent-runtime-protocol";

export function decodeStepContext(value: unknown) {
  try {
    const archive = stepContextArchiveSchema.parse(value);
    const compressed = Buffer.from(archive.data, "base64");
    const bytes = gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 });
    if (
      bytes.length !== archive.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== archive.sha256
    )
      throw new Error("Archive checksum mismatch");
    const body = JSON.parse(bytes.toString("utf8"));
    if (
      !body?.request ||
      !Array.isArray(body.request.messages) ||
      !Array.isArray(body.request.tools)
    )
      throw new Error("A complete model request is required");
    return { archive, compressed, body };
  } catch {
    throw new BadRequestException(
      "Invalid or incomplete step context archive.",
    );
  }
}

export function readStepContext(bytes: Uint8Array) {
  return JSON.parse(
    gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8"),
  ) as {
    request: Record<string, unknown> & {
      messages: unknown[];
      tools: unknown[];
    };
    metrics: Record<string, unknown>;
    redactedPaths?: string[];
  };
}
