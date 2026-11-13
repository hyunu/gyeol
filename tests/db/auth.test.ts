import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresStore } from "../../apps/api/src/adapters/postgres/store.ts";
import { uuidv7 } from "../../apps/api/src/domain/ids.ts";
import type { Session } from "../../apps/api/src/domain/types.ts";
import { hashSessionToken } from "../../apps/api/src/usecases/auth.ts";

/** sessions(0003) + auth_subject upsert PostgreSQL 검증. */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 이 필요합니다.");

const store = new PostgresStore({ connectionString: url });
const cleanup = new pg.Client({ connectionString: url });
await cleanup.connect();

const userIds: string[] = [];

test.after(async () => {
  for (const userId of userIds) {
    await cleanup.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]).catch(() => undefined);
    await cleanup.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined);
  }
  await cleanup.end();
  await store.close();
});

function makeSession(userId: string, overrides: Partial<Session> = {}): Session {
  const now = new Date("2026-11-14T00:00:00Z");
  return {
    id: uuidv7(),
    userId,
    tokenHash: hashSessionToken(uuidv7()),
    createdAt: now,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    lastUsedAt: null,
    revokedAt: null,
    userAgent: "test",
    ...overrides,
  };
}

test("auth_subject 로 사용자를 찾거나 만들고, 같은 sub 는 같은 사용자다", async () => {
  const subject = `apple:test-${uuidv7()}`;
  const first = await store.upsertUserByAuthSubject({
    id: uuidv7(),
    authSubject: subject,
    displayName: "첫 이름",
  });
  userIds.push(first.id);

  const second = await store.upsertUserByAuthSubject({
    id: uuidv7(),
    authSubject: subject,
    displayName: "다른 이름",
  });
  assert.equal(second.id, first.id);
  assert.equal(second.displayName, "첫 이름", "기존 표시 이름을 유지한다");
});

test("세션 발급·조회·터치·폐기가 실제 SQL 로 동작한다", async () => {
  const user = await store.upsertUserByAuthSubject({
    id: uuidv7(),
    authSubject: `apple:test-${uuidv7()}`,
    displayName: "세션 사용자",
  });
  userIds.push(user.id);

  const session = await store.createSession(makeSession(user.id));
  const found = await store.findSessionByTokenHash(session.tokenHash);
  assert.equal(found?.id, session.id);
  assert.equal(found?.userId, user.id);

  const usedAt = new Date("2026-11-15T00:00:00Z");
  await store.touchSession(session.id, usedAt);
  assert.equal((await store.findSessionByTokenHash(session.tokenHash))?.lastUsedAt?.toISOString(), usedAt.toISOString());

  const revokedAt = new Date("2026-11-16T00:00:00Z");
  await store.revokeSession(session.id, revokedAt);
  const revoked = await store.findSessionByTokenHash(session.tokenHash);
  assert.equal(revoked?.revokedAt?.toISOString(), revokedAt.toISOString());
});

test("token_hash 중복은 거부되고, 사용자 단위 폐기는 활성 세션만 센다", async () => {
  const user = await store.upsertUserByAuthSubject({
    id: uuidv7(),
    authSubject: `apple:test-${uuidv7()}`,
    displayName: "폐기 사용자",
  });
  userIds.push(user.id);

  const first = makeSession(user.id);
  const second = makeSession(user.id);
  const third = makeSession(user.id);
  await store.createSession(first);
  await store.createSession(second);
  await store.createSession(third);

  await assert.rejects(
    () => store.createSession(makeSession(user.id, { tokenHash: first.tokenHash })),
    (err: any) => err.code === "23505",
  );

  const at = new Date("2026-11-17T00:00:00Z");
  await store.revokeSession(second.id, at);
  const count = await store.revokeUserSessions(user.id, at);
  assert.equal(count, 2, "이미 폐기된 세션은 세지 않는다");

  for (const session of [first, second, third]) {
    const found = await store.findSessionByTokenHash(session.tokenHash);
    assert.ok(found?.revokedAt, `${session.id} 는 폐기되어야 한다`);
  }
});
