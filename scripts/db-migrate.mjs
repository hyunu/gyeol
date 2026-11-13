#!/usr/bin/env node
/**
 * 마이그레이션 러너.
 *
 * - db/migrations/*.sql 을 이름순으로 적용한다.
 * - 적용 이력은 schema_migrations 에 남기고, 파일 체크섬이 바뀌면 실패한다(드리프트 감지).
 * - 각 파일은 하나의 트랜잭션으로 적용한다.
 *
 * 사용:
 *   DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run db:migrate
 *   npm run db:migrate -- --dry-run
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(ROOT, "db", "migrations");
const dryRun = process.argv.includes("--dry-run");

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail("DATABASE_URL 이 필요합니다. 예: postgres://gyeol:gyeol@localhost:5433/gyeol");

const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
} catch (err) {
  fail(`DB 연결 실패: ${err.message}`);
}

async function applied() {
  const { rows } = await client.query(
    `SELECT filename, checksum FROM schema_migrations ORDER BY filename`,
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}

async function ensureTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

const files = (await readdir(MIGRATIONS_DIR))
  .filter((f) => f.endsWith(".sql"))
  .sort();

const already = await (dryRun ? new Map() : (await ensureTable(), applied()));
let count = 0;

for (const file of files) {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  const previous = already.get(file);

  if (previous && previous !== checksum) {
    fail(`${file}: 적용 후 파일이 변경되었습니다(체크섬 불일치). 새 마이그레이션을 추가하세요.`);
  }
  if (previous) continue;

  if (dryRun) {
    console.log(`  (dry-run) ${file}`);
    count += 1;
    continue;
  }

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
      [file, checksum],
    );
    await client.query("COMMIT");
    console.log(`  ✔ ${file}`);
    count += 1;
  } catch (err) {
    await client.query("ROLLBACK");
    fail(`${file} 적용 실패: ${err.message}`);
  }
}

if (dryRun) {
  console.log(`dry-run: 적용 대상 ${count}건 (총 ${files.length}건)`);
} else {
  console.log(count === 0 ? "적용할 마이그레이션이 없습니다." : `완료: ${count}건 적용`);
}
await client.end();
