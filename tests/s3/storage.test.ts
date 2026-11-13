import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { S3Storage } from "../../apps/api/src/adapters/storage/s3.ts";
import { uuidv7 } from "../../apps/api/src/domain/ids.ts";

/**
 * S3 호환 스토리지 포트 검증 (MinIO).
 *
 * 실행:
 *   make db-up   # compose 가 minio 도 함께 띄운다
 *   S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY_ID=gyeol \
 *   S3_SECRET_ACCESS_KEY=gyeol-minio npm run test:s3
 *
 * 전제: 버킷은 어댑터가 없으면 만든다(S3_BUCKET, 기본 gyeol-test).
 */

const endpoint = process.env.S3_ENDPOINT;
if (!endpoint) throw new Error("S3_ENDPOINT 가 필요합니다.");

const storage = new S3Storage();
const createdKeys: string[] = [];

test.after(async () => {
  for (const key of createdKeys) await storage.delete(key).catch(() => undefined);
});

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

test("청크를 순서대로 저장하고 크기·SHA-256 을 돌려준다", async () => {
  const sessionId = uuidv7();
  const key = `tests/${sessionId}/original`;
  const chunks = [Buffer.from("hello "), Buffer.alloc(1024, 7), Buffer.from("결")];
  const expected = Buffer.concat(chunks);

  await storage.startSession(sessionId);
  let offset = 0;
  for (const chunk of chunks) {
    offset = await storage.appendChunk(sessionId, offset, chunk);
  }
  assert.equal(offset, expected.length);

  const result = await storage.commitSession(sessionId, key);
  createdKeys.push(key);
  assert.equal(result.size, expected.length);
  assert.equal(result.sha256, sha256(expected));

  assert.equal(await storage.exists(key), true);
  assert.deepEqual(await storage.read(key), expected);

  await storage.delete(key);
  assert.equal(await storage.exists(key), false);
});

test("오프셋이 어긋난 청크는 거부한다", async () => {
  const sessionId = uuidv7();
  await storage.startSession(sessionId);

  await assert.rejects(
    () => storage.appendChunk(sessionId, 5, Buffer.from("abc")),
    /offset mismatch/,
  );
  await storage.appendChunk(sessionId, 0, Buffer.from("abc"));
  await assert.rejects(
    () => storage.appendChunk(sessionId, 1, Buffer.from("x")),
    /offset mismatch/,
  );

  await storage.abortSession(sessionId);
});

test("중단하면 임시 청크가 남지 않아 commit 이 실패한다", async () => {
  const sessionId = uuidv7();
  await storage.startSession(sessionId);
  await storage.appendChunk(sessionId, 0, Buffer.from("abc"));
  await storage.abortSession(sessionId);

  await assert.rejects(() => storage.commitSession(sessionId, `tests/${sessionId}/aborted`));
});

test("세션을 다시 시작하면 이전 청크를 버린다", async () => {
  const sessionId = uuidv7();
  const key = `tests/${sessionId}/restarted`;

  await storage.startSession(sessionId);
  await storage.appendChunk(sessionId, 0, Buffer.from("old"));
  await storage.startSession(sessionId);
  await storage.appendChunk(sessionId, 0, Buffer.from("new"));

  const result = await storage.commitSession(sessionId, key);
  createdKeys.push(key);
  assert.equal(result.size, 3);
  assert.equal(result.sha256, sha256(Buffer.from("new")));
  assert.deepEqual(await storage.read(key), Buffer.from("new"));
});

test("8MiB 를 넘는 업로드는 multipart 로 이어진다", async () => {
  const sessionId = uuidv7();
  const key = `tests/${sessionId}/large`;
  const chunkSize = 1024 * 1024;
  const chunkCount = 9;
  const chunks = Array.from({ length: chunkCount }, (_, index) =>
    Buffer.alloc(chunkSize, index + 1),
  );
  const expected = Buffer.concat(chunks);

  await storage.startSession(sessionId);
  let offset = 0;
  for (const chunk of chunks) {
    offset = await storage.appendChunk(sessionId, offset, chunk);
  }

  const result = await storage.commitSession(sessionId, key);
  createdKeys.push(key);
  assert.equal(result.size, expected.length);
  assert.equal(result.sha256, sha256(expected));
  assert.equal((await storage.read(key)).length, expected.length);
});

test("없는 객체는 exists=false, read 는 실패한다", async () => {
  const key = `tests/${uuidv7()}/missing`;
  assert.equal(await storage.exists(key), false);
  await assert.rejects(() => storage.read(key));
});
