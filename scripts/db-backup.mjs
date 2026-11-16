#!/usr/bin/env node
/**
 * PostgreSQL 논리 백업 (W-26).
 *
 * 기본은 docker compose 컨테이너(gyeol-postgres)에서 pg_dump 를 실행한다.
 * Docker 를 쓸 수 없거나 PG_LOCAL=1 이면 로컬 pg_dump 를 사용한다.
 *
 * 사용:
 *   DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run db:backup
 *   PG_LOCAL=1 DATABASE_URL=... npm run db:backup -- .artifacts/backups/manual.dump
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
const arg = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"));
const target =
  arg && arg.trim().length > 0
    ? arg
    : path.join(ROOT, ".artifacts", "backups", `${database}-${stamp}.dump`);

try {
  const dump = await runDump(url, database);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, dump);
  const info = await stat(target);
  console.log(`✔ 백업: ${target} (${(info.size / 1024 / 1024).toFixed(2)} MiB)`);
  console.log(`  복구 리허설: npm run db:restore:rehearsal -- "${target}"`);
} catch (err) {
  console.error(`✗ 백업 실패: ${err.message}`);
  console.error(`  docker 환경: 컨테이너(${container}) 확인(make db-up). 로컬 환경: PG_LOCAL=1 과 pg_dump 설치 확인.`);
  process.exit(1);
}

async function runDump(connectionString, databaseName) {
  if (useLocal()) {
    return run(["pg_dump", "-Fc", "--no-owner", "--no-privileges", "-d", connectionString], null, true);
  }
  try {
    return await docker(["exec", container, "pg_dump", "-U", userOf(connectionString), "-d", databaseName, "-Fc"], null, true);
  } catch (err) {
    if (process.env.PG_LOCAL === "1") throw err;
    // docker 미설치/컨테이너 미실행 시 로컬 pg_dump 로 폴백
    try {
      return await run(["pg_dump", "-Fc", "--no-owner", "--no-privileges", "-d", connectionString], null, true);
    } catch {
      throw err;
    }
  }
}

function useLocal() {
  return process.env.PG_LOCAL === "1";
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

function docker(args, input = null, binary = false) {
  return run(["docker", ...args], input, binary);
}

function run(cmd, input = null, binary = false) {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    const child = spawn(bin, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const message = Buffer.concat(err).toString("utf8").trim();
        reject(new Error(message || `${cmd.join(" ")} 실패 (exit ${code})`));
      } else {
        const buffer = Buffer.concat(out);
        resolve(binary ? buffer : buffer.toString("utf8"));
      }
    });
    if (input) child.stdin.end(input);
  });
}
