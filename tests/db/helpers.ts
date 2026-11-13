import { uuidv7 } from "../../apps/api/src/domain/ids.ts";
import type { Device, Recording } from "../../apps/api/src/domain/types.ts";
import type { NewConversation } from "../../apps/api/src/ports/store.ts";

/** PostgreSQL Store 테스트용 고정 형상 팩토리. 값은 계약 제약을 만족해야 한다. */

export function makeDevice(userId: string, serialNo: string): Device {
  const now = new Date("2026-11-01T00:00:00Z");
  return {
    id: uuidv7(),
    userId,
    serialNo,
    model: "xiao-nrf52840-sense",
    hardwareRevision: null,
    firmwareVersion: "0.0.1",
    lifecycleStatus: "active",
    lastSeenAt: now,
    batteryPct: 80,
    storageFreeBytes: 8_000_000_000,
    config: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function makeRecording(
  userId: string,
  deviceId: string,
  overrides: Partial<Recording> = {},
): Recording {
  const startedAt = overrides.startedAt ?? new Date("2026-11-01T01:00:00Z");
  const endedAt = overrides.endedAt ?? new Date(startedAt.getTime() + 10_000);
  return {
    id: uuidv7(),
    userId,
    deviceId,
    clientRecordingId: "db:recording",
    deviceSeq: 1,
    startedAt,
    endedAt,
    capturedOffsetMin: 540,
    durationMs: endedAt.getTime() - startedAt.getTime(),
    codec: "wav_pcm_s16le",
    codecParams: { bitDepth: 16 },
    sampleRateHz: 16_000,
    channels: 1,
    byteSize: 1024,
    sha256: "a".repeat(64),
    storageKey: null,
    status: "initiated",
    vad: { segments: 1 },
    uploadedAt: null,
    integrityVerifiedAt: null,
    storageVerifiedAt: null,
    clientAckAt: null,
    analyzedAt: null,
    purgedAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    deletedAt: null,
    ...overrides,
  };
}

export function newConversation(
  userId: string,
  personId: string,
  recording: Recording,
  overrides: Partial<NewConversation> = {},
): NewConversation {
  return {
    userId,
    title: "북한산 등산",
    summary: "김민수와 북한산에 다녀온 대화",
    language: "ko",
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
    status: "ready",
    analysisVersion: 1,
    pipeline: { provider: "fake", model: "fake-v1" },
    speakers: [
      { label: "S1", personId, identificationStatus: "confirmed", confidence: 0.97 },
      { label: "S2", personId: null, identificationStatus: "unknown", confidence: 0.4 },
    ],
    segments: [
      {
        seq: 0,
        startMs: 0,
        endMs: 1000,
        text: "오늘 북한산 날씨가 좋네요.",
        speakerLabel: "S1",
        confidence: 0.9,
      },
      {
        seq: 1,
        startMs: 1000,
        endMs: 2000,
        text: "다음 주에 또 오죠.",
        speakerLabel: "S2",
        confidence: 0.8,
      },
      {
        seq: 2,
        startMs: 2000,
        endMs: 3000,
        text: "좋아요, 토요일로 합시다.",
        speakerLabel: "S1",
        confidence: 0.85,
      },
    ],
    entities: [
      {
        kind: "place",
        value: "북한산",
        normalizedValue: "북한산",
        confidence: 0.92,
        segmentSeq: 0,
      },
      {
        kind: "appointment",
        value: "다음 주 토요일",
        normalizedValue: "2026-11-21",
        confidence: 0.7,
        segmentSeq: 2,
      },
    ],
    actionItems: [
      {
        title: "토요일 등산 약속 잡기",
        dueAt: new Date("2026-11-21T00:00:00Z"),
        confidence: 0.8,
        entityIndex: 1,
      },
    ],
    embedding: {
      provider: "fake",
      model: "fake-embed-v1",
      dim: 768,
      vector: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)),
    },
    recordingLinks: [
      {
        recordingId: recording.id,
        startOffsetMs: 0,
        endOffsetMs: recording.durationMs,
      },
    ],
    ...overrides,
  };
}
