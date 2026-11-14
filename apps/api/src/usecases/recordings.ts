import {
  conflict,
  notFound,
  notStored,
  offsetMismatch,
  recordingNotDeletable,
  sessionNotOpen,
  validationFailed,
} from "../domain/errors.ts";
import { uuidv7 } from "../domain/ids.ts";
import {
  deletionBlockers,
  isDeletable,
  verifyIntegrity,
} from "../domain/recording.ts";
import type { Recording, UploadSession } from "../domain/types.ts";
import type { Deps } from "./deps.ts";
import { recordRecordingPurge } from "./privacy.ts";

export interface CreateRecordingInput {
  deviceId: string;
  clientRecordingId: string;
  deviceSeq?: number;
  startedAt: string;
  endedAt: string;
  capturedOffsetMin?: number;
  durationMs: number;
  codec: string;
  codecParams?: Record<string, unknown>;
  sampleRateHz: number;
  channels: number;
  byteSize: number;
  sha256: string;
  vad?: Record<string, unknown>;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw validationFailed(`${field} 가 올바른 시각이 아닙니다.`);
  return date;
}

export async function createRecording(
  deps: Deps,
  userId: string,
  input: CreateRecordingInput,
): Promise<{ recording: Recording; uploadSession: UploadSession; created: boolean }> {
  if (!input.clientRecordingId?.trim()) throw validationFailed("clientRecordingId 는 필수입니다.");
  if (!input.codec?.trim()) throw validationFailed("codec 은 필수입니다.");
  if (!Number.isInteger(input.byteSize) || input.byteSize <= 0) {
    throw validationFailed("byteSize 는 1 이상의 정수여야 합니다.");
  }
  if (!SHA256_RE.test(input.sha256 ?? "")) throw validationFailed("sha256 은 64자리 소문자 hex 입니다.");

  const startedAt = parseDate(input.startedAt, "startedAt");
  const endedAt = parseDate(input.endedAt, "endedAt");
  if (endedAt.getTime() <= startedAt.getTime()) {
    throw validationFailed("endedAt 은 startedAt 보다 뒤여야 합니다.");
  }

  const device = await deps.store.findDevice(input.deviceId);
  if (!device || device.userId !== userId) throw notFound("기기");

  await deps.store.expireUploadSessions(deps.clock.now());

  const existing = await deps.store.findRecordingByClientKey(input.deviceId, input.clientRecordingId);
  if (existing) {
    if (existing.userId !== userId) throw notFound("녹음");
    if (existing.status === "purged") {
      throw conflict("RECORDING_PURGED", "원본이 삭제된 녹음입니다.");
    }
    const session =
      (await deps.store.findOpenUploadSession(existing.id)) ?? (await newUploadSession(deps, existing));
    return { recording: existing, uploadSession: session, created: false };
  }

  const now = deps.clock.now();
  const recording: Recording = {
    id: uuidv7(),
    userId,
    deviceId: input.deviceId,
    clientRecordingId: input.clientRecordingId,
    deviceSeq: input.deviceSeq ?? null,
    startedAt,
    endedAt,
    capturedOffsetMin: input.capturedOffsetMin ?? null,
    durationMs: input.durationMs,
    codec: input.codec,
    codecParams: input.codecParams ?? null,
    sampleRateHz: input.sampleRateHz,
    channels: input.channels,
    byteSize: input.byteSize,
    sha256: input.sha256,
    storageKey: null,
    status: "initiated",
    vad: input.vad ?? null,
    uploadedAt: null,
    integrityVerifiedAt: null,
    storageVerifiedAt: null,
    clientAckAt: null,
    analyzedAt: null,
    purgedAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const created = await deps.store.createRecording(recording);
  const uploadSession = await newUploadSession(deps, created);
  return { recording: created, uploadSession, created: true };
}

async function newUploadSession(deps: Deps, recording: Recording): Promise<UploadSession> {
  await deps.store.expireUploadSessions(deps.clock.now());
  const existing = await deps.store.findOpenUploadSession(recording.id);
  if (existing) return existing;

  const now = deps.clock.now();
  const session: UploadSession = {
    id: uuidv7(),
    recordingId: recording.id,
    status: "open",
    expectedBytes: recording.byteSize,
    receivedBytes: 0,
    expectedSha256: recording.sha256,
    chunkSizeBytes: deps.upload.chunkSizeBytes,
    expiresAt: new Date(now.getTime() + deps.upload.sessionTtlMs),
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await deps.storage.startSession(session.id, recording.byteSize);
  return deps.store.createUploadSession(session);
}

export async function createUploadSession(
  deps: Deps,
  userId: string,
  recordingId: string,
): Promise<{ recording: Recording; uploadSession: UploadSession }> {
  const recording = await ownedRecording(deps, userId, recordingId);
  if (recording.status === "purged") {
    throw conflict("RECORDING_PURGED", "원본이 삭제된 녹음에는 세션을 만들 수 없습니다.");
  }
  const session = await newUploadSession(deps, recording);
  return { recording, uploadSession: session };
}

export async function appendChunk(
  deps: Deps,
  userId: string,
  recordingId: string,
  sessionId: string,
  offset: number,
  chunk: Buffer,
): Promise<{ recording: Recording; uploadSession: UploadSession }> {
  const recording = await ownedRecording(deps, userId, recordingId);
  const session = await deps.store.findUploadSession(sessionId);
  if (!session || session.recordingId !== recording.id) throw notFound("업로드 세션");

  const now = deps.clock.now();
  if (session.status === "open" && session.expiresAt.getTime() <= now.getTime()) {
    const expired = await deps.store.updateUploadSession({ ...session, status: "expired", updatedAt: now });
    throw sessionNotOpen(expired.status);
  }
  if (session.status !== "open") throw sessionNotOpen(session.status);
  if (offset !== session.receivedBytes) throw offsetMismatch(session.receivedBytes, offset);
  if (chunk.length === 0) throw validationFailed("빈 청크는 허용되지 않습니다.");
  if (chunk.length > session.chunkSizeBytes) {
    throw validationFailed(`청크는 ${session.chunkSizeBytes} 바이트를 넘을 수 없습니다.`);
  }
  if (session.receivedBytes + chunk.length > session.expectedBytes) {
    throw validationFailed("예상 크기를 초과하는 청크입니다.");
  }

  await deps.storage.appendChunk(session.id, offset, chunk);
  let updatedSession: UploadSession = {
    ...session,
    receivedBytes: session.receivedBytes + chunk.length,
    updatedAt: now,
  };

  if (updatedSession.receivedBytes < updatedSession.expectedBytes) {
    const saved = await deps.store.updateUploadSession(updatedSession);
    const updatedRecording: Recording =
      recording.status === "initiated"
        ? await deps.store.updateRecording({ ...recording, status: "uploading", updatedAt: now })
        : recording;
    return { recording: updatedRecording, uploadSession: saved };
  }

  // 마지막 청크: Object Storage 커밋 + 무결성 검증 (M-04)
  const storageKey = `recordings/${recording.id}/original`;
  try {
    const committed = await deps.storage.commitSession(updatedSession.id, storageKey);
    if (!verifyIntegrity(recording.byteSize, recording.sha256, committed.size, committed.sha256)) {
      throw new Error("integrity mismatch");
    }
    const verifiedAt = deps.clock.now();
    const stored = await deps.store.updateRecording({
      ...recording,
      status: "stored",
      storageKey,
      uploadedAt: verifiedAt,
      integrityVerifiedAt: verifiedAt,
      storageVerifiedAt: verifiedAt,
      updatedAt: verifiedAt,
    });
    updatedSession = {
      ...updatedSession,
      status: "completed",
      completedAt: verifiedAt,
      updatedAt: verifiedAt,
    };
    const saved = await deps.store.updateUploadSession(updatedSession);
    return { recording: stored, uploadSession: saved };
  } catch {
    await deps.storage.abortSession(updatedSession.id).catch(() => undefined);
    // 무결성 불일치 바이트는 오브젝트 스토리지에 남기지 않는다.
    await deps.storage.delete(storageKey).catch(() => undefined);
    const aborted = await deps.store.updateUploadSession({
      ...updatedSession,
      status: "aborted",
      updatedAt: deps.clock.now(),
    });
    const failed = await deps.store.updateRecording({
      ...recording,
      status: "integrity_failed",
      storageKey: null,
      updatedAt: deps.clock.now(),
    });
    return { recording: failed, uploadSession: aborted };
  }
}

export async function acknowledgeRecording(deps: Deps, userId: string, recordingId: string): Promise<Recording> {
  const recording = await ownedRecording(deps, userId, recordingId);
  if (!recording.integrityVerifiedAt || !recording.storageVerifiedAt || !recording.storageKey) {
    throw notStored(recording.status);
  }
  if (recording.clientAckAt) return recording;
  const now = deps.clock.now();
  return deps.store.updateRecording({ ...recording, clientAckAt: now, updatedAt: now });
}

export async function deleteRecording(
  deps: Deps,
  userId: string,
  recordingId: string,
  traceId: string | null = null,
): Promise<void> {
  const recording = await ownedRecording(deps, userId, recordingId);
  const blockers = deletionBlockers(recording);
  if (blockers.length > 0) throw recordingNotDeletable(blockers);
  if (recording.storageKey) await deps.storage.delete(recording.storageKey);
  const now = deps.clock.now();
  await deps.store.updateRecording({
    ...recording,
    status: "purged",
    storageKey: null,
    purgedAt: now,
    updatedAt: now,
  });
  await recordRecordingPurge(deps, recording, traceId);
}

export async function getRecording(deps: Deps, userId: string, recordingId: string): Promise<Recording> {
  return ownedRecording(deps, userId, recordingId);
}

export async function listRecordings(
  deps: Deps,
  userId: string,
  filter: { deviceId?: string; status?: Recording["status"]; from?: Date; to?: Date; page: number; size: number },
) {
  return deps.store.listRecordings({ userId, ...filter });
}

export function recordingDeletable(recording: Recording): boolean {
  return isDeletable(recording);
}

async function ownedRecording(deps: Deps, userId: string, recordingId: string): Promise<Recording> {
  const recording = await deps.store.findRecording(recordingId);
  if (!recording || recording.userId !== userId || recording.deletedAt) throw notFound("녹음");
  return recording;
}
