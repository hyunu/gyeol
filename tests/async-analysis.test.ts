import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../apps/api/src/http/server.ts";
import { MemoryStore } from "../apps/api/src/adapters/memory/store.ts";
import { FakeAiPipeline } from "../apps/api/src/adapters/ai/fake-pipeline.ts";
import { AiProviderError } from "../apps/api/src/adapters/ai/http-pipeline.ts";
import { uuidv7 } from "../apps/api/src/domain/ids.ts";
import type { Recording } from "../apps/api/src/domain/types.ts";
import type { AiPipeline, ObjectStorage } from "../apps/api/src/ports/store.ts";
import { defaultDeps, type Deps } from "../apps/api/src/usecases/deps.ts";
import {
  enqueueAnalysis,
  getAnalysisJob,
  runNextAnalysisJob,
} from "../apps/api/src/usecases/analysis.ts";

/**
 * 비동기 분석(ADR-0007) 단위 검증.
 * 워커를 직접 실행해 결정적으로 검사한다(타이머·폴링 없음).
 */

class MemoryStorage implements ObjectStorage {
  private objects = new Map<string, Buffer>();

  async startSession(): Promise<void> {}
  async appendChunk(): Promise<number> {
    throw new Error("not used");
  }
  async commitSession(): Promise<{ size: number; sha256: string }> {
    throw new Error("not used");
  }
  async abortSession(): Promise<void> {}
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async read(key: string): Promise<Buffer> {
    const data = this.objects.get(key);
    if (!data) throw new Error(`없는 객체: ${key}`);
    return data;
  }

  put(key: string, data: Buffer): void {
    this.objects.set(key, data);
  }
}

function mutableClock(start = new Date("2026-11-14T00:00:00Z")) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

async function setup(options: { ai?: AiPipeline; analysis?: Partial<Deps["analysis"]> } = {}) {
  const store = new MemoryStore();
  const storage = new MemoryStorage();
  const clock = mutableClock();
  const deps = defaultDeps({
    store,
    storage,
    ai: options.ai ?? new FakeAiPipeline(),
    clock,
  });
  deps.analysis = { ...deps.analysis, ...options.analysis };

  const userId = uuidv7();
  await store.ensureUser(userId);
  const device = await store.createDevice({
    id: uuidv7(),
    userId,
    serialNo: `GYL-JOB-${userId.slice(0, 8)}`,
    model: "xiao-nrf52840-sense",
    hardwareRevision: null,
    firmwareVersion: "0.0.1",
    lifecycleStatus: "active",
    lastSeenAt: clock.now(),
    batteryPct: 80,
    storageFreeBytes: 1_000_000_000,
    config: {},
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });

  const startedAt = clock.now();
  const recording: Recording = {
    id: uuidv7(),
    userId,
    deviceId: device.id,
    clientRecordingId: `job:${uuidv7()}`,
    deviceSeq: 1,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 12_000),
    capturedOffsetMin: 540,
    durationMs: 12_000,
    codec: "wav_pcm_s16le",
    codecParams: null,
    sampleRateHz: 16_000,
    channels: 1,
    byteSize: 384_000,
    sha256: "a".repeat(64),
    storageKey: `recordings/${uuidv7()}/original`,
    status: "stored",
    vad: null,
    uploadedAt: startedAt,
    integrityVerifiedAt: startedAt,
    storageVerifiedAt: startedAt,
    clientAckAt: startedAt,
    analyzedAt: null,
    purgedAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    deletedAt: null,
  };
  await store.createRecording(recording);
  storage.put(recording.storageKey!, Buffer.from("fake-audio-bytes"));

  return { store, storage, deps, clock, userId, recording };
}

function flakyAi(failures: number): AiPipeline {
  const inner = new FakeAiPipeline();
  let calls = 0;
  return {
    async analyze(input) {
      calls += 1;
      if (calls <= failures) throw new Error(`일시 오류 ${calls}`);
      return inner.analyze(input);
    },
    embedQuery: (text) => inner.embedQuery(text),
  };
}

test("등록은 작업만 만들고, 워커가 실행하면 대화가 생긴다", async () => {
  const { deps, userId, recording, store } = await setup();

  const queued = await enqueueAnalysis(deps, userId, recording.id);
  assert.equal(queued.reused, false);
  assert.equal(queued.job.status, "queued");
  assert.equal(queued.job.attempt, 0);
  assert.equal((await store.findRecording(recording.id))?.status, "stored", "등록만으로는 analyzing 이 아니다");

  assert.equal(await runNextAnalysisJob(deps), true);
  assert.equal(await runNextAnalysisJob(deps), false, "대기 작업이 없다");

  const job = await getAnalysisJob(deps, userId, queued.job.id);
  assert.equal(job.status, "succeeded");
  assert.equal(job.attempt, 1);
  assert.ok(job.conversationId);
  assert.ok(job.finishedAt);
  assert.equal(job.leaseExpiresAt, null);

  const analyzed = await store.findRecording(recording.id);
  assert.equal(analyzed?.status, "analyzed");
  assert.ok(analyzed?.analyzedAt);

  const detail = await store.getConversationDetail(job.conversationId!);
  assert.equal(detail?.segments.length, 3);
});

test("활성 작업이 있으면 새로 만들지 않는다(멱등)", async () => {
  const { deps, userId, recording } = await setup();
  const first = await enqueueAnalysis(deps, userId, recording.id);
  const second = await enqueueAnalysis(deps, userId, recording.id);
  assert.equal(second.reused, true);
  assert.equal(second.job.id, first.job.id);

  await runNextAnalysisJob(deps);
  const after = await enqueueAnalysis(deps, userId, recording.id);
  assert.equal(after.reused, false, "끝난 뒤에는 재분석 작업을 새로 만든다");
  assert.notEqual(after.job.id, first.job.id);
});

test("실패는 백오프 후 재시도하고, 성공하면 종료된다", async () => {
  const { deps, clock, userId, recording } = await setup({
    ai: flakyAi(2),
    analysis: { maxAttempts: 3, retryBaseMs: 10, retryMaxMs: 40 },
  });

  const { job } = await enqueueAnalysis(deps, userId, recording.id);

  await runNextAnalysisJob(deps);
  let current = await getAnalysisJob(deps, userId, job.id);
  assert.equal(current.status, "queued");
  assert.equal(current.attempt, 1);
  assert.match(current.lastError ?? "", /일시 오류 1/);
  assert.equal(current.availableAt.getTime(), clock.now().getTime() + 10);
  assert.equal((await runNextAnalysisJob(deps)), false, "백오프 전에는 실행하지 않는다");

  clock.advance(10);
  await runNextAnalysisJob(deps);
  current = await getAnalysisJob(deps, userId, job.id);
  assert.equal(current.status, "queued");
  assert.equal(current.attempt, 2);

  clock.advance(20);
  await runNextAnalysisJob(deps);
  current = await getAnalysisJob(deps, userId, job.id);
  assert.equal(current.status, "succeeded");
  assert.equal(current.attempt, 3);
  assert.equal(current.lastError, null);
});

test("재시도 한도를 넘기면 작업과 녹음이 실패로 종료된다", async () => {
  const { deps, clock, userId, recording, store } = await setup({
    ai: flakyAi(Number.MAX_SAFE_INTEGER),
    analysis: { maxAttempts: 2, retryBaseMs: 5, retryMaxMs: 5 },
  });

  const { job } = await enqueueAnalysis(deps, userId, recording.id);

  await runNextAnalysisJob(deps);
  clock.advance(5);
  await runNextAnalysisJob(deps);

  const failed = await getAnalysisJob(deps, userId, job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempt, 2);
  assert.ok(failed.finishedAt);
  assert.match(failed.lastError ?? "", /일시 오류/);

  const result = await store.findRecording(recording.id);
  assert.equal(result?.status, "analysis_failed");
});

test("재시도 불가 오류는 첫 시도에 실패로 종료된다", async () => {
  const fatal: AiPipeline = {
    async analyze() {
      throw new AiProviderError("AI_PROVIDER_ERROR", "잘못된 요청", 400, false);
    },
    embedQuery: async () => [],
  };
  const { deps, userId, recording, store } = await setup({
    ai: fatal,
    analysis: { maxAttempts: 3 },
  });

  const { job } = await enqueueAnalysis(deps, userId, recording.id);
  await runNextAnalysisJob(deps);

  const failed = await getAnalysisJob(deps, userId, job.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempt, 1, "재시도하지 않는다");
  assert.match(failed.lastError ?? "", /잘못된 요청/);
  assert.equal((await store.findRecording(recording.id))?.status, "analysis_failed");
});

test("분석 타임아웃은 실패로 기록된다", async () => {
  const hangs: AiPipeline = {
    analyze: () => new Promise(() => undefined),
    embedQuery: async () => [],
  };
  const { deps, userId, recording, store } = await setup({
    ai: hangs,
    analysis: { maxAttempts: 1, timeoutMs: 20 },
  });

  const { job } = await enqueueAnalysis(deps, userId, recording.id);
  await runNextAnalysisJob(deps);

  const failed = await getAnalysisJob(deps, userId, job.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.lastError ?? "", /타임아웃/);
  assert.equal((await store.findRecording(recording.id))?.status, "analysis_failed");
});

test("만료된 임차는 회수되어 다시 선점된다", async () => {
  const { deps, clock, userId, recording, store } = await setup();

  const { job } = await enqueueAnalysis(deps, userId, recording.id);
  const claimed = await store.claimNextAnalysisJob(clock.now());
  assert.equal(claimed?.id, job.id);
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.attempt, 1);

  // 워커가 죽은 상황: 임차를 과거로 만든다.
  await store.updateAnalysisJob({
    ...claimed!,
    leaseExpiresAt: new Date(clock.now().getTime() - 1),
  });

  const recovered = await store.claimNextAnalysisJob(clock.now());
  assert.equal(recovered?.id, job.id);
  assert.equal(recovered?.attempt, 2, "회수 후 다시 선점한다");
});

test("다른 사용자의 작업은 조회할 수 없다", async () => {
  const { deps, userId, recording } = await setup();
  const { job } = await enqueueAnalysis(deps, userId, recording.id);

  await assert.rejects(
    () => getAnalysisJob(deps, uuidv7(), job.id),
    (err: any) => err.code === "NOT_FOUND",
  );
});

test("분석 불가 상태는 작업을 만들지 않는다", async () => {
  const { deps, userId, recording, store } = await setup();
  await store.updateRecording({ ...recording, status: "uploading" });

  await assert.rejects(
    () => enqueueAnalysis(deps, userId, recording.id),
    (err: any) => err.code === "RECORDING_NOT_STORED",
  );
});

test("API 프로세스의 백그라운드 워커가 등록된 작업을 처리한다", async () => {
  const { deps, userId, recording } = await setup();
  const server = createApp({ deps, worker: { enabled: true, intervalMs: 10 } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("listen 실패");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const enqueued = await fetch(`${baseUrl}/api/v1/recordings/${recording.id}/analyze`, {
      method: "POST",
      headers: { "x-user-id": userId },
    });
    assert.equal(enqueued.status, 202);
    const { job } = (await enqueued.json()) as any;

    let current: any = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await fetch(`${baseUrl}/api/v1/analysis-jobs/${job.id}`, {
        headers: { "x-user-id": userId },
      });
      current = ((await res.json()) as any).job;
      if (current.status === "succeeded" || current.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(current?.status, "succeeded", JSON.stringify(current));
    assert.ok(current.conversationId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
