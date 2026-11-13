/**
 * E2E 전용 API 서버를 띄우고 고정 데이터를 넣는다.
 *
 * 메모리 저장소를 쓰므로 테스트마다 같은 데이터가 재현된다.
 * Vite 개발 서버는 5173 에서 /api 를 8080 으로 프록시한다.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../apps/api/src/http/server.ts";
import { MemoryStore } from "../../apps/api/src/adapters/memory/store.ts";
import { LocalDiskStorage } from "../../apps/api/src/adapters/storage/local-disk.ts";
import { FakeAiPipeline } from "../../apps/api/src/adapters/ai/fake-pipeline.ts";
import { defaultDeps } from "../../apps/api/src/usecases/deps.ts";
import { uuidv7 } from "../../apps/api/src/domain/ids.ts";

export const E2E_USER = "0199aaaa-0000-7000-8000-000000000001";
const PORT = 8080;

export default async function globalSetup() {
  const store = new MemoryStore();
  await store.ensureUser(E2E_USER);

  const device = await store.createDevice({
    id: uuidv7(),
    userId: E2E_USER,
    serialNo: `GYL-E2E-${Date.now()}`,
    model: "xiao-nrf52840-sense",
    hardwareRevision: null,
    firmwareVersion: "0.1.0",
    lifecycleStatus: "active",
    lastSeenAt: new Date(),
    batteryPct: 80,
    storageFreeBytes: 5_000_000_000,
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const people = {};
  for (const name of ["김민수", "이영희", "박철수"]) {
    people[name] = await store.createPerson({
      id: uuidv7(),
      userId: E2E_USER,
      displayName: name,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const daysAgo = (days, hour) => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    date.setHours(hour, 0, 0, 0);
    return date;
  };

  const seeds = [
    {
      title: "북한산 등산 계획",
      summary: "주말에 북한산에 오르기로 했다. 토요일 여덟 시에 출발하고 준비물은 민수가 챙긴다.",
      person: "김민수",
      startedAt: daysAgo(0, 9),
      minutes: 34,
      segments: [
        "이번 주말에 북한산 갈래?",
        "토요일 아침 여덟 시에 출발하자.",
        "준비물은 내가 챙길게.",
      ],
      action: "토요일 8시 출발 준비",
    },
    {
      title: "병원 예약과 저녁 약속",
      summary: "영희가 다음 주 화요일 병원 예약을 잡았다. 끝나고 국수집에서 만나기로 했다.",
      person: "이영희",
      startedAt: daysAgo(2, 18),
      minutes: 21,
      segments: [
        "화요일 오후 두 시로 예약했어.",
        "끝나면 국수집에서 보자.",
        "그날 이야기 천천히 하자.",
      ],
      action: "화요일 병원 결과 함께 보기",
    },
    {
      title: "오래된 사진 이야기",
      summary: "철수가 보낸 1998년 여름 사진을 함께 봤다. 원본을 스캔해 보내기로 했다.",
      person: "박철수",
      startedAt: daysAgo(5, 14),
      minutes: 47,
      segments: [
        "이 사진 구십팔 년 같지?",
        "할머니 댁 마당이었어.",
        "원본을 스캔해서 보내 줄게.",
      ],
      action: "사진 원본 스캔해 보내기",
    },
  ];

  for (const seed of seeds) {
    const endedAt = new Date(seed.startedAt.getTime() + seed.minutes * 60_000);
    await store.createConversation({
      userId: E2E_USER,
      title: seed.title,
      summary: seed.summary,
      language: "ko",
      startedAt: seed.startedAt,
      endedAt,
      status: "ready",
      analysisVersion: 1,
      pipeline: { provider: "e2e", model: "e2e-v1" },
      speakers: [
        { label: "S1", personId: null, identificationStatus: "unknown", confidence: 0.4 },
        {
          label: "S2",
          personId: people[seed.person].id,
          identificationStatus: "confirmed",
          confidence: 0.95,
        },
      ],
      segments: seed.segments.map((text, index) => ({
        seq: index,
        startMs: index * 15_000,
        endMs: (index + 1) * 15_000,
        text,
        speakerLabel: index % 2 === 0 ? "S2" : "S1",
        confidence: 0.9,
      })),
      entities: [
        {
          kind: "place",
          value: seed.title.includes("북한산") ? "북한산" : "서울",
          normalizedValue: null,
          confidence: 0.8,
          segmentSeq: 0,
        },
      ],
      actionItems: [
        {
          title: seed.action,
          dueAt: new Date(seed.startedAt.getTime() + 7 * 86_400_000),
          confidence: 0.7,
          entityIndex: null,
        },
      ],
      embedding: {
        provider: "e2e",
        model: "e2e-embed",
        dim: 768,
        vector: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
      },
      recordingLinks: [],
    });
  }

  const storageDir = await mkdtemp(path.join(tmpdir(), "gyeol-e2e-"));
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

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
  server.unref();
}
