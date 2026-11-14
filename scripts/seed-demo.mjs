#!/usr/bin/env node
/**
 * 데모 데이터 시드 (배포/개발).
 *
 * 고정 DEMO_USER_ID 로 대화 4건을 만든다. 이미 대화가 있으면 건너뛴다.
 * 실행: DATABASE_URL=... npm run seed:demo
 */
import { PostgresStore } from "../apps/api/src/adapters/postgres/store.ts";
import { uuidv7 } from "../apps/api/src/domain/ids.ts";

const DEMO_USER_ID = "0199aaaa-0000-7000-8000-000000000001";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL 이 필요합니다.");
  process.exit(1);
}

const store = new PostgresStore({ connectionString: url });
try {
  await store.ensureUser(DEMO_USER_ID);
  const existing = await store.listConversations({ userId: DEMO_USER_ID, page: 1, size: 1 });
  if (existing.total > 0) {
    console.log(`이미 데모 대화 ${existing.total}건이 있어 건너뜁니다.`);
    process.exit(0);
  }

  const device = await store.createDevice({
    id: uuidv7(),
    userId: DEMO_USER_ID,
    serialNo: `GYL-DEMO-${uuidv7()}`,
    model: "xiao-esp32s3-sense",
    hardwareRevision: null,
    firmwareVersion: "0.1.0",
    lifecycleStatus: "active",
    lastSeenAt: new Date(),
    batteryPct: 72,
    storageFreeBytes: 6_200_000_000,
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const people = {};
  for (const name of ["김민수", "이영희", "박철수"]) {
    people[name] = await store.createPerson({
      id: uuidv7(),
      userId: DEMO_USER_ID,
      displayName: name,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const seeds = [
    {
      daysAgo: 0,
      hour: 9,
      minutes: 34,
      title: "북한산 등산 계획",
      summary:
        "주말에 북한산에 오르기로 했다. 토요일 여덟 시에 출발하고, 준비물은 민수가 챙기기로 했다. 날씨가 흐리면 일요일로 미룬다.",
      person: "김민수",
      segments: [
        ["이번 주말 날씨 괜찮대?", "김민수"],
        ["토요일은 맑고 일요일은 흐린대. 토요일 아침 여덟 시에 출발하자.", "나"],
        ["그럼 준비물은 내가 챙길게. 물이랑 김밥 정도면 되겠다.", "김민수"],
        ["좋아. 비 오면 일요일로 미루고 토요일 아침에 다시 연락하자.", "나"],
      ],
      entities: [["place", "북한산"], ["appointment", "토요일 여덟 시"]],
      actions: [{ title: "토요일 8시 출발 준비", dueDays: 7, done: false }],
    },
    {
      daysAgo: 2,
      hour: 18,
      minutes: 21,
      title: "병원 예약과 저녁 약속",
      summary:
        "영희가 다음 주 화요일 병원 예약을 잡았다. 끝나고 국수집에서 만나기로 했다.",
      person: "이영희",
      segments: [
        ["화요일 오후 두 시로 예약했어.", "이영희"],
        ["검사는 오래 걸려? 끝나면 연락해.", "나"],
        ["한 시간쯤 걸린대. 끝나고 국수집에서 보자.", "이영희"],
      ],
      entities: [["appointment", "화요일 두 시"], ["place", "국수집"]],
      actions: [{ title: "화요일 병원 결과 함께 보기", dueDays: 3, done: false }],
    },
    {
      daysAgo: 5,
      hour: 14,
      minutes: 47,
      title: "오래된 사진 이야기",
      summary:
        "철수가 보낸 1998년 여름 사진을 함께 봤다. 할머니 댁 마당과 그때의 이름들을 떠올렸다.",
      person: "박철수",
      segments: [
        ["이 사진 언제 찍은 거지? 구십팔 년 같은데.", "박철수"],
        ["할머니 댁 마당이었지. 뒤에 있는 사람이 외삼촌이고.", "나"],
        ["원본 있으면 스캔해서 보내 줄래?", "박철수"],
      ],
      entities: [["event", "1998년 여름"], ["place", "할머니 댁"]],
      actions: [{ title: "사진 원본 스캔해 보내기", dueDays: 2, done: false }],
    },
  ];

  for (const seed of seeds) {
    const startedAt = new Date();
    startedAt.setDate(startedAt.getDate() - seed.daysAgo);
    startedAt.setHours(seed.hour, 0, 0, 0);
    const endedAt = new Date(startedAt.getTime() + seed.minutes * 60_000);
    const recording = await store.createRecording({
      id: uuidv7(),
      userId: DEMO_USER_ID,
      deviceId: device.id,
      clientRecordingId: `demo:${seed.title}`,
      deviceSeq: null,
      startedAt,
      endedAt,
      capturedOffsetMin: 540,
      durationMs: seed.minutes * 60_000,
      codec: "wav_pcm_s16le",
      codecParams: null,
      sampleRateHz: 16_000,
      channels: 1,
      byteSize: seed.minutes * 32_000,
      sha256: "a".repeat(64),
      storageKey: `demo/${uuidv7()}/original`,
      status: "analyzed",
      vad: null,
      uploadedAt: startedAt,
      integrityVerifiedAt: startedAt,
      storageVerifiedAt: startedAt,
      clientAckAt: startedAt,
      analyzedAt: endedAt,
      purgedAt: null,
      createdAt: startedAt,
      updatedAt: endedAt,
      deletedAt: null,
    });

    const segments = seed.segments.map(([text, speaker], index) => ({
      seq: index,
      startMs: index * 45_000,
      endMs: (index + 1) * 45_000,
      text,
      speakerLabel: speaker === "나" ? "S1" : "S2",
      confidence: 0.9,
    }));

    const conversation = await store.createConversation({
      userId: DEMO_USER_ID,
      title: seed.title,
      summary: seed.summary,
      language: "ko",
      startedAt,
      endedAt,
      status: "ready",
      analysisVersion: 1,
      pipeline: { provider: "seed", model: "demo" },
      speakers: [
        { label: "S1", personId: null, identificationStatus: "unknown", confidence: 0.4 },
        {
          label: "S2",
          personId: people[seed.person].id,
          identificationStatus: "confirmed",
          confidence: 0.95,
        },
      ],
      segments,
      entities: seed.entities.map(([kind, value], index) => ({
        kind,
        value,
        normalizedValue: value,
        confidence: 0.8,
        segmentSeq: Math.min(index, segments.length - 1),
      })),
      actionItems: seed.actions.map((action) => ({
        title: action.title,
        dueAt: new Date(Date.now() + action.dueDays * 86_400_000),
        confidence: 0.75,
        entityIndex: null,
      })),
      embedding: {
        provider: "seed",
        model: "demo",
        dim: 768,
        vector: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
      },
      recordingLinks: [
        { recordingId: recording.id, startOffsetMs: 0, endOffsetMs: recording.durationMs },
      ],
    });

    for (const [index, action] of seed.actions.entries()) {
      if (!action.done) continue;
      const detail = await store.getConversationDetail(conversation.id);
      const item = detail.actionItems[index];
      if (item) {
        await store.updateActionItem({ ...item, status: "done", completedAt: new Date() });
      }
    }
  }

  console.log(`데모 대화 ${seeds.length}건 생성 완료`);
} finally {
  await store.close();
}
