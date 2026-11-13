import type {
  ActionItem,
  AnalysisResult,
  Conversation,
  ConversationDetail,
  Device,
  Person,
  Recording,
  SpeakerCluster,
  TranscriptSegment,
  ExtractedEntity,
  UploadSession,
  User,
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
  ensureUser(id: string): Promise<User>;

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

  createUploadSession(session: UploadSession): Promise<UploadSession>;
  findUploadSession(id: string): Promise<UploadSession | null>;
  findOpenUploadSession(recordingId: string): Promise<UploadSession | null>;
  updateUploadSession(session: UploadSession): Promise<UploadSession>;
  expireUploadSessions(now: Date): Promise<number>;

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
}

/** AI 파이프라인 포트. Provider Adapter 로 교체한다. */
export interface AiPipeline {
  analyze(input: { recording: Recording; audio: Buffer }): Promise<AnalysisResult>;
  embedQuery(text: string): Promise<number[]>;
}

/** 오브젝트 스토리지 포트. */
export interface ObjectStorage {
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
