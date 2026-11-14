#!/usr/bin/env node
/**
 * API 성능 기준선 (W-28).
 *
 * 실제 AI provider 없이 서버·PostgreSQL 경로의 지연을 측정한다.
 * 데이터는 임시 사용자로 만들고 끝나면 삭제한다.
 *
 * 사용:
 *   DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol \
 *   GYEOL_STORE=postgres npm run bench
 */
import { mkdtemp } from "node:fs/promises";
import pg from "pg";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../apps/api/src/http/server.ts";
import { PostgresStore } from "../apps/api/src/adapters/postgres/store.ts";
import { LocalDiskStorage } from "../apps/api/src/adapters/storage/local-disk.ts";
import { FakeAiPipeline } from "../apps/api/src/adapters/ai/fake-pipeline.ts";
import { uuidv7 } from "../apps/api/src/domain/ids.ts";
import { defaultDeps } from "../apps/api/src/usecases/deps.ts";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("✗ DATABASE_URL 이 필요합니다.");
  process.exit(1);
}

const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 20);
const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? 5000);
const CONVERSATIONS = Number(process.env.BENCH_CONVERSATIONS ?? 120);
const USER = uuidv7();
const WITH_INDEX = process.env.BENCH_INDEX === "1";

const store = new PostgresStore({ connectionString: DATABASE_URL });
const storageDir = await mkdtemp(path.join(tmpdir(), "gyeol-bench-"));
const deps = defaultDeps({
  store,
  storage: new LocalDiskStorage(storageDir),
  ai: new FakeAiPipeline(),
});

const server = createApp({
  deps,
  storageDir,
  env: "local",
  worker: { enabled: false },
  logger: { info: () => undefined, error: () => undefined },
});

const indexClient = WITH_INDEX ? new pg.Client({ connectionString: DATABASE_URL }) : null;
if (indexClient) await indexClient.connect();

try {
  if (indexClient) {
    console.log("[bench] trigram 인덱스 생성 중…");
    await indexClient.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await indexClient.query(
      "CREATE INDEX IF NOT EXISTS bench_segments_trgm ON transcript_segments USING gin (text gin_trgm_ops)",
    );
    await indexClient.query(
      "CREATE INDEX IF NOT EXISTS bench_title_trgm ON conversations USING gin (title gin_trgm_ops)",
    );
    await indexClient.query(
      "CREATE INDEX IF NOT EXISTS bench_summary_trgm ON conversations USING gin (summary gin_trgm_ops)",
    );
  }

  const seeded = await seed();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("listen 실패");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { "x-user-id": USER };

  console.log(
    `# API 성능 기준선\n\n- 동시성 ${CONCURRENCY}, 시나리오 ${DURATION_MS}ms, 대화 ${seeded.count}건\n`,
  );
  console.log("| 시나리오 | 요청 수 | RPS | p50 | p95 | p99 | 오류 |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");

  const scenarios = [
    ["대화 목록", `${baseUrl}/api/v1/conversations?size=20`],
    ["대화 상세", `${baseUrl}/api/v1/conversations/${seeded.conversationId}`],
    ["키워드 검색(광범위)", `${baseUrl}/api/v1/conversations?q=${encodeURIComponent("bench")}`],
    ["키워드 검색(선택적)", `${baseUrl}/api/v1/conversations?q=${encodeURIComponent("code-9999")}`],
    ["기기 목록", `${baseUrl}/api/v1/devices`],
  ];

  let failed = false;
  for (const [name, url] of scenarios) {
    const result = await measure(url, headers);
    if (result.errors > 0) failed = true;
    console.log(
      `| ${name} | ${result.requests} | ${result.rps.toFixed(1)} | ${fmt(result.p50)} | ${fmt(result.p95)} | ${fmt(result.p99)} | ${result.errors} |`,
    );
  }

  if (failed) process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
  await store.purgeUser(USER).catch(() => undefined);
  if (indexClient) {
    for (const index of ["bench_segments_trgm", "bench_title_trgm", "bench_summary_trgm"]) {
      await indexClient.query(`DROP INDEX IF EXISTS ${index}`).catch(() => undefined);
    }
    await indexClient.end();
  }
  await store.close?.();
}

async function seed() {
  await store.ensureUser(USER);
  const device = await store.createDevice({
    id: uuidv7(),
    userId: USER,
    serialNo: `GYL-BENCH-${uuidv7()}`,
    model: "bench",
    hardwareRevision: null,
    firmwareVersion: "0",
    lifecycleStatus: "active",
    lastSeenAt: new Date(),
    batteryPct: 50,
    storageFreeBytes: 1_000_000_000,
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const persons = [];
  for (let i = 0; i < 5; i += 1) {
    persons.push(
      await store.createPerson({
        id: uuidv7(),
        userId: USER,
        displayName: `벤치 인물 ${i}`,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  }

  let conversationId = "";
  const base = Date.now();
  for (let i = 0; i < CONVERSATIONS; i += 1) {
    const startedAt = new Date(base - i * 3_600_000);
    const endedAt = new Date(startedAt.getTime() + 5 * 60_000);
    const recording = await store.createRecording({
      id: uuidv7(),
      userId: USER,
      deviceId: device.id,
      clientRecordingId: `bench:${i}`,
      deviceSeq: i,
      startedAt,
      endedAt,
      capturedOffsetMin: 540,
      durationMs: 300_000,
      codec: "wav_pcm_s16le",
      codecParams: null,
      sampleRateHz: 16_000,
      channels: 1,
      byteSize: 1000,
      sha256: "a".repeat(64),
      storageKey: null,
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
    });

    const conversation = await store.createConversation({
      userId: USER,
      title: `벤치 대화 ${i}`,
      summary: `bench 성능 측정용 대화입니다. code-${i} 검색과 목록 지연을 확인합니다.`,
      language: "ko",
      startedAt,
      endedAt,
      status: "ready",
      analysisVersion: 1,
      pipeline: { provider: "bench" },
      speakers: [
        { label: "S1", personId: persons[i % persons.length].id, identificationStatus: "confirmed", confidence: 0.9 },
        { label: "S2", personId: null, identificationStatus: "unknown", confidence: 0.3 },
      ],
      segments: [
        { seq: 0, startMs: 0, endMs: 1000, text: "bench 첫 문장", speakerLabel: "S1", confidence: 0.9 },
        { seq: 1, startMs: 1000, endMs: 2000, text: "bench 두 번째 문장", speakerLabel: "S2", confidence: 0.8 },
      ],
      entities: [{ kind: "place", value: "bench", normalizedValue: null, confidence: 0.7, segmentSeq: 0 }],
      actionItems: [],
      embedding: {
        provider: "bench",
        model: "bench",
        dim: 768,
        vector: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
      },
      recordingLinks: [{ recordingId: recording.id, startOffsetMs: 0, endOffsetMs: 300_000 }],
    });
    if (i === 0) conversationId = conversation.id;
  }
  return { count: CONVERSATIONS, conversationId };
}

async function measure(url, headers) {
  // 워밍업
  for (let i = 0; i < 10; i += 1) await fetch(url, { headers });

  const latencies = [];
  let errors = 0;
  let requests = 0;
  const end = Date.now() + DURATION_MS;

  async function worker() {
    while (Date.now() < end) {
      const started = performance.now();
      try {
        const response = await fetch(url, { headers });
        await response.arrayBuffer();
        if (!response.ok) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - started);
      requests += 1;
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  latencies.sort((a, b) => a - b);
  const elapsed = DURATION_MS / 1000;
  return {
    requests,
    errors,
    rps: requests / elapsed,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

function fmt(ms) {
  return `${ms.toFixed(1)}ms`;
}
