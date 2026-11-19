import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { maxBytes, uploadProblem } from "@/domain/upload-policy";
import { AppError } from "../http/errors";

const TTL = 300;

@Injectable()
export class StorageService {
  readonly s3: S3Client;
  readonly bucket: string;
  constructor(c: ConfigService) {
    this.bucket = c.getOrThrow<string>("S3_BUCKET");
    this.s3 = new S3Client({
      endpoint: c.getOrThrow<string>("S3_ENDPOINT"),
      region: c.get<string>("S3_REGION") ?? "auto",
      forcePathStyle: true, // MinIO; R2 accepts it too
      credentials: { accessKeyId: c.getOrThrow<string>("S3_ACCESS_KEY"), secretAccessKey: c.getOrThrow<string>("S3_SECRET_KEY") },
    });
  }

  static key(userId: string, purpose: string) {
    return `u/${userId}/${purpose}/${randomUUID()}`;
  }

  async presignPut(p: { key: string; contentType: string; size: number; purpose: string; filename?: string }) {
    const problem = uploadProblem(p); // Phase 7: one MIME/size gate for every upload flow
    if (problem)
      throw new AppError(422, "validation", problem === "too_large" ? `Files up to ${maxBytes(p.purpose) / 1048576} MB.` : "This file type is not allowed.");
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: p.key, ContentType: p.contentType, ContentLength: p.size }),
      { expiresIn: TTL },
    );
    return { url, key: p.key, expiresAt: new Date(Date.now() + TTL * 1000).toISOString() };
  }

  presignGet(key: string, filename?: string) {
    return getSignedUrl(this.s3, new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ResponseContentDisposition: filename ? `attachment; filename="${filename.replace(/["\\\r\n]/g, "_")}"` : undefined,
    }), { expiresIn: TTL });
  }

  /** null when missing. */
  async head(key: string) {
    try {
      const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: h.ContentLength ?? 0, contentType: h.ContentType ?? null, etag: h.ETag ?? null };
    } catch (e) {
      if (e instanceof Error && (e.name === "NotFound" || e.name === "NoSuchKey")) return null;
      throw e;
    }
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async putObject(key: string, body: Uint8Array | string, type: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: type }));
  }

  async getStream(key: string) {
    const o = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return o.Body as Readable;
  }

  async copy(from: string, to: string) {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${encodeURIComponent(from)}` }));
  }

  async move(from: string, to: string) {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${encodeURIComponent(from)}` }));
    await this.delete(from);
  }
}
