import type {
  ActionItem,
  AnalysisJob,
  AuditEvent,
  AnalysisResult,
  Conversation,
  ConversationDetail,
  Device,
  Person,
  Recording,
  Session,
  SpeakerCluster,
  TranscriptSegment,
  ExtractedEntity,
  UploadSession,
  User,
  UserAccount,
} from "../domain/types.ts";

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface NewConversation {
  userId: string;
  title: string;
  summary: string;
  language: string;
  startedAt: Date;
  endedAt: Date;
  status: Conversation["status"];
  analysisVersion: number;
  pipeline: Record<string, unknown>;
  speakers: Array<{
    label: string;
    personId: string | null;
    identificationStatus: SpeakerCluster["identificationStatus"];
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
    kind: ExtractedEntity["kind"];
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
  recordingLinks: Array<{ recordingId: string; startOffsetMs: number; endOffsetMs: number }>;
}

export interface ConversationListItem {
  conversation: Conversation;
  people: Person[];
  recordingIds: string[];
  score?: number;
}

export interface ConversationFilter {
  userId: string;
  personId?: string;
  from?: Date;
  to?: Date;
  q?: string;
  queryVector?: number[];
  page: number;
  size: number;
}

export interface RecordingFilter {
  userId: string;
  deviceId?: string;
  status?: Recording["status"];
  from?: Date;
  to?: Date;
  page: number;
  size: number;
}

export interface Store {
  /** health 응답과 로그에 쓰는 구현 식별자. */
  readonly kind: "memory" | "postgres";
  /** 선택: 저장소 연결 확인. 구현이 없으면 health 는 구성 정보만 보고한다. */
  ping?(): Promise<void>;
  /** 정리 스크립트가 커넥션을 닫을 때 쓴다. */
  close?(): Promise<void>;

  ensureUser(id: string): Promise<User>;
  findUserAccount(id: string): Promise<UserAccount | null>;
  markUserDeleted(id: string, at: Date): Promise<void>;
  listUsersPendingPurge(cutoff: Date, limit: number): Promise<UserAccount[]>;
  /** 사용자와 모든 소유 데이터를 하드 삭제한다. 오브젝트는 호출자가 먼저 지운다. */
  purgeUser(userId: string): Promise<void>;
  /** Apple sub 로 사용자를 찾거나 만든다(ADR-0010). */
  upsertUserByAuthSubject(input: {
    id: string;
    authSubject: string;
    displayName: string;
  }): Promise<User>;

  createDevice(device: Device): Promise<Device>;
  findDevice(id: string): Promise<Device | null>;
  findDeviceBySerial(serialNo: string): Promise<Device | null>;
  updateDevice(device: Device): Promise<Device>;
  listDevices(userId: string, page: number, size: number): Promise<Paged<Device>>;

  createRecording(recording: Recording): Promise<Recording>;
  findRecording(id: string): Promise<Recording | null>;
  findRecordingByClientKey(deviceId: string, clientRecordingId: string): Promise<Recording | null>;
  updateRecording(recording: Recording): Promise<Recording>;
  listRecordings(filter: RecordingFilter): Promise<Paged<Recording>>;
  /** 30일 경과 원본 purge 후보(ACK 완료, 아직 purged 아님). */
  findRecordingPurgeCandidates(cutoff: Date, limit: number): Promise<Recording[]>;

  createUploadSession(session: UploadSession): Promise<UploadSession>;
  findUploadSession(id: string): Promise<UploadSession | null>;
  findOpenUploadSession(recordingId: string): Promise<UploadSession | null>;
  updateUploadSession(session: UploadSession): Promise<UploadSession>;
  expireUploadSessions(now: Date): Promise<number>;

  createAnalysisJob(job: AnalysisJob): Promise<AnalysisJob>;
  findAnalysisJob(id: string): Promise<AnalysisJob | null>;
  /** 녹음당 활성(queued|running) 작업. 중복 enqueue 방지에 쓴다. */
  findActiveAnalysisJob(recordingId: string): Promise<AnalysisJob | null>;
  updateAnalysisJob(job: AnalysisJob): Promise<AnalysisJob>;
  /**
   * 실행 가능한 작업 하나를 원자적으로 선점한다(queued → running, attempt+1).
   * 만료된 임차(running, lease_expires_at <= now)는 회수한다. 없으면 null.
   */
  claimNextAnalysisJob(now: Date): Promise<AnalysisJob | null>;

  createConversation(input: NewConversation): Promise<Conversation>;
  replaceConversation(conversationId: string, input: NewConversation): Promise<Conversation>;
  findConversation(id: string): Promise<Conversation | null>;
  findConversationByRecordingId(recordingId: string): Promise<Conversation | null>;
  listRecordingLinks(
    conversationId: string,
  ): Promise<Array<{ recordingId: string; startOffsetMs: number; endOffsetMs: number }>>;
  getConversationDetail(id: string): Promise<ConversationDetail | null>;
  listConversations(filter: ConversationFilter): Promise<Paged<ConversationListItem>>;

  findPerson(userId: string, displayName: string): Promise<Person | null>;
  findPersonById(id: string): Promise<Person | null>;
  createPerson(person: Person): Promise<Person>;
  listPersons(userId: string, page: number, size: number): Promise<Paged<Person>>;

  findActionItem(id: string): Promise<ActionItem | null>;
  updateActionItem(item: ActionItem): Promise<ActionItem>;

  createSession(session: Session): Promise<Session>;
  findSessionByTokenHash(tokenHash: string): Promise<Session | null>;
  touchSession(id: string, at: Date): Promise<void>;
  revokeSession(id: string, at: Date): Promise<void>;
  revokeUserSessions(userId: string, at: Date): Promise<number>;

  createAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(userId: string, limit?: number): Promise<AuditEvent[]>;
}

/** AI 파이프라인 포트. Provider Adapter 로 교체한다. */
export interface AiPipeline {
  analyze(input: { recording: Recording; audio: Buffer }): Promise<AnalysisResult>;
  embedQuery(text: string): Promise<number[]>;
}

/** 오브젝트 스토리지 포트. */
export interface ObjectStorage {
  /** health·로그에 쓰는 구현 식별자. 구현이 없으면 unknown 으로 보고한다. */
  readonly kind?: "local" | "s3";
  /** 세션 임시 객체를 만든다(0바이트). */
  startSession(sessionId: string, expectedBytes: number): Promise<void>;
  appendChunk(sessionId: string, offset: number, chunk: Buffer): Promise<number>;
  /** 크기·해시를 계산하고 최종 키로 커밋한다. */
  commitSession(sessionId: string, destinationKey: string): Promise<{ size: number; sha256: string }>;
  abortSession(sessionId: string): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  read(key: string): Promise<Buffer>;
}
