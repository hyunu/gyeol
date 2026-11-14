import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresStore } from "../../apps/api/src/adapters/postgres/store.ts";
import { uuidv7 } from "../../apps/api/src/domain/ids.ts";
import type { AuditEvent } from "../../apps/api/src/domain/types.ts";
import { makeDevice, makeRecording, newConversation } from "./helpers.ts";

/** W-25: 사용자 상태·purge 후보·감사·하드 삭제 PostgreSQL 검증. */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 가 필요합니다.");

const store = new PostgresStore({ connectionString: url });
const db = new pg.Client({ connectionString: url });
await db.connect();

const users: string[] = [];

test.after(async () => {
  for (const userId of users) {
    await db.query(`DELETE FROM audit_events WHERE user_id = $1`, [userId]).catch(() => undefined);
    await store.purgeUser(userId).catch(() => undefined);
  }
  await db.end();
  await store.close();
});

async function fixture() {
  const userId = uuidv7();
  users.push(userId);
  await store.ensureUser(userId);
  const device = makeDevice(userId, `GYL-DBPRIV-${uuidv7()}`);
  await store.createDevice(device);
  const recording = makeRecording(userId, device.id, {
    clientRecordingId: `dbpriv:${uuidv7()}`,
    clientAckAt: new Date(),
    analyzedAt: new Date(),
  });
  await store.createRecording(recording);
  const person = await store.createPerson({
    id: uuidv7(),
    userId,
    displayName: "감사 대상",
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const conversation = await store.createConversation(newConversation(userId, person.id, recording));
  return { userId, device, recording, person, conversation };
}

test("사용자 상태 전이와 30일 purge 후보 조회", async () => {
  const { userId } = await fixture();
  const account = await store.findUserAccount(userId);
  assert.equal(account?.status, "active");

  const old = new Date("2026-10-01T00:00:00Z");
  await store.markUserDeleted(userId, old);
  assert.equal((await store.findUserAccount(userId))?.status, "deleted");

  const pending = await store.listUsersPendingPurge(new Date("2026-10-31T00:00:00Z"), 10);
  assert.ok(pending.some((item) => item.id === userId));

  const notYet = await store.listUsersPendingPurge(new Date("2026-09-15T00:00:00Z"), 10);
  assert.equal(notYet.some((item) => item.id === userId), false);
});

test("원본 purge 후보는 ACK 완료·30일 경과만 포함한다", async () => {
  const { userId, device } = await fixture();
  const now = new Date("2026-11-14T00:00:00Z");

  const old = makeRecording(userId, device.id, {
    clientRecordingId: `dbpriv:old:${uuidv7()}`,
    status: "analyzed",
    storageKey: `recordings/old/${uuidv7()}`,
    clientAckAt: new Date("2026-10-01T00:00:00Z"),
    analyzedAt: new Date("2026-10-01T00:00:00Z"),
  });
  const recent = makeRecording(userId, device.id, {
    clientRecordingId: `dbpriv:new:${uuidv7()}`,
    status: "analyzed",
    storageKey: `recordings/new/${uuidv7()}`,
    clientAckAt: new Date("2026-11-10T00:00:00Z"),
    analyzedAt: new Date("2026-11-10T00:00:00Z"),
  });
  const noAck = makeRecording(userId, device.id, {
    clientRecordingId: `dbpriv:noack:${uuidv7()}`,
    status: "stored",
    storageKey: `recordings/noack/${uuidv7()}`,
    clientAckAt: null,
    analyzedAt: null,
  });
  for (const recording of [old, recent, noAck]) await store.createRecording(recording);

  const candidates = await store.findRecordingPurgeCandidates(new Date("2026-10-15T00:00:00Z"), 10);
  const ids = candidates.map((item) => item.id);
  assert.ok(ids.includes(old.id));
  assert.equal(ids.includes(recent.id), false);
  assert.equal(ids.includes(noAck.id), false);
  assert.equal(ids.includes((await fixture()).recording.id), false);
  void now;
});

test("감사 로그는 사용자별 최신순이고, purgeUser 는 감사 행을 NULL 로 남긴다", async () => {
  const { userId, recording, person } = await fixture();
  const event: AuditEvent = {
    id: uuidv7(),
    userId,
    action: "export",
    resourceType: "user",
    resourceId: userId,
    traceId: "trace-db",
    metadata: { conversations: 1 },
    createdAt: new Date(),
  };
  await store.createAuditEvent(event);

  const events = await store.listAuditEvents(userId);
  assert.equal(events[0]?.action, "export");
  assert.equal(events[0]?.metadata.conversations, 1);
  assert.equal(events[0]?.traceId, "trace-db");

  await store.purgeUser(userId);
  assert.equal(await store.findUserAccount(userId), null);
  assert.equal(await store.findRecording(recording.id), null);
  assert.equal(await store.findPersonById(person.id), null);

  const { rows } = await db.query(
    `SELECT user_id FROM audit_events WHERE id = $1 AND user_id IS NULL`,
    [event.id],
  );
  assert.equal(rows.length, 1, "감사 행은 남고 user_id 만 NULL");
});
