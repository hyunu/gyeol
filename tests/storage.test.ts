import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createStorageFromEnv } from "../apps/api/src/http/server.ts";
import { LocalDiskStorage } from "../apps/api/src/adapters/storage/local-disk.ts";
import { S3Storage } from "../apps/api/src/adapters/storage/s3.ts";

test("GYEOL_STORAGE 로 스토리지를 고르고, 잘못된 값은 fail-closed", () => {
  assert.ok(createStorageFromEnv(tmpdir(), "local") instanceof LocalDiskStorage);
  assert.ok(createStorageFromEnv(tmpdir(), "s3") instanceof S3Storage);
  assert.throws(
    () => createStorageFromEnv(tmpdir(), "gcs"),
    /GYEOL_STORAGE 값이 올바르지 않습니다: gcs/,
  );
});
