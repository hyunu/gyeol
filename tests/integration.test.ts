import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../apps/api/src/http/server.ts";
import { MemoryStore } from "../apps/api/src/adapters/memory/store.ts";
import { LocalDiskStorage } from "../apps/api/src/adapters/storage/local-disk.ts";
import { FakeAiPipeline } from "../apps/api/src/adapters/ai/fake-pipeline.ts";
import { defaultDeps, type Deps } from "../apps/api/src/usecases/deps.ts";
import { drainAnalysisJobs } from "../apps/api/src/usecases/analysis.ts";
import { FakeWearable } from "../packages/device-fake/index.ts";
import { FakePhone, parseOffsetMismatch } from "../packages/mobile-fake/index.ts";
import { runContractTests } from "../tools/contract-test.mjs";

const USER = "0199aaaa-0000-7000-8000-000000000001";

interface Harness {
  baseUrl: string;
  deps: Deps;
  storageDir: string;
  close(): Promise<void>;
  call(method: string, pathName: string, body?: unknown): Promise<{ status: number; body: any }>;
}

let activeCleanup: Array<() => Promise<void>> = [];

async function startApp(options: { env?: string; uploadTtlMs?: number; clock?: { now(): Date } } = {}): Promise<Harness> {
  const storageDir = await mkdtemp(path.join(tmpdir(), "gyeol-"));
  const deps = defaultDeps({
    store: new MemoryStore(),
    storage: new LocalDiskStorage(storageDir),
    ai: new FakeAiPipeline(),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  if (options.uploadTtlMs !== undefined) deps.upload = { ...deps.upload, sessionTtlMs: options.uploadTtlMs };

  const server = createApp({ deps, storageDir, env: options.env ?? "local", worker: { enabled: false } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("listen 실패");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const cleanup = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(storageDir, { recursive: true, force: true });
  };
  activeCleanup.push(cleanup);

  return {
    baseUrl,
    deps,
    storageDir,
    close: cleanup,
    async call(method, pathName, body) {
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
    },
  };
}

async function putChunk(
  harness: Harness,
  recordingId: string,
  sessionId: string,
  offset: number,
  chunk: Buffer,
): Promise<{ status: number; body: any }> {
  const res = await fetch(
    `${harness.baseUrl}/api/v1/recordings/${recordingId}/upload-sessions/${sessionId}/chunks?offset=${offset}`,
    {
      method: "PUT",
      headers: { "x-user-id": USER, "content-type": "application/octet-stream" },
      body: chunk,
    },
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function uploadAllBytes(harness: Harness, recordingId: string, sessionId: string, bytes: Buffer) {
  let offset = 0;
  let last: any;
  while (offset < bytes.length) {
    const length = Math.min(64 * 1024, bytes.length - offset);
    const res = await putChunk(harness, recordingId, sessionId, offset, bytes.subarray(offset, offset + length));
    assert.equal(res.status, 200, `청크 실패: ${JSON.stringify(res.body)}`);
    last = res.body;
    offset += length;
  }
  return last;
}

test.after(async () => {
  for (const cleanup of activeCleanup) await cleanup().catch(() => undefined);
  activeCleanup = [];
});

test("전 구간: 기기 → BLE(중단/재개) → 업로드(중단/재개) → 검증 → ACK → 분석 → 검색", async () => {
  const harness = await startApp();
  const wearable = new FakeWearable("GYL-IT-0001");
  const phone = new FakePhone({ bleChunkBytes: 4096, httpChunkBytes: 65536 });

  // 1) 기기 등록
  const registered = await harness.call("POST", "/api/v1/devices", {
    serialNo: wearable.serialNo,
    model: wearable.model,
    firmwareVersion: wearable.firmwareVersion,
  });
  assert.equal(registered.status, 201);
  const deviceId = registered.body.id;
  assert.equal(registered.body.online, true);

  // 2) 폰 없이 기기에 2건 녹음 (독립 저장)
  const first = await wearable.capture({ durationMs: 12_000 });
  const second = await wearable.capture({ durationMs: 8_000, toneHz: 660 });
  assert.equal((await wearable.status()).pendingFiles, 2, "폰이 없으면 기기에 계속 쌓인다");

  // 3) BLE 전송 중단 → 재개
  const interrupted = await phone.pull(wearable, { interruptAtBytes: 5000 });
  assert.equal(interrupted.interrupted, true);
  assert.equal((await wearable.status()).pendingFiles, 2, "중단 중에는 기기 파일이 남아야 한다");

  const resumed = await phone.pull(wearable);
  assert.equal(resumed.interrupted, false);
  assert.equal((await wearable.status()).pendingFiles, 0, "수신 확인 후 기기에서 삭제");

  // 4) 업로드 중단 → 재개
  const partial = await phone.upload(harness.baseUrl, USER, deviceId, first.clientRecordingId, {
    interruptAtBytes: 100 * 1024,
  });
  assert.equal(partial.interrupted, true);
  const firstRecord = await harness.call("GET", `/api/v1/recordings/${phone.get(first.clientRecordingId).recordingId}`);
  assert.equal(firstRecord.body.recording.status, "uploading");
  assert.equal(firstRecord.body.recording.deletable, false);

  const done = await phone.upload(harness.baseUrl, USER, deviceId, first.clientRecordingId);
  assert.equal(done.interrupted, false);
  const item = phone.get(first.clientRecordingId);
  assert.equal(item.serverStatus, "stored");
  assert.equal(item.deletable, false, "ACK 전에는 deletable=false");

  // 5) M-04: ACK 전 삭제 불가
  const beforeAck = await harness.call("GET", `/api/v1/recordings/${item.recordingId}`);
  assert.equal(beforeAck.body.recording.audioAvailable, true);
  assert.equal(beforeAck.body.recording.deletable, false);
  assert.equal(beforeAck.body.recording.integrityVerifiedAt !== null, true);
  assert.equal(beforeAck.body.recording.storageVerifiedAt !== null, true);

  const deleteBeforeAck = await harness.call("DELETE", `/api/v1/recordings/${item.recordingId}`);
  assert.equal(deleteBeforeAck.status, 409);
  assert.equal(deleteBeforeAck.body.code, "RECORDING_NOT_DELETABLE");
  assert.throws(() => phone.deleteLocalAfterAck(first.clientRecordingId), /ACK 전/);

  // 6) ACK → 삭제 가능
  const acked = await phone.acknowledge(harness.baseUrl, USER, first.clientRecordingId);
  assert.equal(acked.deletable, true);
  section: {
    const after = await harness.call("GET", `/api/v1/recordings/${item.recordingId}`);
    assert.equal(after.body.recording.deletable, true);
    assert.equal(after.body.recording.clientAckAt !== null, true);
  }
  phone.deleteLocalAfterAck(first.clientRecordingId);

  // 7) 분석: 작업 등록 → 워커 실행 → 대화 생성
  const analyzed = await harness.call("POST", `/api/v1/recordings/${item.recordingId}/analyze`);
  assert.equal(analyzed.status, 202);
  assert.equal(analyzed.body.job.status, "queued");
  assert.equal(analyzed.body.recording.status, "stored", "등록만 하고 바로 분석하지 않는다");
  const jobId = analyzed.body.job.id;

  const queued = await harness.call("GET", `/api/v1/analysis-jobs/${jobId}`);
  assert.equal(queued.status, 200);
  assert.equal(queued.body.job.status, "queued");
  assert.equal(queued.body.job.conversationId, null);

  await drainAnalysisJobs(harness.deps);
  const finished = await harness.call("GET", `/api/v1/analysis-jobs/${jobId}`);
  assert.equal(finished.body.job.status, "succeeded");
  assert.equal(finished.body.job.attempt, 1);
  assert.ok(finished.body.job.finishedAt);
  const conversationId = finished.body.job.conversationId;

  const afterAnalysis = await harness.call("GET", `/api/v1/recordings/${item.recordingId}`);
  assert.equal(afterAnalysis.body.recording.status, "analyzed");

  const detail = await harness.call("GET", `/api/v1/conversations/${conversationId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.status, "ready");
  assert.equal(detail.body.analysisVersion, 1);
  assert.equal(detail.body.segments.length, 3);
  assert.equal(detail.body.speakers.length, 2);

  const identified = detail.body.speakers.find((s: any) => s.identificationStatus === "suggested");
  const unknown = detail.body.speakers.find((s: any) => s.identificationStatus === "unknown");
  assert.ok(identified, "임계값을 넘은 화자는 suggested");
  assert.equal(identified.displayName, "김민수");
  assert.ok(unknown, "미달 화자는 unknown");
  assert.equal(unknown.personId, null, "Unknown Speaker 는 person 행을 만들지 않는다");
  assert.equal(detail.body.people.length, 1, "식별된 사람만 people 에 포함");
  assert.ok(detail.body.entities.length >= 2);
  assert.equal(detail.body.actionItems.length, 1);

  // 8) 인물별 조회 / 검색
  const personId = detail.body.people[0].id;
  const byPerson = await harness.call("GET", `/api/v1/conversations?personId=${personId}`);
  assert.equal(byPerson.body.total, 1);
  assert.equal(byPerson.body.items[0].id, conversationId);

  const search = await harness.call("GET", `/api/v1/conversations?q=${encodeURIComponent("북한산")}`);
  assert.equal(search.status, 200);
  assert.equal(search.body.total, 1);
  assert.equal(search.body.items[0].id, conversationId);

  const persons = await harness.call("GET", "/api/v1/persons");
  assert.equal(persons.body.total, 1);

  // 8-b) 재분석: 파생 데이터 교체(중복 누적 없음), 대화는 1건 유지
  const reanalyzed = await harness.call("POST", `/api/v1/recordings/${item.recordingId}/analyze`);
  assert.equal(reanalyzed.status, 202);
  assert.equal(reanalyzed.body.job.recordingId, item.recordingId);
  assert.notEqual(reanalyzed.body.job.id, jobId, "끝난 작업 뒤에는 새 작업을 만든다");
  await drainAnalysisJobs(harness.deps);
  const reJob = await harness.call("GET", `/api/v1/analysis-jobs/${reanalyzed.body.job.id}`);
  assert.equal(reJob.body.job.status, "succeeded");
  assert.equal(reJob.body.job.conversationId, conversationId, "재분석은 같은 대화를 갱신");
  const afterReanalysis = await harness.call("GET", `/api/v1/conversations/${conversationId}`);
  assert.equal(afterReanalysis.body.analysisVersion, 2);
  assert.equal(afterReanalysis.body.segments.length, 3, "세그먼트가 누적되지 않고 교체됨");
  assert.deepEqual(afterReanalysis.body.recordingIds, [item.recordingId], "M-01 연결 유지");
  const stillOne = await harness.call("GET", "/api/v1/conversations");
  assert.equal(stillOne.body.total, 1);

  // 9) 할 일 상태 변경
  const actionItemId = afterReanalysis.body.actionItems[0].id;
  const patched = await harness.call("PATCH", `/api/v1/action-items/${actionItemId}`, { status: "done" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.status, "done");
  assert.ok(patched.body.completedAt);

  // 10) 실데이터로 계약 검증
  const contract = await runContractTests(harness.baseUrl);
  assert.deepEqual(contract.failures, [], `계약 위반:\n${contract.failures.join("\n")}`);
  assert.ok(contract.tested.filter((t: any) => !t.skipped).length >= 5);

  // 11) 원본 삭제
  const deleted = await harness.call("DELETE", `/api/v1/recordings/${item.recordingId}`);
  assert.equal(deleted.status, 204);
  const purged = await harness.call("GET", `/api/v1/recordings/${item.recordingId}`);
  assert.equal(purged.body.recording.status, "purged");
  assert.equal(purged.body.recording.audioAvailable, false);
  assert.equal(purged.body.recording.deletable, false);

  const objectPath = path.join(harness.storageDir, "objects", "recordings", item.recordingId!, "original");
  await assert.rejects(access(objectPath), "오브젝트 스토리지에서 원본이 삭제되어야 한다");

  // 12) 두 번째 녹음도 독립적으로 처리 가능
  await phone.upload(harness.baseUrl, USER, deviceId, second.clientRecordingId);
  const secondId = phone.get(second.clientRecordingId).recordingId!;
  const secondAnalyzed = await harness.call("POST", `/api/v1/recordings/${secondId}/analyze`);
  assert.equal(secondAnalyzed.status, 202);
  await drainAnalysisJobs(harness.deps);
  const all = await harness.call("GET", "/api/v1/conversations");
  assert.equal(all.body.total, 2, "서로 다른 대화 2건");
});

test("OFFSET_MISMATCH 복구는 서버 기대 오프셋(expected)을 사용한다", async () => {
  assert.equal(parseOffsetMismatch("expected=1234 received=999"), 1234);
  assert.equal(parseOffsetMismatch("received=512"), 512, "구 형식은 received 로 폴백");
  assert.equal(parseOffsetMismatch("오프셋 없음"), null);

  const harness = await startApp();
  const wearable = new FakeWearable("GYL-IT-OFFSET");
  const phone = new FakePhone({ bleChunkBytes: 4096, httpChunkBytes: 4096 });
  const captured = await wearable.capture({ durationMs: 2_000 });
  await phone.pull(wearable);
  const device = await harness.call("POST", "/api/v1/devices", {
    serialNo: wearable.serialNo,
    model: wearable.model,
  });
  const file = phone.get(captured.clientRecordingId);

  const partial = await phone.upload(harness.baseUrl, USER, device.body.id, file.file.clientRecordingId, {
    interruptAtBytes: 4096,
  });
  assert.equal(partial.interrupted, true);
  assert.equal(partial.uploadedBytes, 4096);

  // 앱 재시작으로 로컬 오프셋이 0 이 됐다고 가정한다. 서버는 이미 4096 바이트를 받았다.
  file.uploadedBytes = 0;
  const resumed = await phone.upload(harness.baseUrl, USER, device.body.id, file.file.clientRecordingId);
  assert.equal(resumed.interrupted, false);
  assert.equal(resumed.uploadedBytes, file.file.bytes.length);
  assert.equal(file.serverStatus, "stored");
});

test("세션 만료는 Recording 삭제가 아니며 새 세션으로 재전송할 수 있다", async () => {
  let now = new Date("2026-11-13T06:00:00Z");
  const harness = await startApp({ uploadTtlMs: 1000, clock: { now: () => now } });

  const wearable = new FakeWearable("GYL-IT-0002");
  const device = await harness.call("POST", "/api/v1/devices", {
    serialNo: wearable.serialNo,
    model: wearable.model,
  });
  const file = await wearable.capture({ durationMs: 2000 });

  const created = await harness.call("POST", "/api/v1/recordings", {
    deviceId: device.body.id,
    clientRecordingId: file.clientRecordingId,
    startedAt: file.startedAt.toISOString(),
    endedAt: file.endedAt.toISOString(),
    durationMs: file.durationMs,
    codec: file.codec,
    sampleRateHz: file.sampleRateHz,
    channels: file.channels,
    byteSize: file.bytes.length,
    sha256: file.sha256,
  });
  assert.equal(created.status, 201);
  const recordingId = created.body.recording.id;
  const oldSessionId = created.body.uploadSession.id;

  now = new Date(now.getTime() + 5000);
  const expiredAttempt = await putChunk(harness, recordingId, oldSessionId, 0, file.bytes.subarray(0, 1024));
  assert.equal(expiredAttempt.status, 409);
  assert.equal(expiredAttempt.body.code, "SESSION_NOT_OPEN");

  const stillThere = await harness.call("GET", `/api/v1/recordings/${recordingId}`);
  assert.equal(stillThere.status, 200, "세션 만료가 녹음 삭제를 의미하지 않는다");
  assert.equal(stillThere.body.recording.status, "initiated");

  const fresh = await harness.call("POST", `/api/v1/recordings/${recordingId}/upload-sessions`);
  assert.equal(fresh.status, 201);
  assert.notEqual(fresh.body.uploadSession.id, oldSessionId);

  const completed = await uploadAllBytes(harness, recordingId, fresh.body.uploadSession.id, file.bytes);
  assert.equal(completed.recording.status, "stored");
});

test("무결성 불일치 데이터는 stored 가 되지 않고 분석에 투입되지 않는다", async () => {
  const harness = await startApp();
  const wearable = new FakeWearable("GYL-IT-0003");
  const device = await harness.call("POST", "/api/v1/devices", {
    serialNo: wearable.serialNo,
    model: wearable.model,
  });
  const file = await wearable.capture({ durationMs: 3000 });

  const created = await harness.call("POST", "/api/v1/recordings", {
    deviceId: device.body.id,
    clientRecordingId: file.clientRecordingId,
    startedAt: file.startedAt.toISOString(),
    endedAt: file.endedAt.toISOString(),
    durationMs: file.durationMs,
    codec: file.codec,
    sampleRateHz: file.sampleRateHz,
    channels: file.channels,
    byteSize: file.bytes.length,
    sha256: "f".repeat(64),
  });
  const recordingId = created.body.recording.id;
  const sessionId = created.body.uploadSession.id;

  const result = await uploadAllBytes(harness, recordingId, sessionId, file.bytes);
  assert.equal(result.recording.status, "integrity_failed");
  assert.equal(result.uploadSession.status, "aborted");

  const fetched = await harness.call("GET", `/api/v1/recordings/${recordingId}`);
  assert.equal(fetched.body.recording.audioAvailable, false);
  assert.equal(fetched.body.recording.deletable, false);

  const analyze = await harness.call("POST", `/api/v1/recordings/${recordingId}/analyze`);
  assert.equal(analyze.status, 409);
  assert.equal(analyze.body.code, "RECORDING_NOT_STORED");

  const objectDir = path.join(harness.storageDir, "objects", "recordings", recordingId);
  await assert.rejects(access(objectDir), "검증 실패 바이트는 저장되면 안 된다");
});

test("운영 환경에서는 X-User-Id 임시 인증이 차단된다 (fail-closed)", async () => {
  const harness = await startApp({ env: "production" });

  const denied = await harness.call("GET", "/api/v1/devices");
  assert.equal(denied.status, 401);
  assert.equal(denied.body.code, "UNAUTHORIZED");

  const health = await fetch(`${harness.baseUrl}/healthz`);
  assert.equal(health.status, 200, "상태 확인은 인증 없이 동작한다");
});

test("알 수 없는 필드는 거부한다 (계약 additionalProperties: false)", async () => {
  const harness = await startApp();
  const res = await harness.call("POST", "/api/v1/devices", {
    serialNo: "GYL-IT-0005",
    model: "xiao-nrf52840-sense",
    unexpected: true,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "VALIDATION_FAILED");
});
