import type { Recording, RecordingStatus } from "./types.ts";

/** 상태 전이표 (docs/10-domain-model.md §6.2). */
const TRANSITIONS: Record<RecordingStatus, RecordingStatus[]> = {
  initiated: ["uploading", "integrity_failed"],
  uploading: ["uploading", "stored", "integrity_failed"],
  stored: ["analyzing", "purged"],
  analyzing: ["analyzed", "analysis_failed"],
  analyzed: ["analyzing", "purged"],
  analysis_failed: ["analyzing", "purged"],
  integrity_failed: ["initiated"],
  purged: [],
};

export function canTransition(from: RecordingStatus, to: RecordingStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** M-04 삭제 5조건. 하나라도 미충족이면 사유를 돌려준다. */
export function deletionBlockers(r: Recording): string[] {
  const blockers: string[] = [];
  if (r.deletedAt) blockers.push("이미 삭제 표시됨");
  if (r.status === "purged") blockers.push("이미 원본이 삭제됨");
  if (r.status !== "stored" && r.status !== "analyzed" && r.status !== "analysis_failed") {
    blockers.push(`검증 완료 상태가 아님(status=${r.status})`);
  }
  if (!r.integrityVerifiedAt) blockers.push("무결성(크기·SHA-256) 검증 미완료");
  if (!r.storageKey) blockers.push("저장 위치 미기록");
  if (!r.storageVerifiedAt) blockers.push("Object Storage 저장 미확인");
  if (!r.clientAckAt) blockers.push("클라이언트 최종 ACK 미수신");
  return blockers;
}

export function isDeletable(r: Recording): boolean {
  return deletionBlockers(r).length === 0;
}

export function canAnalyze(r: Recording): boolean {
  return r.status === "stored" || r.status === "analyzed" || r.status === "analysis_failed";
}

/** 업로드 완료 판정: 바이트 수와 해시가 모두 일치해야 한다. */
export function verifyIntegrity(expectedBytes: number, expectedSha256: string, actualBytes: number, actualSha256: string): boolean {
  return expectedBytes === actualBytes && expectedSha256.toLowerCase() === actualSha256.toLowerCase();
}
