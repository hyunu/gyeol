import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PostgresStore } from "../../apps/api/src/adapters/postgres/store.ts";
import { uuidv7 } from "../../apps/api/src/domain/ids.ts";
import type { AnalysisJob } from "../../apps/api/src/domain/types.ts";
import { makeDevice, makeRecording } from "./helpers.ts";

/**
 * analysis_jobs(0002) PostgreSQL 검증.
 * 선점(claim)의 원자성·임차 회수·부분 유니크 인덱스 의미를 실제 SQL 로 확인한다.
 */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 이 필요합니다.");

const store = new PostgresStore({ connectionString: url });
const cleanup = new pg.Client({ connectionString: url });
await cleanup.connect();

const userIds: string[] = [];

// DB 테스트는 하나의 데이터베이스를 공유한다. 작업 큐는 전역이므로
// 각 테스트 전에 비워 선점 대상이 섞이지 않게 한다(테스트는 순차 실행).
test.beforeEach(async () => {
  await cleanup.query("DELETE FROM analysis_jobs");
});

test.after(async () => {
  for (const userId of userIds) {
    await cleanup.query(
      `DELETE FROM analysis_jobs WHERE user_id = $1`,
      [userId],
    ).catch(() => undefined);
    await cleanup.query(`DELETE FROM recordings WHERE user_id = $1`, [userId]).catch(() => undefined);
    await cleanup.query(`DELETE FROM devices WHERE user_id = $1`, [userId]).catch(() => undefined);
    await cleanup.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => undefined);
  }
  await cleanup.end();
  await store.close();
});

async function fixture() {
  const userId = uuidv7();
  userIds.push(userId);
  await store.ensureUser(userId);
  const device = makeDevice(userId, `GYL-JOB-${uuidv7()}`);
  await store.createDevice(device);
  const recording = makeRecording(userId, device.id, {
    clientRecordingId: `job:${uuidv7()}`,
    storageKey: `recordings/${uuidv7()}/original`,
  });
  await store.createRecording(recording);
  return { userId, device, recording };
}

function queuedJob(userId: string, recordingId: string, overrides: Partial<AnalysisJob> = {}): AnalysisJob {
  const now = new Date("2026-11-14T00:00:00Z");
  return {
    id: uuidv7(),
    userId,
    recordingId,
    status: "queued",
    attempt: 0,
    maxAttempts: 3,
    timeoutMs: 300_000,
    availableAt: now,
    startedAt: null,
    finishedAt: null,
    leaseExpiresAt: null,
    conversationId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("생성: 활성 작업은 녹음당 1개, 끝난 뒤에는 새 작업을 만들 수 있다", async () => {
  const { userId, recording } = await fixture();
  const first = await store.createAnalysisJob(queuedJob(userId, recording.id));
  assert.equal(first.status, "queued");

  const duplicate = await store.createAnalysisJob(queuedJob(userId, recording.id));
  assert.equal(duplicate.id, first.id, "부분 유니크 인덱스가 중복 활성 작업을 막는다");
  assert.equal((await store.findActiveAnalysisJob(recording.id))?.id, first.id);

  await store.updateAnalysisJob({
    ...first,
    status: "failed",
    finishedAt: new Date(),
    updatedAt: new Date(),
  });
  assert.equal(await store.findActiveAnalysisJob(recording.id), null);

  const next = await store.createAnalysisJob(queuedJob(userId, recording.id));
  assert.notEqual(next.id, first.id);
});

test("선점: 실행 중에는 다른 선점이 없고, attempt 가 증가한다", async () => {
  const { userId, device, recording } = await fixture();
  const created = await store.createAnalysisJob(queuedJob(userId, recording.id));

  const claimed = await store.claimNextAnalysisJob(created.availableAt);
  assert.equal(claimed?.id, created.id);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.attempt, 1);
  assert.ok(claimed?.leaseExpiresAt);

  assert.equal(await store.claimNextAnalysisJob(created.availableAt), null, "임차 중복 선점 금지");

  // 실행 가능 시각이 미래인 작업은 그 시각 전에는 선점하지 않는다.
  const other = makeRecording(userId, device.id, {
    clientRecordingId: `job:${uuidv7()}`,
    storageKey: `recordings/${uuidv7()}/original`,
  });
  await store.createRecording(other);
  const later = await store.createAnalysisJob(
    queuedJob(userId, other.id, {
      availableAt: new Date(created.availableAt.getTime() + 60_000),
    }),
  );
  assert.equal(await store.claimNextAnalysisJob(created.availableAt), null);
  const future = await store.claimNextAnalysisJob(
    new Date(created.availableAt.getTime() + 60_000),
  );
  assert.equal(future?.id, later.id);
});

test("임차 만료: 재시도 여지가 있으면 회수하고, 한도를 넘으면 실패로 종료한다", async () => {
  const { userId, recording } = await fixture();
  const created = await store.createAnalysisJob(queuedJob(userId, recording.id, { maxAttempts: 2 }));
  const claimed = await store.claimNextAnalysisJob(created.availableAt);
  assert.equal(claimed?.attempt, 1);

  const expiredAt = new Date(claimed!.leaseExpiresAt!.getTime() + 1);
  await store.updateAnalysisJob({
    ...claimed!,
    leaseExpiresAt: new Date(claimed!.leaseExpiresAt!.getTime() - 1),
  });

  const recovered = await store.claimNextAnalysisJob(expiredAt);
  assert.equal(recovered?.id, created.id);
  assert.equal(recovered?.attempt, 2, "회수 후 다시 선점한다");

  // 두 번째 임차도 만료되면 attempt(2) >= maxAttempts(2) 이므로 실패로 끝난다.
  await store.updateAnalysisJob({
    ...recovered!,
    leaseExpiresAt: new Date(recovered!.leaseExpiresAt!.getTime() - 1),
  });
  const after = new Date(recovered!.leaseExpiresAt!.getTime() + 1);
  assert.equal(await store.claimNextAnalysisJob(after), null);

  const failed = await store.findAnalysisJob(created.id);
  assert.equal(failed?.status, "failed");
  assert.ok(failed?.finishedAt);
  assert.match(failed?.lastError ?? "", /임차 만료/);
});

test("재시도 대기(queued + 미래 availableAt)는 시각이 되기 전에는 선점하지 않는다", async () => {
  const { userId, recording } = await fixture();
  const created = await store.createAnalysisJob(queuedJob(userId, recording.id));
  const claimed = await store.claimNextAnalysisJob(created.availableAt);

  const retryAt = new Date(created.availableAt.getTime() + 5000);
  await store.updateAnalysisJob({
    ...claimed!,
    status: "queued",
    availableAt: retryAt,
    leaseExpiresAt: null,
    lastError: "일시 오류",
    updatedAt: claimed!.updatedAt,
  });

  assert.equal(await store.claimNextAnalysisJob(created.availableAt), null);
  const retried = await store.claimNextAnalysisJob(retryAt);
  assert.equal(retried?.id, created.id);
  assert.equal(retried?.attempt, 2);
  assert.equal(retried?.lastError, "일시 오류");
});
