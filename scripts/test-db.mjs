#!/usr/bin/env node
/**
 * DB 테스트 러너.
 *
 * `node --test` 는 매칭되는 파일이 없으면 0 tests 로 "성공"한다.
 * DB 테스트가 아직 없는데 CI 가 초록으로 보이는 것을 막기 위해 여기서 먼저 검사한다.
 *
 * 사용:
 *   make db-up && npm run db:migrate
 *   DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run test:db
 */
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "tests", "db");

let files = [];
try {
  files = (await readdir(DIR)).filter((f) => f.endsWith(".test.ts")).sort();
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

if (files.length === 0) {
  console.error("✗ tests/db/*.test.ts 가 없습니다. DB 테스트 0건은 통과가 아닙니다.");
  console.error("  선행: make db-up && npm run db:migrate (ENV-01)");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("✗ DATABASE_URL 이 필요합니다.");
  console.error("  예: postgres://gyeol:gyeol@localhost:5433/gyeol");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  ["--test", ...files.map((file) => path.join(DIR, file))],
  { stdio: "inherit", env: { ...process.env, GYEOL_STORE: "postgres" } },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
