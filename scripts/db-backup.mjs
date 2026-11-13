#!/usr/bin/env node
/**
 * PostgreSQL 논리 백업 (W-26).
 *
 * 개발 환경에서는 docker compose 의 gyeol-postgres 컨테이너에서 pg_dump 를 실행한다.
 * 운영에서는 같은 옵션의 pg_dump 를 백업 호스트에서 실행한다(docs/11-backup-restore.md).
 *
 * 사용:
 *   DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run db:backup
 *   ... npm run db:backup -- .artifacts/backups/manual.dump
 */
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const container = process.env.PG_CONTAINER ?? "gyeol-postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL 이 필요합니다.");
  process.exit(1);
}

const database = parseDatabase(url);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const arg = process.argv[2];
const target =
  arg && arg.trim().length > 0
    ? arg
    : path.join(ROOT, ".artifacts", "backups", `${database}-${stamp}.dump`);

try {
  const dump = await docker(["exec", container, "pg_dump", "-U", userOf(url), "-d", database, "-Fc"], true);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, dump);
  const info = await stat(target);
  console.log(`✔ 백업: ${target} (${(info.size / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`  복구 리허설: npm run db:restore:rehearsal -- "${target}"`);
} catch (err) {
  console.error(`✗ 백업 실패: ${err.message}`);
  console.error(`  docker 컨테이너(${container})가 실행 중인지 확인하세요: make db-up`);
  process.exit(1);
}

function parseDatabase(connectionString) {
  const parsed = new URL(connectionString);
  const name = parsed.pathname.replace(/^\//, "");
  if (!name) throw new Error("DATABASE_URL 에 데이터베이스 이름이 없습니다.");
  return name;
}

function userOf(connectionString) {
  return decodeURIComponent(new URL(connectionString).username) || "postgres";
}

function docker(args, binary = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const message = Buffer.concat(err).toString("utf8").trim();
        reject(new Error(message || `docker ${args.join(" ")} 실패 (exit ${code})`));
      } else {
        const buffer = Buffer.concat(out);
        resolve(binary ? buffer : buffer.toString("utf8"));
      }
    });
  });
}
