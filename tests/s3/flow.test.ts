import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../apps/api/src/http/server.ts";
import { MemoryStore } from "../../apps/api/src/adapters/memory/store.ts";
import { S3Storage } from "../../apps/api/src/adapters/storage/s3.ts";
import { FakeAiPipeline } from "../../apps/api/src/adapters/ai/fake-pipeline.ts";
import { uuidv7 } from "../../apps/api/src/domain/ids.ts";
import { defaultDeps } from "../../apps/api/src/usecases/deps.ts";
import { drainAnalysisJobs } from "../../apps/api/src/usecases/analysis.ts";
import { FakeWearable } from "../../packages/device-fake/index.ts";
import { FakePhone } from "../../packages/mobile-fake/index.ts";

/**
 * S3 스토리지로 전 구간(기기 → BLE → 업로드 → 검증 → ACK → 분석)을 검증한다.
 * 저장소는 메모리, 오브젝트만 MinIO 를 쓴다.
 */

if (!process.env.S3_ENDPOINT) throw new Error("S3_ENDPOINT 가 필요합니다.");

const USER = uuidv7();
const storage = new S3Storage();

test("S3 스토리지: 업로드 재개 → 검증 → ACK → 분석이 실제 객체로 동작한다", async () => {
  const deps = defaultDeps({
    store: new MemoryStore(),
    storage,
    ai: new FakeAiPipeline(),
  });
  const server = createApp({ deps, env: "local", worker: { enabled: false } });
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

  let recordingId: string | null = null;

  try {
    const wearable = new FakeWearable(`GYL-S3-${Date.now()}`);
    const phone = new FakePhone({ bleChunkBytes: 4096, httpChunkBytes: 65_536 });

    const registered = await call("POST", "/api/v1/devices", {
      serialNo: wearable.serialNo,
      model: wearable.model,
      firmwareVersion: wearable.firmwareVersion,
    });
    assert.equal(registered.status, 201);

    const file = await wearable.capture({ durationMs: 9000 });
    await phone.pull(wearable);

    const interrupted = await phone.upload(
      baseUrl,
      USER,
      registered.body.id,
      file.clientRecordingId,
      { interruptAtBytes: 100 * 1024 },
    );
    assert.equal(interrupted.interrupted, true);

    const resumed = await phone.upload(baseUrl, USER, registered.body.id, file.clientRecordingId);
    assert.equal(resumed.interrupted, false);
    recordingId = phone.get(file.clientRecordingId).recordingId ?? null;
    assert.ok(recordingId, "업로드 후 서버 녹음 id 가 있어야 합니다.");

    const stored = await call("GET", `/api/v1/recordings/${recordingId}`);
    assert.equal(stored.body.recording.status, "stored");
    assert.equal(stored.body.recording.audioAvailable, true);

    const acked = await phone.acknowledge(baseUrl, USER, file.clientRecordingId);
    assert.equal(acked.deletable, true);

    const analyze = await call("POST", `/api/v1/recordings/${recordingId}/analyze`);
    assert.equal(analyze.status, 202);
    await drainAnalysisJobs(deps);

    const job = await call("GET", `/api/v1/analysis-jobs/${analyze.body.job.id}`);
    assert.equal(job.body.job.status, "succeeded");
    const detail = await call("GET", `/api/v1/conversations/${job.body.job.conversationId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.segments.length, 3);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (recordingId) {
      await storage.delete(`recordings/${recordingId}/original`).catch(() => undefined);
    }
  }
});
