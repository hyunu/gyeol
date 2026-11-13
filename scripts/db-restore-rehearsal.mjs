#!/usr/bin/env node
/**
 * 백업 복구 리허설 (W-26).
 *
 * 원본 DB 는 건드리지 않고, 별도 DB(<db>_rehearsal)에 복구한 뒤
 * 테이블 목록·행 수·마이그레이션 체크섬이 같은지 비교한다.
 *
 * 사용:
 *   DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol \
 *   npm run db:restore:rehearsal -- .artifacts/backups/gyeol-....dump
 *
 * 옵션: --keep  (리허설 DB 를 지우지 않는다)
 */
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const container = process.env.PG_CONTAINER ?? "gyeol-postgres";
const keep = process.argv.includes("--keep");
const file = process.argv.find((arg) => arg.endsWith(".dump"));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL 이 필요합니다.");
  process.exit(1);
}
if (!file) {
  console.error("✗ 백업 파일 경로가 필요합니다. 예: npm run db:restore:rehearsal -- .artifacts/backups/x.dump");
  process.exit(1);
}

const source = parseDatabase(url);
const user = decodeURIComponent(new URL(url).username) || "postgres";
const target = process.env.REHEARSAL_DB ?? `${source}_rehearsal`;

if (target === source || !target.endsWith("_rehearsal")) {
  console.error(`✗ 리허설 DB 이름이 안전하지 않습니다: ${target}`);
  console.error("  원본과 다르고 _rehearsal 로 끝나야 합니다.");
  process.exit(1);
}

try {
  await stat(file);
} catch {
  console.error(`✗ 백업 파일이 없습니다: ${file}`);
  process.exit(1);
}

const backup = await readFile(file);
const startedAt = Date.now();

try {
  console.log(`· 리허설 DB 재생성: ${target}`);
  await docker(["exec", container, "dropdb", "-U", user, "--if-exists", target]);
  await docker(["exec", container, "createdb", "-U", user, target]);

  console.log(`· 복구: ${path.basename(file)} (${(backup.length / 1024 / 1024).toFixed(2)} MiB)`);
  await docker(
    ["exec", "-i", container, "pg_restore", "-U", user, "-d", target, "--no-owner", "--no-privileges"],
    backup,
  );

  const sourceState = await snapshot(source, user);
  const targetState = await snapshot(target, user);

  console.log("\n| 테이블 | 원본 | 복구 |");
  console.log("| --- | ---: | ---: |");
  for (const table of sourceState.tables) {
    console.log(`| ${table.name} | ${table.rows} | ${targetState.tables.find((t) => t.name === table.name)?.rows ?? "-"} |`);
  }

  const problems = [];
  if (sourceState.tables.length !== targetState.tables.length) {
    problems.push(`테이블 수 ${sourceState.tables.length} != ${targetState.tables.length}`);
  }
  for (const table of sourceState.tables) {
    const other = targetState.tables.find((candidate) => candidate.name === table.name);
    if (!other) problems.push(`테이블 누락: ${table.name}`);
    else if (other.rows !== table.rows) {
      problems.push(`행 수 불일치: ${table.name} ${table.rows} != ${other.rows}`);
    }
  }
  if (sourceState.migrations !== targetState.migrations) {
    problems.push("schema_migrations 체크섬이 다릅니다.");
  }
  if (sourceState.extensions !== targetState.extensions) {
    problems.push(`확장 목록이 다릅니다: ${sourceState.extensions} != ${targetState.extensions}`);
  }

  if (problems.length > 0) {
    console.error("\n✗ 복구 리허설 실패");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `\n✔ 복구 리허설 통과 — ${sourceState.tables.length} 테이블, 마이그레이션 ${sourceState.migrations.split("\n").length}건, ${seconds}s`,
    );
    console.log("  원본 DB 는 변경하지 않았습니다.");
  }
} catch (err) {
  console.error(`✗ 복구 리허설 실패: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (!keep) {
    await docker(["exec", container, "dropdb", "-U", user, "--if-exists", target]).catch(() => undefined);
    console.log(`· 리허설 DB 정리: ${target}`);
  } else {
    console.log(`· 리허설 DB 유지: ${target}`);
  }
}

async function snapshot(database, user) {
  const tables = await psql(
    user,
    database,
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  ).then((out) => out.trim().split("\n").filter(Boolean));

  const counts = [];
  for (const name of tables) {
    const value = await psql(user, database, `SELECT count(*) FROM "${name}"`);
    counts.push({ name, rows: Number(value.trim()) });
  }

  const migrations = await psql(
    user,
    database,
    `SELECT filename || ':' || checksum FROM schema_migrations ORDER BY filename`,
  ).then((out) => out.trim());

  const extensions = await psql(
    user,
    database,
    `SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension`,
  ).then((out) => out.trim());

  return { tables: counts, migrations, extensions };
}

function psql(user, database, sql) {
  return docker(["exec", container, "psql", "-U", user, "-d", database, "-At", "-c", sql]);
}

function parseDatabase(connectionString) {
  const name = new URL(connectionString).pathname.replace(/^\//, "");
  if (!name) throw new Error("DATABASE_URL 에 데이터베이스 이름이 없습니다.");
  return name;
}

function docker(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
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
        resolve(Buffer.concat(out).toString("utf8"));
      }
    });
    if (input) child.stdin.end(input);
  });
}
