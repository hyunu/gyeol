import test from "node:test";
import assert from "node:assert/strict";
import { canTransition, deletionBlockers, verifyIntegrity } from "../../apps/api/src/domain/recording.ts";
import { decideIdentification } from "../../apps/api/src/domain/speaker.ts";
import { canTransitionActionItem, isDeviceOnline } from "../../apps/api/src/domain/device.ts";
import type { Recording } from "../../apps/api/src/domain/types.ts";

const base: Recording = {
  id: "0199aaaa-0000-7000-8000-000000000201",
  userId: "0199aaaa-0000-7000-8000-000000000001",
  deviceId: "0199aaaa-0000-7000-8000-000000000101",
  clientRecordingId: "dev:1",
  deviceSeq: null,
  startedAt: new Date("2026-11-13T06:00:00Z"),
  endedAt: new Date("2026-11-13T06:00:10Z"),
  capturedOffsetMin: null,
  durationMs: 10000,
  codec: "wav_pcm_s16le",
  codecParams: null,
  sampleRateHz: 16000,
  channels: 1,
  byteSize: 320000,
  sha256: "a".repeat(64),
  storageKey: null,
  status: "initiated",
  vad: null,
  uploadedAt: null,
  integrityVerifiedAt: null,
  storageVerifiedAt: null,
  clientAckAt: null,
  analyzedAt: null,
  purgedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

test("Recording 상태 전이표: 허용되지 않은 전이는 거부한다", () => {
  assert.equal(canTransition("initiated", "uploading"), true);
  assert.equal(canTransition("uploading", "stored"), true);
  assert.equal(canTransition("stored", "purged"), true);
  assert.equal(canTransition("initiated", "stored"), false, "검증 없이 stored 로 갈 수 없다");
  assert.equal(canTransition("analyzing", "stored"), false);
  assert.equal(canTransition("purged", "stored"), false);
});

test("M-04: 원본 삭제는 5개 조건이 모두 충족되어야 한다", () => {
  const partial: Recording = { ...base, status: "stored", storageKey: "recordings/x", integrityVerifiedAt: new Date(), storageVerifiedAt: new Date() };
  assert.deepEqual(deletionBlockers(partial), ["클라이언트 최종 ACK 미수신"]);

  const complete: Recording = { ...partial, clientAckAt: new Date() };
  assert.deepEqual(deletionBlockers(complete), []);

  const noStorage: Recording = { ...complete, storageKey: null };
  assert.ok(deletionBlockers(noStorage).includes("저장 위치 미기록"));

  const notVerified: Recording = { ...complete, integrityVerifiedAt: null };
  assert.ok(deletionBlockers(notVerified).includes("무결성(크기·SHA-256) 검증 미완료"));
});

test("무결성 비교는 크기와 해시를 모두 요구한다", () => {
  assert.equal(verifyIntegrity(10, "ab", 10, "ab"), true);
  assert.equal(verifyIntegrity(10, "ab", 11, "ab"), false);
  assert.equal(verifyIntegrity(10, "ab", 10, "cd"), false);
});

test("M-03: 임계값 미달 또는 1·2위 격차 부족이면 Unknown", () => {
  const threshold = 0.8;
  const margin = 0.05;

  const strong = decideIdentification([{ personId: "p1", score: 0.93 }], threshold, margin);
  assert.equal(strong.status, "suggested");
  assert.equal(strong.personId, "p1");
  assert.notEqual(strong.status, "confirmed", "자동 확정 금지");

  const weak = decideIdentification([{ personId: "p1", score: 0.62 }], threshold, margin);
  assert.equal(weak.status, "unknown");
  assert.equal(weak.personId, null);

  const ambiguous = decideIdentification(
    [{ personId: "p1", score: 0.9 }, { personId: "p2", score: 0.88 }],
    threshold,
    margin,
  );
  assert.equal(ambiguous.status, "unknown", "1·2위 격차가 작으면 미식별");

  const empty = decideIdentification([], threshold, margin);
  assert.equal(empty.status, "unknown");
});

test("기기 online 은 last_seen_at + TTL 로 파생된다", () => {
  const now = new Date("2026-11-13T07:00:00Z");
  assert.equal(isDeviceOnline(new Date("2026-11-13T06:59:00Z"), now, 120000), true);
  assert.equal(isDeviceOnline(new Date("2026-11-13T06:50:00Z"), now, 120000), false);
  assert.equal(isDeviceOnline(null, now, 120000), false);
});

test("ActionItem 상태 전이", () => {
  assert.equal(canTransitionActionItem("open", "done"), true);
  assert.equal(canTransitionActionItem("done", "open"), true);
  assert.equal(canTransitionActionItem("dismissed", "done"), false);
});
