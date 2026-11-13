/** 도메인 공용 타입. 외부(프레임워크/DB) 의존이 없어야 한다. */

export type DeviceLifecycleStatus = "provisioned" | "active" | "retired";

export type RecordingStatus =
  | "initiated"
  | "uploading"
  | "stored"
  | "analyzing"
  | "analyzed"
  | "analysis_failed"
  | "integrity_failed"
  | "purged";

export type UploadSessionStatus = "open" | "completed" | "aborted" | "expired";

export type ConversationStatus = "ready" | "partial";

export type IdentificationStatus = "unknown" | "suggested" | "confirmed";

export type ActionItemStatus = "open" | "done" | "dismissed";

export type EntityKind = "person" | "place" | "event" | "appointment" | "task" | "other";

export interface User {
  id: string;
  displayName: string;
  createdAt: Date;
}

export interface Device {
  id: string;
  userId: string | null;
  serialNo: string;
  model: string;
  hardwareRevision: string | null;
  firmwareVersion: string | null;
  lifecycleStatus: DeviceLifecycleStatus;
  lastSeenAt: Date | null;
  batteryPct: number | null;
  storageFreeBytes: number | null;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Recording {
  id: string;
  userId: string;
  deviceId: string;
  clientRecordingId: string;
  deviceSeq: number | null;
  startedAt: Date;
  endedAt: Date;
  capturedOffsetMin: number | null;
  durationMs: number;
  codec: string;
  codecParams: Record<string, unknown> | null;
  sampleRateHz: number;
  channels: number;
  byteSize: number;
  sha256: string;
  storageKey: string | null;
  status: RecordingStatus;
  vad: Record<string, unknown> | null;
  uploadedAt: Date | null;
  integrityVerifiedAt: Date | null;
  storageVerifiedAt: Date | null;
  clientAckAt: Date | null;
  analyzedAt: Date | null;
  purgedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface UploadSession {
  id: string;
  recordingId: string;
  status: UploadSessionStatus;
  expectedBytes: number;
  receivedBytes: number;
  expectedSha256: string;
  chunkSizeBytes: number;
  expiresAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Conversation {
  id: string;
  userId: string;
  title: string | null;
  summary: string | null;
  language: string;
  startedAt: Date;
  endedAt: Date;
  analysisVersion: number;
  status: ConversationStatus;
  pipeline: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface Person {
  id: string;
  userId: string;
  displayName: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SpeakerCluster {
  id: string;
  conversationId: string;
  label: string;
  personId: string | null;
  identificationStatus: IdentificationStatus;
  confidence: number | null;
}

export interface TranscriptSegment {
  id: string;
  conversationId: string;
  seq: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerClusterId: string | null;
  confidence: number | null;
}

export interface ExtractedEntity {
  id: string;
  conversationId: string;
  segmentId: string | null;
  kind: EntityKind;
  value: string;
  normalizedValue: string | null;
  confidence: number | null;
}

export interface ActionItem {
  id: string;
  conversationId: string;
  entityId: string | null;
  title: string;
  dueAt: Date | null;
  status: ActionItemStatus;
  confidence: number | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface ConversationEmbedding {
  conversationId: string;
  provider: string;
  model: string;
  dim: number;
  vector: number[];
}

export interface ConversationDetail {
  conversation: Conversation;
  speakers: SpeakerCluster[];
  segments: TranscriptSegment[];
  entities: ExtractedEntity[];
  actionItems: ActionItem[];
  people: Person[];
  recordingIds: string[];
}

/** AI 파이프라인 산출물. Provider Adapter 가 이 형태로 돌려준다. */
export interface SpeakerIdThreshold {
  provider: string;
  model: string;
  threshold: number;
  margin: number;
}

export interface AnalysisResult {
  title: string;
  summary: string;
  language: string;
  status: ConversationStatus;
  speakers: Array<{
    label: string;
    personName: string | null;
    confidence: number | null;
  }>;
  segments: Array<{
    seq: number;
    startMs: number;
    endMs: number;
    text: string;
    speakerLabel: string | null;
    confidence: number | null;
  }>;
  entities: Array<{
    kind: EntityKind;
    value: string;
    normalizedValue: string | null;
    confidence: number | null;
    segmentSeq: number | null;
  }>;
  actionItems: Array<{
    title: string;
    dueAt: Date | null;
    confidence: number | null;
    entityIndex: number | null;
  }>;
  embedding: { provider: string; model: string; dim: number; vector: number[] };
  pipeline: Record<string, unknown>;
}
