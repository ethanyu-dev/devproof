import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { env } from "../config/env.js";

@Injectable()
export class CredentialCipherService {
  private readonly key: Buffer;

  constructor() {
    this.key = Buffer.from(env().CREDENTIAL_ENCRYPTION_KEY, "base64");
    if (this.key.length !== 32) {
      throw new Error(
        "CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64.",
      );
    }
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ["v1", iv, tag, ciphertext]
      .map((part) =>
        typeof part === "string" ? part : part.toString("base64"),
      )
      .join(".");
  }

  decrypt(envelope: string): string {
    const [version, ivValue, tagValue, ciphertextValue] = envelope.split(".");
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
      throw new Error("Unsupported credential envelope.");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(ivValue, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  hint(value: string): string {
    return value.length <= 4 ? "••••" : "••••" + value.slice(-4);
  }
}
