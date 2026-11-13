import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresStore } from "../../apps/api/src/adapters/postgres/store.ts";
import { uuidv7 } from "../../apps/api/src/domain/ids.ts";
import { makeDevice, makeRecording, newConversation } from "./helpers.ts";

/**
 * PostgreSQL Store 패리티 테스트.
 * MemoryStore 와 같은 의미(유니크 제약, 정렬, 검색, 재분석 교체)를 실제 SQL 로 검증한다.
 *
 * 실행: DATABASE_URL=... npm run test:db   (tests/db 가 비면 test:db 자체가 실패한다)
 */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 이 필요합니다.");

const store = new PostgresStore({ connectionString: url });
const cleanupClient = new pg.Client({ connectionString: url });
await cleanupClient.connect();

const userIds: string[] = [];

async function newUser(): Promise<string> {
  const id = uuidv7();
  userIds.push(id);
  await store.ensureUser(id);
  return id;
}

test.after(async () => {
  for (const id of userIds) {
    await cleanupClient.query("DELETE FROM conversations WHERE user_id = $1", [id]).catch(() => undefined);
    await cleanupClient.query("DELETE FROM recordings WHERE user_id = $1", [id]).catch(() => undefined);
    await cleanupClient.query("DELETE FROM persons WHERE user_id = $1", [id]).catch(() => undefined);
    await cleanupClient.query("DELETE FROM devices WHERE user_id = $1", [id]).catch(() => undefined);
    await cleanupClient.query("DELETE FROM users WHERE id = $1", [id]).catch(() => undefined);
  }
  await cleanupClient.end();
  await store.close();
});

test("ensureUser 는 멱등이고 표시 이름을 만든다", async () => {
  const id = await newUser();
  const again = await store.ensureUser(id);
  assert.equal(again.id, id);
  assert.equal(again.displayName, `로컬 사용자 ${id.slice(0, 8)}`);
  assert.ok(again.createdAt instanceof Date);
});

test("기기: serial 중복은 DEVICE_ALREADY_REGISTERED, 목록은 최신순", async () => {
  const userId = await newUser();
  const first = makeDevice(userId, "GYL-DB-DEV-1");
  await store.createDevice(first);

  await assert.rejects(
    () => store.createDevice({ ...(makeDevice(userId, "GYL-DB-DEV-1")) }),
    (err: any) => err.code === "DEVICE_ALREADY_REGISTERED",
  );

  const byId = await store.findDevice(first.id);
  assert.equal(byId?.serialNo, "GYL-DB-DEV-1");
  assert.equal((await store.findDeviceBySerial("GYL-DB-DEV-1"))?.id, first.id);

  const second = makeDevice(userId, "GYL-DB-DEV-2");
  await store.createDevice({ ...second, createdAt: new Date(first.createdAt.getTime() + 1000) });

  const page = await store.listDevices(userId, 1, 1);
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].serialNo, "GYL-DB-DEV-2", "최신 기기가 먼저");

  const updated = await store.updateDevice({ ...first, batteryPct: 42 });
  assert.equal(updated.batteryPct, 42, "smallint 가 number 로 매핑된다");
});

test("녹음: 멱등 키 중복 거부, 필터·페이지·bigint 매핑", async () => {
  const userId = await newUser();
  const device = makeDevice(userId, "GYL-DB-REC-DEV");
  await store.createDevice(device);

  const first = makeRecording(userId, device.id, {
    clientRecordingId: "db:rec:1",
    startedAt: new Date("2026-11-01T01:00:00Z"),
    byteSize: 5_000_000,
  });
  await store.createRecording(first);

  await assert.rejects(
    () => store.createRecording({ ...first, id: uuidv7() }),
    (err: any) => err.code === "RECORDING_ALREADY_EXISTS",
  );

  const found = await store.findRecordingByClientKey(device.id, "db:rec:1");
  assert.equal(found?.id, first.id);
  assert.equal(found?.byteSize, 5_000_000, "bigint 가 number 로 매핑된다");

  const second = makeRecording(userId, device.id, {
    clientRecordingId: "db:rec:2",
    startedAt: new Date("2026-11-02T01:00:00Z"),
  });
  await store.createRecording(second);
  await store.updateRecording({ ...first, status: "uploading" });

  const uploading = await store.listRecordings({
    userId,
    status: "uploading",
    page: 1,
    size: 10,
  });
  assert.equal(uploading.total, 1);
  assert.equal(uploading.items[0].id, first.id);

  const ranged = await store.listRecordings({
    userId,
    from: new Date("2026-11-02T00:00:00Z"),
    page: 1,
    size: 10,
  });
  assert.equal(ranged.total, 1);
  assert.equal(ranged.items[0].id, second.id, "started_at 최신순");

  const page = await store.listRecordings({ userId, page: 1, size: 1 });
  assert.equal(page.total, 2);
});

test("업로드 세션: 열린 세션 1개, 만료, 완료 세션 허용", async () => {
  const userId = await newUser();
  const device = makeDevice(userId, "GYL-DB-SES-DEV");
  await store.createDevice(device);
  const recording = makeRecording(userId, device.id, { clientRecordingId: "db:ses:1" });
  await store.createRecording(recording);

  const now = new Date("2026-11-14T00:00:00Z");
  const session = {
    id: uuidv7(),
    recordingId: recording.id,
    status: "open" as const,
    expectedBytes: recording.byteSize,
    receivedBytes: 0,
    expectedSha256: recording.sha256,
    chunkSizeBytes: 262_144,
    expiresAt: new Date(now.getTime() + 60_000),
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await store.createUploadSession(session);

  await assert.rejects(
    () => store.createUploadSession({ ...session, id: uuidv7() }),
    (err: any) => err.code === "UPLOAD_SESSION_OPEN",
  );

  assert.equal(await store.expireUploadSessions(new Date(now.getTime() + 61_000)), 1);
  assert.equal(await store.findOpenUploadSession(recording.id), null);

  // 만료 후에는 새 세션을 만들 수 있고, 완료 세션은 부분 유니크 인덱스에 걸리지 않는다.
  const fresh = { ...session, id: uuidv7(), expiresAt: new Date(now.getTime() + 120_000) };
  await store.createUploadSession(fresh);
  await store.updateUploadSession({
    ...fresh,
    status: "completed",
    receivedBytes: fresh.expectedBytes,
    completedAt: new Date(now.getTime() + 30_000),
  });
  await store.createUploadSession({ ...session, id: uuidv7(), expiresAt: new Date(now.getTime() + 180_000) });
});

test("대화 상세: 파생 데이터·사람·연결이 모두 매핑된다", async () => {
  const userId = await newUser();
  const device = makeDevice(userId, "GYL-DB-CONV-DEV");
  await store.createDevice(device);
  const recording = makeRecording(userId, device.id, { clientRecordingId: "db:conv:1" });
  await store.createRecording(recording);

  const person = await store.createPerson({
    id: uuidv7(),
    userId,
    displayName: "김민수",
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const input = newConversation(userId, person.id, recording);
  const conversation = await store.createConversation(input);

  const detail = await store.getConversationDetail(conversation.id);
  assert.ok(detail);
  assert.equal(detail.speakers.length, 2);
  assert.equal(detail.segments.length, 3);
  assert.deepEqual(
    detail.segments.map((s) => s.seq),
    [0, 1, 2],
    "세그먼트는 seq 순서",
  );
  assert.equal(detail.entities.length, 2);
  assert.equal(detail.actionItems.length, 1);
  assert.equal(detail.actionItems[0].status, "open");
  assert.equal(typeof detail.actionItems[0].confidence, "number", "numeric 은 string 이 아니라 number");
  assert.equal(detail.people.length, 1, "Unknown Speaker 는 people 에 포함되지 않는다");
  assert.equal(detail.people[0].id, person.id);
  assert.deepEqual(detail.recordingIds, [recording.id]);

  const speaker = detail.speakers.find((s) => s.identificationStatus === "unknown");
  assert.equal(speaker?.personId, null);
  assert.equal(detail.segments[1].speakerClusterId, speaker?.id);

  const linked = await store.findConversationByRecordingId(recording.id);
  assert.equal(linked?.id, conversation.id);
  assert.deepEqual(await store.listRecordingLinks(conversation.id), [
    { recordingId: recording.id, startOffsetMs: 0, endOffsetMs: recording.durationMs },
  ]);
});

test("대화 목록: 인물·기간·키워드 검색과 페이지", async () => {
  const userId = await newUser();
  const device = makeDevice(userId, "GYL-DB-LIST-DEV");
  await store.createDevice(device);
  const person = await store.createPerson({
    id: uuidv7(),
    userId,
    displayName: "이영희",
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const conversations = [];
  for (let index = 0; index < 3; index += 1) {
    const recording = makeRecording(userId, device.id, {
      clientRecordingId: `db:list:${index}`,
      startedAt: new Date(`2026-11-0${index + 1}T01:00:00Z`),
    });
    await store.createRecording(recording);
    conversations.push(await store.createConversation(newConversation(userId, person.id, recording)));
  }

  const byPerson = await store.listConversations({
    userId,
    personId: person.id,
    page: 1,
    size: 10,
  });
  assert.equal(byPerson.total, 3);
  assert.equal(byPerson.items.length, 3);
  assert.equal(byPerson.items[0].people.length, 1);
  assert.deepEqual(byPerson.items[0].recordingIds.length, 1);
  assert.ok(
    byPerson.items[0].conversation.startedAt >= byPerson.items[1].conversation.startedAt,
    "최신순 정렬",
  );

  const ranged = await store.listConversations({
    userId,
    from: new Date("2026-11-02T00:00:00Z"),
    to: new Date("2026-11-03T00:00:00Z"),
    page: 1,
    size: 10,
  });
  assert.equal(ranged.total, 1);

  const keyword = await store.listConversations({
    userId,
    q: "북한산",
    page: 1,
    size: 10,
  });
  assert.equal(keyword.total, 3, "세그먼트 본문 키워드가 검색된다");
  assert.ok((keyword.items[0].score ?? 0) >= 0.35);

  const none = await store.listConversations({ userId, q: "존재하지않는단어", page: 1, size: 10 });
  assert.equal(none.total, 0);

  const page = await store.listConversations({ userId, page: 1, size: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.equal((await store.listConversations({ userId, page: 2, size: 2 })).items.length, 1);

  assert.ok(conversations.length === 3);
});

test("재분석: 파생 교체는 중복을 만들지 않고, 실패하면 트랜잭션 전체가 롤백된다", async () => {
  const userId = await newUser();
  const device = makeDevice(userId, "GYL-DB-RE-DEV");
  await store.createDevice(device);
  const recording = makeRecording(userId, device.id, { clientRecordingId: "db:re:1" });
  await store.createRecording(recording);
  const person = await store.createPerson({
    id: uuidv7(),
    userId,
    displayName: "박철수",
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const created = await store.createConversation(newConversation(userId, person.id, recording));
  const replaced = await store.replaceConversation(created.id, {
    ...newConversation(userId, person.id, recording, { title: "재분석", analysisVersion: 2 }),
  });
  assert.equal(replaced.analysisVersion, 2);

  const detail = await store.getConversationDetail(created.id);
  assert.equal(detail?.segments.length, 3, "교체이므로 누적되지 않는다");
  assert.equal(detail?.conversation.title, "재분석");
  assert.deepEqual(detail?.recordingIds, [recording.id]);

  const broken = newConversation(userId, person.id, recording, { analysisVersion: 3 });
  broken.segments = [broken.segments[0], { ...broken.segments[1], seq: 0 }]; // UNIQUE (conversation_id, seq) 위반
  await assert.rejects(() => store.replaceConversation(created.id, broken));

  const afterFailure = await store.getConversationDetail(created.id);
  assert.equal(afterFailure?.segments.length, 3, "실패한 교체는 기존 파생을 지우지 않는다");
  assert.equal(afterFailure?.conversation.analysisVersion, 2);
});

test("할 일·인물 조회", async () => {
  const userId = await newUser();
  const device = makeDevice(userId, "GYL-DB-ACT-DEV");
  await store.createDevice(device);
  const recording = makeRecording(userId, device.id, { clientRecordingId: "db:act:1" });
  await store.createRecording(recording);
  const person = await store.createPerson({
    id: uuidv7(),
    userId,
    displayName: "최수진",
    notes: "메모",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const conversation = await store.createConversation(newConversation(userId, person.id, recording));
  const detail = await store.getConversationDetail(conversation.id);
  const item = detail!.actionItems[0];

  assert.equal((await store.findActionItem(item.id))?.status, "open");
  const done = await store.updateActionItem({
    ...item,
    status: "done",
    completedAt: new Date(),
  });
  assert.equal(done.status, "done");
  assert.ok(done.completedAt instanceof Date);

  assert.equal((await store.findPerson(userId, "최수진"))?.id, person.id);
  assert.equal(await store.findPerson(userId, "없는사람"), null);
  assert.equal((await store.findPersonById(person.id))?.displayName, "최수진");
  assert.equal((await store.listPersons(userId, 1, 10)).total, 1);
});
