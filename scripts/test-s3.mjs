#!/usr/bin/env node
/**
 * S3 호환 스토리지 테스트 러너.
 *
 * 전제: MinIO 또는 S3 호환 엔드포인트.
 *   make db-up    # docker compose 가 minio 를 함께 띄운다
 *   S3_ENDPOINT=http://127.0.0.1:9000 \
 *   S3_ACCESS_KEY_ID=gyeol S3_SECRET_ACCESS_KEY=gyeol-minio \
 *   npm run test:s3
 */
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "tests", "s3");

let files = [];
try {
  files = (await readdir(DIR)).filter((file) => file.endsWith(".test.ts")).sort();
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

if (files.length === 0) {
  console.error("✗ tests/s3/*.test.ts 가 없습니다. 스토리지 테스트 0건은 통과가 아닙니다.");
  process.exit(1);
}

const required = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`✗ 환경 변수가 필요합니다: ${missing.join(", ")}`);
  console.error("  예: make db-up && S3_ENDPOINT=http://127.0.0.1:9000 \\");
  console.error("      S3_ACCESS_KEY_ID=gyeol S3_SECRET_ACCESS_KEY=gyeol-minio npm run test:s3");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files.map((file) => path.join(DIR, file))],
  { stdio: "inherit", env: { ...process.env, GYEOL_STORAGE: "s3" } },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
