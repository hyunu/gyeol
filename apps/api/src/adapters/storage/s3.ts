import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import type { ObjectStorage } from "../../ports/store.ts";

/**
 * S3 호환 오브젝트 스토리지 어댑터 (ADR-0008).
 *
 * 포트 의미(오프셋 일치, 크기·SHA-256 반환)는 LocalDiskStorage 와 같다.
 * S3 는 객체 append 가 없으므로 청크를 임시 객체로 저장하고, commit 에서
 * 순서대로 읽어 multipart upload 로 최종 객체를 만든다.
 *
 *   _sessions/<sessionId>/<offset(12자리)>  ← 청크 임시 객체
 *   <destinationKey>                        ← 최종 객체
 */
export class S3Storage implements ObjectStorage {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private ready: Promise<void> | null = null;

  constructor(options: { bucket?: string; client?: S3Client } = {}) {
    const bucket = options.bucket ?? process.env.S3_BUCKET ?? "gyeol";
    this.bucket = bucket;
    this.client =
      options.client ??
      new S3Client({
        region: process.env.S3_REGION ?? "us-east-1",
        endpoint: process.env.S3_ENDPOINT,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
        credentials: process.env.S3_ACCESS_KEY_ID
          ? {
              accessKeyId: process.env.S3_ACCESS_KEY_ID,
              secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
            }
          : undefined,
      });
  }

  private async ensureBucket(): Promise<void> {
    this.ready ??= (async () => {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      }
    })();
    try {
      await this.ready;
    } catch (err) {
      this.ready = null;
      throw err;
    }
  }

  private chunkKey(sessionId: string, offset: number): string {
    return `_sessions/${sessionId}/${String(offset).padStart(12, "0")}`;
  }

  async startSession(sessionId: string): Promise<void> {
    await this.ensureBucket();
    // 재전송 세션은 다시 시작할 수 있다. 이전 청크가 남아 있으면 지운다.
    await this.deletePrefix(`_sessions/${sessionId}/`);
  }

  async appendChunk(sessionId: string, offset: number, chunk: Buffer): Promise<number> {
    await this.ensureBucket();
    const current = await this.sessionSize(sessionId);
    if (current !== offset) {
      throw new Error(`offset mismatch: stored=${current} offset=${offset}`);
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.chunkKey(sessionId, offset),
        Body: chunk,
      }),
    );
    return offset + chunk.length;
  }

  async commitSession(
    sessionId: string,
    destinationKey: string,
  ): Promise<{ size: number; sha256: string }> {
    await this.ensureBucket();
    const parts = await this.listPrefix(`_sessions/${sessionId}/`);
    if (parts.length === 0) throw new Error(`업로드 세션에 청크가 없습니다: ${sessionId}`);

    const hash = createHash("sha256");
    let size = 0;
    const upload = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: destinationKey }),
    );
    if (!upload.UploadId) throw new Error("multipart upload id 를 받지 못했습니다.");

    try {
      const completed: Array<{ ETag: string; PartNumber: number }> = [];
      let buffer: Buffer[] = [];
      let buffered = 0;
      let partNumber = 1;

      const flush = async () => {
        if (buffered === 0) return;
        const body = Buffer.concat(buffer, buffered);
        const result = await this.client.send(
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: destinationKey,
            UploadId: upload.UploadId,
            PartNumber: partNumber,
            Body: body,
          }),
        );
        completed.push({ ETag: result.ETag as string, PartNumber: partNumber });
        partNumber += 1;
        buffer = [];
        buffered = 0;
      };

      for (const part of parts) {
        const key = part.Key as string;
        const offset = Number(key.slice(key.lastIndexOf("/") + 1));
        if (offset !== size) {
          throw new Error(`청크 순서가 끊겼습니다: 기대 ${size}, 실제 ${offset}`);
        }
        const body = await this.getObject(key);
        hash.update(body);
        size += body.length;
        buffer.push(body);
        buffered += body.length;
        if (buffered >= PART_SIZE) await flush();
      }
      await flush();

      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: destinationKey,
          UploadId: upload.UploadId,
          MultipartUpload: { Parts: completed },
        }),
      );
    } catch (err) {
      await this.client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: destinationKey,
            UploadId: upload.UploadId,
          }),
        )
        .catch(() => undefined);
      throw err;
    }

    await this.deletePrefix(`_sessions/${sessionId}/`);
    return { size, sha256: hash.digest("hex") };
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.ensureBucket();
    await this.deletePrefix(`_sessions/${sessionId}/`);
  }

  async delete(key: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureBucket();
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async read(key: string): Promise<Buffer> {
    await this.ensureBucket();
    return this.getObject(key);
  }

  private async getObject(key: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error(`객체 본문이 없습니다: ${key}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  private async sessionSize(sessionId: string): Promise<number> {
    const objects = await this.listPrefix(`_sessions/${sessionId}/`);
    return objects.reduce((sum, object) => sum + Number(object.Size ?? 0), 0);
  }

  private async listPrefix(prefix: string): Promise<Array<{ Key?: string; Size?: number }>> {
    const objects: Array<{ Key?: string; Size?: number }> = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) objects.push(object);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    return objects.sort((a, b) => (a.Key ?? "").localeCompare(b.Key ?? ""));
  }

  private async deletePrefix(prefix: string): Promise<void> {
    const objects = await this.listPrefix(prefix);
    for (let index = 0; index < objects.length; index += 1000) {
      const batch = objects.slice(index, index + 1000);
      if (batch.length === 0) continue;
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((object) => ({ Key: object.Key as string })) },
        }),
      );
    }
  }
}

const PART_SIZE = 8 * 1024 * 1024;

function isNotFound(err: unknown): boolean {
  const error = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    error.name === "NotFound" ||
    error.name === "NoSuchKey" ||
    error.name === "NoSuchBucket" ||
    error.$metadata?.httpStatusCode === 404
  );
}
