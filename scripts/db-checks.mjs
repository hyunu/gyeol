#!/usr/bin/env node
/**
 * DB 제약·인덱스 실동작 검증 러너.
 *
 * `db/checks/*.sql` 을 파일 단위 트랜잭션으로 실행하고 항상 ROLLBACK 한다.
 * 각 SQL 파일은 "위반이 실제로 거부되는지"를 스스로 검사해야 한다.
 *
 * 사용:
 *   make db-up && npm run db:migrate
 *   DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run db:checks
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKS_DIR = path.join(ROOT, "db", "checks");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("✗ DATABASE_URL 이 필요합니다. 예: postgres://gyeol:gyeol@localhost:5433/gyeol");
  process.exit(1);
}

let files = [];
try {
  files = (await readdir(CHECKS_DIR)).filter((f) => f.endsWith(".sql")).sort();
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

if (files.length === 0) {
  console.error("✗ db/checks/*.sql 이 없습니다. DB 검증 0건은 통과가 아닙니다.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

let failed = 0;

for (const file of files) {
  const sql = await readFile(path.join(CHECKS_DIR, file), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    console.log(`  ✔ ${file}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${file}: ${err.message}`);
  } finally {
    await client.query("ROLLBACK");
  }
}

await client.end();

if (failed > 0) {
  console.error(`실패: ${failed}/${files.length}`);
  process.exit(1);
}
console.log(`완료: ${files.length}건 (모든 검사는 트랜잭션 롤백으로 DB 를 남기지 않는다)`);
