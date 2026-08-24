import { createHash } from "node:crypto";

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";

import { env } from "../config/env.js";

@Injectable()
export class ObjectStorageService implements OnModuleInit {
  private readonly config = env();
  private readonly client = new S3Client({
    credentials: {
      accessKeyId: this.config.OBJECT_STORAGE_ACCESS_KEY,
      secretAccessKey: this.config.OBJECT_STORAGE_SECRET_KEY,
    },
    endpoint: this.config.OBJECT_STORAGE_ENDPOINT,
    forcePathStyle: this.config.OBJECT_STORAGE_FORCE_PATH_STYLE,
    region: this.config.OBJECT_STORAGE_REGION,
  });

  async onModuleInit() {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET }),
      );
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status !== 404) {
        throw error;
      }
      await this.client.send(
        new CreateBucketCommand({
          Bucket: this.config.OBJECT_STORAGE_BUCKET,
          ...(["auto", "us-east-1"].includes(this.config.OBJECT_STORAGE_REGION)
            ? {}
            : {
                CreateBucketConfiguration: {
                  LocationConstraint: this.config
                    .OBJECT_STORAGE_REGION as BucketLocationConstraint,
                },
              }),
        }),
      );
    }
  }

  async put(
    storageKey: string,
    contentType: string,
    body: Buffer,
    metadata: Record<string, string>,
  ) {
    const sha256 = createHash("sha256").update(body).digest("hex");
    await this.client.send(
      new PutObjectCommand({
        Body: body,
        Bucket: this.config.OBJECT_STORAGE_BUCKET,
        ContentType: contentType,
        Key: storageKey,
        Metadata: { ...metadata, sha256 },
      }),
    );
    return { byteSize: body.byteLength, sha256 };
  }

  async get(storageKey: string, range?: { end: number; start: number }) {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.config.OBJECT_STORAGE_BUCKET,
        Key: storageKey,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
    );
    if (!response.Body) throw new Error("Artifact body is unavailable.");
    const bytes = await response.Body.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: response.ContentType ?? "application/octet-stream",
    };
  }

  signedDownloadUrl(storageKey: string, expiresIn = 300) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.config.OBJECT_STORAGE_BUCKET,
        Key: storageKey,
      }),
      { expiresIn },
    );
  }

  async check(signal?: AbortSignal) {
    await this.client.send(
      new HeadBucketCommand({ Bucket: this.config.OBJECT_STORAGE_BUCKET }),
      signal ? { abortSignal: signal } : undefined,
    );
    return true;
  }

  async delete(storageKey: string) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.OBJECT_STORAGE_BUCKET,
        Key: storageKey,
      }),
    );
  }
}
