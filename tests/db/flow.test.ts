import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { createApp } from "../../apps/api/src/http/server.ts";
import { PostgresStore } from "../../apps/api/src/adapters/postgres/store.ts";
import { LocalDiskStorage } from "../../apps/api/src/adapters/storage/local-disk.ts";
import { FakeAiPipeline } from "../../apps/api/src/adapters/ai/fake-pipeline.ts";
import { uuidv7 } from "../../apps/api/src/domain/ids.ts";
import { defaultDeps } from "../../apps/api/src/usecases/deps.ts";
import { FakeWearable } from "../../packages/device-fake/index.ts";
import { FakePhone } from "../../packages/mobile-fake/index.ts";

/**
 * PostgreSQL 저장소로 전체 흐름을 다시 검증한다.
 * 시나리오는 tests/integration.test.ts 와 같지만, 저장소만 실제 DB 로 바꾼다.
 */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 이 필요합니다.");

const USER = uuidv7();
const store = new PostgresStore({ connectionString: url });
const cleanup = new pg.Client({ connectionString: url });
await cleanup.connect();
await store.ensureUser(USER);

test.after(async () => {
  for (const table of ["conversations", "recordings", "persons", "devices"]) {
    await cleanup.query(`DELETE FROM ${table} WHERE user_id = $1`, [USER]).catch(() => undefined);
  }
  await cleanup.query("DELETE FROM users WHERE id = $1", [USER]).catch(() => undefined);
  await cleanup.end();
  await store.close();
});

test("전 구간(PostgreSQL): 업로드 재개 → 검증 → ACK → 분석 → 검색 → 재분석 → 삭제", async () => {
  const storageDir = await mkdtemp(path.join(tmpdir(), "gyeol-db-flow-"));
  const deps = defaultDeps({
    store,
    storage: new LocalDiskStorage(storageDir),
    ai: new FakeAiPipeline(),
  });
  const server = createApp({ deps, storageDir, env: "local" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("listen 실패");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const call = async (method: string, pathName: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${pathName}`, {
      method,
      headers: {
        "x-user-id": USER,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };

  try {
    const wearable = new FakeWearable(`GYL-DBFLOW-${Date.now()}`);
    const phone = new FakePhone({ bleChunkBytes: 4096, httpChunkBytes: 65536 });

    const registered = await call("POST", "/api/v1/devices", {
      serialNo: wearable.serialNo,
      model: wearable.model,
      firmwareVersion: wearable.firmwareVersion,
    });
    assert.equal(registered.status, 201);

    const first = await wearable.capture({ durationMs: 12_000 });
    await wearable.capture({ durationMs: 8_000, toneHz: 660 });

    const interrupted = await phone.pull(wearable, { interruptAtBytes: 5000 });
    assert.equal(interrupted.interrupted, true);
    assert.equal((await phone.pull(wearable)).interrupted, false);
    assert.equal((await wearable.status()).pendingFiles, 0);

    const partial = await phone.upload(
      baseUrl,
      USER,
      registered.body.id,
      first.clientRecordingId,
      { interruptAtBytes: 100 * 1024 },
    );
    assert.equal(partial.interrupted, true);
    const midway = await call("GET", `/api/v1/recordings/${phone.get(first.clientRecordingId).recordingId}`);
    assert.equal(midway.body.recording.status, "uploading");
    assert.equal(midway.body.recording.deletable, false);

    await phone.upload(baseUrl, USER, registered.body.id, first.clientRecordingId);
    const item = phone.get(first.clientRecordingId);
    assert.equal(item.serverStatus, "stored");
    assert.equal(item.deletable, false, "ACK 전에는 삭제할 수 없다");

    const beforeAck = await call("GET", `/api/v1/recordings/${item.recordingId}`);
    assert.equal(beforeAck.body.recording.audioAvailable, true);
    const denied = await call("DELETE", `/api/v1/recordings/${item.recordingId}`);
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, "RECORDING_NOT_DELETABLE");

    const acked = await phone.acknowledge(baseUrl, USER, first.clientRecordingId);
    assert.equal(acked.deletable, true);

    const analyzed = await call("POST", `/api/v1/recordings/${item.recordingId}/analyze`);
    assert.equal(analyzed.status, 202);
    const conversationId = analyzed.body.conversationId;
    assert.equal(analyzed.body.recording.status, "analyzed");

    const detail = await call("GET", `/api/v1/conversations/${conversationId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.segments.length, 3);
    assert.equal(detail.body.speakers.length, 2);
    const unknown = detail.body.speakers.find((s: any) => s.identificationStatus === "unknown");
    assert.equal(unknown.personId, null);
    assert.equal(detail.body.people.length, 1);

    const personId = detail.body.people[0].id;
    const byPerson = await call("GET", `/api/v1/conversations?personId=${personId}`);
    assert.equal(byPerson.body.total, 1);
    const search = await call("GET", `/api/v1/conversations?q=${encodeURIComponent("북한산")}`);
    assert.equal(search.body.total, 1);
    assert.equal(search.body.items[0].id, conversationId);

    const reanalyzed = await call("POST", `/api/v1/recordings/${item.recordingId}/analyze`);
    assert.equal(reanalyzed.status, 202);
    assert.equal(reanalyzed.body.conversationId, conversationId);
    const after = await call("GET", `/api/v1/conversations/${conversationId}`);
    assert.equal(after.body.analysisVersion, 2);
    assert.equal(after.body.segments.length, 3, "재분석은 파생을 교체한다");
    assert.deepEqual(after.body.recordingIds, [item.recordingId]);

    const actionItem = after.body.actionItems[0];
    const patched = await call("PATCH", `/api/v1/action-items/${actionItem.id}`, { status: "done" });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.status, "done");

    const removed = await call("DELETE", `/api/v1/recordings/${item.recordingId}`);
    assert.equal(removed.status, 204);
    const purged = await call("GET", `/api/v1/recordings/${item.recordingId}`);
    assert.equal(purged.body.recording.status, "purged");
    assert.equal(purged.body.recording.audioAvailable, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(storageDir, { recursive: true, force: true });
  }
});
