#!/usr/bin/env node
/**
 * 백업 복구 리허설 (W-26).
 *
 * 원본 DB 는 건드리지 않고, 별도 DB(<db>_rehearsal)에 복구한 뒤
 * 테이블 목록·행 수·마이그레이션 체크섬이 같은지 비교한다.
 *
 * 기본은 docker compose 컨테이너(gyeol-postgres) 사용. Docker 불가 또는
 * PG_LOCAL=1 이면 로컬 pg_restore/psql/dropdb/createdb 를 사용한다.
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
const file = process.argv.find((arg, i) => i >= 2 && arg.endsWith(".dump"));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL 이 필요합니다.");
  process.exit(1);
}
if (!file) {
  console.error("✗ 백업 파일 경로가 필요합니다. 예: npm run db:restore:rehearsal -- .artifacts/backups/x.dump");
  process.exit(1);
}

const parsed = new URL(url);
const source = parseDatabase(parsed);
const user = decodeURIComponent(parsed.username) || "postgres";
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
  await dropDb(target);
  await createDb(target);

  console.log(`· 복구: ${path.basename(file)} (${(backup.length / 1024 / 1024).toFixed(2)} MiB)`);
  await restoreDb(target, backup);

  const sourceState = await snapshot(source);
  const targetState = await snapshot(target);

  console.log("\n| 테이블 | 원본 | 복구 |");
  console.log("| --- | ---: | ---: |");
  for (const table of sourceState.tables) {
    console.log(
      `| ${table.name} | ${table.rows} | ${targetState.tables.find((t) => t.name === table.name)?.rows ?? "-"} |`,
    );
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
      `\n✔ 복구 리허설 통과 — ${sourceState.tables.length} 테이블, 마이그레이션 ${sourceState.migrations.split("\n").filter(Boolean).length}건, ${seconds}s`,
    );
    console.log("  원본 DB 는 변경하지 않았습니다.");
  }
} catch (err) {
  console.error(`✗ 복구 리허설 실패: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (!keep) {
    await dropDb(target).catch(() => undefined);
    console.log(`· 리허설 DB 정리: ${target}`);
  } else {
    console.log(`· 리허설 DB 유지: ${target}`);
  }
}

async function snapshot(database) {
  const tableList = await psql(
    database,
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  ).then((out) => out.trim().split("\n").filter(Boolean));

  const tables = [];
  for (const name of tableList) {
    const value = await psql(database, `SELECT count(*) FROM "${name}"`);
    tables.push({ name, rows: Number(value.trim()) });
  }

  const migrations = await psql(
    database,
    `SELECT filename || ':' || checksum FROM schema_migrations ORDER BY filename`,
  ).then((out) => out.trim());

  const extensions = await psql(
    database,
    `SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension`,
  ).then((out) => out.trim());

  return { tables, migrations, extensions };
}

function parseDatabase(urlObj) {
  const name = urlObj.pathname.replace(/^\//, "");
  if (!name) throw new Error("DATABASE_URL 에 데이터베이스 이름이 없습니다.");
  return name;
}

function connArgs(database) {
  const host = parsed.hostname || "localhost";
  const port = parsed.port || "5432";
  return ["-h", host, "-p", port, "-U", user, "-d", database];
}

async function dropDb(database) {
  await execPg(["dropdb", "-h", parsed.hostname || "localhost", "-p", parsed.port || "5432", "-U", user, "--if-exists", database]);
}

async function createDb(database) {
  await execPg(["createdb", "-h", parsed.hostname || "localhost", "-p", parsed.port || "5432", "-U", user, database]);
}

async function restoreDb(database, data) {
  await execPg(
    ["pg_restore", "-h", parsed.hostname || "localhost", "-p", parsed.port || "5432", "-U", user, "-d", database, "--no-owner", "--no-privileges"],
    data,
  );
}

async function psql(database, sql) {
  return execPg(["psql", ...connArgs(database), "-At", "-c", sql]);
}

async function execPg(localCmd, input = null) {
  if (process.env.PG_LOCAL === "1") return run(localCmd, input);
  try {
    if (localCmd[0] === "psql") {
      return await dockerExec([localCmd[0], "-U", user, "-d", localCmd[localCmd.indexOf("-d") + 1], "-At", "-c", localCmd[localCmd.indexOf("-c") + 1]], input);
    }
    if (localCmd[0] === "dropdb") {
      const db = localCmd[localCmd.length - 1];
      return await dockerExec([localCmd[0], "-U", user, "--if-exists", db], input);
    }
    if (localCmd[0] === "createdb") {
      const db = localCmd[localCmd.length - 1];
      return await dockerExec([localCmd[0], "-U", user, db], input);
    }
    if (localCmd[0] === "pg_restore") {
      const db = localCmd[localCmd.indexOf("-d") + 1];
      return await dockerExec([localCmd[0], "-U", user, "-d", db, "--no-owner", "--no-privileges"], input);
    }
    throw new Error(`지원하지 않는 명령: ${localCmd[0]}`);
  } catch (err) {
    try {
      return await run(localCmd, input);
    } catch {
      throw err;
    }
  }
}

function dockerExec(args, input = null) {
  return run(["docker", "exec", ...(input ? ["-i"] : []), container, ...args], input);
}

function run(cmd, input = null) {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cmd;
    const child = spawn(bin, args, {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password || "") },
    });
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
        resolve(Buffer.concat(out).toString("utf8"));
      }
    });
    if (input) child.stdin.end(input);
  });
}
