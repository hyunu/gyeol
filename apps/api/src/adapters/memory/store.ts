import { conflict } from "../../domain/errors.ts";
import { uuidv7 } from "../../domain/ids.ts";
import type {
  ActionItem,
  AnalysisJob,
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
} from "../../domain/types.ts";
import type {
  ConversationFilter,
  ConversationListItem,
  NewConversation,
  Paged,
  RecordingFilter,
  Store,
} from "../../ports/store.ts";

const clone = <T>(v: T): T => structuredClone(v);

interface Link {
  recordingId: string;
  conversationId: string;
  startOffsetMs: number;
  endOffsetMs: number;
}

/**
 * 메모리 저장소.
 * 프로덕션용이 아니라 "DB 없이 전체 흐름을 검증"하기 위한 어댑터다.
 * 의미(유니크 제약, 페이지 정렬, 검색 점수)는 PostgreSQL 구현과 맞춘다.
 */
export class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private users = new Map<string, User>();
  private devices = new Map<string, Device>();
  private serialIndex = new Map<string, string>();
  private recordings = new Map<string, Recording>();
  private clientKey = new Map<string, string>();
  private sessions = new Map<string, UploadSession>();
  private conversations = new Map<string, Conversation>();
  private people = new Map<string, Person>();
  private speakers = new Map<string, SpeakerCluster[]>();
  private segments = new Map<string, TranscriptSegment[]>();
  private entities = new Map<string, ExtractedEntity[]>();
  private actions = new Map<string, ActionItem[]>();
  private embeddings = new Map<string, { provider: string; model: string; dim: number; vector: number[] }>();
  private links: Link[] = [];
  private analysisJobs = new Map<string, AnalysisJob>();
  private authSessions = new Map<string, Session>();
  private authSubjects = new Map<string, string>();

  ensureUser(id: string): Promise<User> {
    const existing = this.users.get(id);
    if (existing) return Promise.resolve(clone(existing));
    const user: User = { id, displayName: `로컬 사용자 ${id.slice(0, 8)}`, createdAt: new Date() };
    this.users.set(id, user);
    return Promise.resolve(clone(user));
  }

  upsertUserByAuthSubject(input: {
    id: string;
    authSubject: string;
    displayName: string;
  }): Promise<User> {
    const existingId = this.authSubjects.get(input.authSubject);
    if (existingId) {
      const existing = this.users.get(existingId);
      if (existing) return Promise.resolve(clone(existing));
    }
    const user: User = {
      id: input.id,
      displayName: input.displayName,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    this.authSubjects.set(input.authSubject, user.id);
    return Promise.resolve(clone(user));
  }

  createDevice(device: Device): Promise<Device> {
    if (this.serialIndex.has(device.serialNo)) {
      throw conflict("DEVICE_ALREADY_REGISTERED", "이미 등록된 기기입니다.", device.serialNo);
    }
    this.devices.set(device.id, clone(device));
    this.serialIndex.set(device.serialNo, device.id);
    return Promise.resolve(clone(device));
  }

  findDevice(id: string): Promise<Device | null> {
    return Promise.resolve(this.devices.get(id) ? clone(this.devices.get(id)!) : null);
  }

  findDeviceBySerial(serialNo: string): Promise<Device | null> {
    const id = this.serialIndex.get(serialNo);
    return Promise.resolve(id ? clone(this.devices.get(id)!) : null);
  }

  updateDevice(device: Device): Promise<Device> {
    this.devices.set(device.id, clone(device));
    return Promise.resolve(clone(device));
  }

  listDevices(userId: string, page: number, size: number): Promise<Paged<Device>> {
    const all = [...this.devices.values()]
      .filter((d) => d.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve({ items: all.slice((page - 1) * size, page * size).map(clone), total: all.length });
  }

  createRecording(recording: Recording): Promise<Recording> {
    const key = `${recording.deviceId}:${recording.clientRecordingId}`;
    if (this.clientKey.has(key)) {
      throw conflict("RECORDING_ALREADY_EXISTS", "이미 등록된 녹음입니다.", recording.clientRecordingId);
    }
    this.recordings.set(recording.id, clone(recording));
    this.clientKey.set(key, recording.id);
    return Promise.resolve(clone(recording));
  }

  findRecording(id: string): Promise<Recording | null> {
    const r = this.recordings.get(id);
    return Promise.resolve(r ? clone(r) : null);
  }

  findRecordingByClientKey(deviceId: string, clientRecordingId: string): Promise<Recording | null> {
    const id = this.clientKey.get(`${deviceId}:${clientRecordingId}`);
    return Promise.resolve(id ? clone(this.recordings.get(id)!) : null);
  }

  updateRecording(recording: Recording): Promise<Recording> {
    this.recordings.set(recording.id, clone(recording));
    return Promise.resolve(clone(recording));
  }

  listRecordings(filter: RecordingFilter): Promise<Paged<Recording>> {
    const all = [...this.recordings.values()]
      .filter((r) => r.userId === filter.userId && !r.deletedAt)
      .filter((r) => !filter.deviceId || r.deviceId === filter.deviceId)
      .filter((r) => !filter.status || r.status === filter.status)
      .filter((r) => !filter.from || r.startedAt.getTime() >= filter.from.getTime())
      .filter((r) => !filter.to || r.startedAt.getTime() < filter.to.getTime())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return Promise.resolve({
      items: all.slice((filter.page - 1) * filter.size, filter.page * filter.size).map(clone),
      total: all.length,
    });
  }

  createUploadSession(session: UploadSession): Promise<UploadSession> {
    const existing = [...this.sessions.values()].find(
      (s) => s.recordingId === session.recordingId && s.status === "open",
    );
    if (existing) {
      throw conflict("UPLOAD_SESSION_OPEN", "열린 업로드 세션이 이미 있습니다.", existing.id);
    }
    this.sessions.set(session.id, clone(session));
    return Promise.resolve(clone(session));
  }

  findUploadSession(id: string): Promise<UploadSession | null> {
    const s = this.sessions.get(id);
    return Promise.resolve(s ? clone(s) : null);
  }

  findOpenUploadSession(recordingId: string): Promise<UploadSession | null> {
    const s = [...this.sessions.values()].find((x) => x.recordingId === recordingId && x.status === "open");
    return Promise.resolve(s ? clone(s) : null);
  }

  updateUploadSession(session: UploadSession): Promise<UploadSession> {
    this.sessions.set(session.id, clone(session));
    return Promise.resolve(clone(session));
  }

  expireUploadSessions(now: Date): Promise<number> {
    let count = 0;
    for (const [id, s] of this.sessions) {
      if (s.status === "open" && s.expiresAt.getTime() <= now.getTime()) {
        this.sessions.set(id, { ...s, status: "expired", updatedAt: new Date(now) });
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  createConversation(input: NewConversation): Promise<Conversation> {
    const conversation: Conversation = {
      id: uuidv7(),
      userId: input.userId,
      title: input.title,
      summary: input.summary,
      language: input.language,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      analysisVersion: input.analysisVersion,
      status: input.status,
      pipeline: input.pipeline,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    this.conversations.set(conversation.id, conversation);
    this.writeDerived(conversation.id, input);
    return Promise.resolve(clone(conversation));
  }

  replaceConversation(conversationId: string, input: NewConversation): Promise<Conversation> {
    const existing = this.conversations.get(conversationId);
    if (!existing) throw conflict("CONVERSATION_MISSING", "대화를 찾을 수 없습니다.", conversationId);
    const updated: Conversation = {
      ...existing,
      title: input.title,
      summary: input.summary,
      language: input.language,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      analysisVersion: input.analysisVersion,
      status: input.status,
      pipeline: input.pipeline,
      updatedAt: new Date(),
    };
    this.conversations.set(conversationId, updated);
    this.writeDerived(conversationId, input);
    return Promise.resolve(clone(updated));
  }

  private writeDerived(conversationId: string, input: NewConversation): void {
    const speakerByLabel = new Map<string, string>();
    const speakers: SpeakerCluster[] = input.speakers.map((s) => {
      const id = uuidv7();
      speakerByLabel.set(s.label, id);
      return {
        id,
        conversationId,
        label: s.label,
        personId: s.personId,
        identificationStatus: s.identificationStatus,
        confidence: s.confidence,
      };
    });
    this.speakers.set(conversationId, speakers);

    const segmentIdBySeq = new Map<number, string>();
    const segments: TranscriptSegment[] = input.segments.map((s) => {
      const id = uuidv7();
      segmentIdBySeq.set(s.seq, id);
      return {
        id,
        conversationId,
        seq: s.seq,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        speakerClusterId: s.speakerLabel ? (speakerByLabel.get(s.speakerLabel) ?? null) : null,
        confidence: s.confidence,
      };
    });
    this.segments.set(conversationId, segments);

    const entities: ExtractedEntity[] = input.entities.map((e) => ({
      id: uuidv7(),
      conversationId,
      segmentId: e.segmentSeq === null ? null : (segmentIdBySeq.get(e.segmentSeq) ?? null),
      kind: e.kind,
      value: e.value,
      normalizedValue: e.normalizedValue,
      confidence: e.confidence,
    }));
    this.entities.set(conversationId, entities);

    this.actions.set(
      conversationId,
      input.actionItems.map((a) => ({
        id: uuidv7(),
        conversationId,
        entityId: a.entityIndex === null ? null : (entities[a.entityIndex]?.id ?? null),
        title: a.title,
        dueAt: a.dueAt,
        status: "open",
        confidence: a.confidence,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      })),
    );

    this.embeddings.set(conversationId, { ...input.embedding });
    this.links = this.links
      .filter((l) => l.conversationId !== conversationId)
      .concat(input.recordingLinks.map((l) => ({ ...l, conversationId })));
  }

  findConversation(id: string): Promise<Conversation | null> {
    const c = this.conversations.get(id);
    return Promise.resolve(c && !c.deletedAt ? clone(c) : null);
  }

  findConversationByRecordingId(recordingId: string): Promise<Conversation | null> {
    const link = this.links.find((l) => l.recordingId === recordingId);
    if (!link) return Promise.resolve(null);
    const c = this.conversations.get(link.conversationId);
    return Promise.resolve(c && !c.deletedAt ? clone(c) : null);
  }

  listRecordingLinks(
    conversationId: string,
  ): Promise<Array<{ recordingId: string; startOffsetMs: number; endOffsetMs: number }>> {
    return Promise.resolve(
      this.links
        .filter((l) => l.conversationId === conversationId)
        .map((l) => ({
          recordingId: l.recordingId,
          startOffsetMs: l.startOffsetMs,
          endOffsetMs: l.endOffsetMs,
        })),
    );
  }

  getConversationDetail(id: string): Promise<ConversationDetail | null> {
    const conversation = this.conversations.get(id);
    if (!conversation || conversation.deletedAt) return Promise.resolve(null);
    const speakers = this.speakers.get(id) ?? [];
    const people = [
      ...new Set(speakers.map((s) => s.personId).filter((p): p is string => Boolean(p))),
    ]
      .map((pid) => this.people.get(pid))
      .filter((p): p is Person => Boolean(p) && !isDeleted(p as Person))
      .map(clone);

    return Promise.resolve({
      conversation: clone(conversation),
      speakers: clone(speakers),
      segments: clone(this.segments.get(id) ?? []).sort((a, b) => a.seq - b.seq),
      entities: clone(this.entities.get(id) ?? []),
      actionItems: clone(this.actions.get(id) ?? []),
      people,
      recordingIds: this.links.filter((l) => l.conversationId === id).map((l) => l.recordingId),
    });
  }

  listConversations(filter: ConversationFilter): Promise<Paged<ConversationListItem>> {
    const personConversationIds = filter.personId
      ? new Set(
          [...this.speakers.entries()]
            .filter(([, list]) => list.some((s) => s.personId === filter.personId))
            .map(([cid]) => cid),
        )
      : null;

    let rows: ConversationListItem[] = [...this.conversations.values()]
      .filter((c) => c.userId === filter.userId && !c.deletedAt)
      .filter((c) => !filter.from || c.startedAt.getTime() >= filter.from.getTime())
      .filter((c) => !filter.to || c.startedAt.getTime() < filter.to.getTime())
      .filter((c) => !personConversationIds || personConversationIds.has(c.id))
      .map((c) => ({
        conversation: clone(c),
        people: this.peopleOf(c.id),
        recordingIds: this.links.filter((l) => l.conversationId === c.id).map((l) => l.recordingId),
      }));

    if (filter.q) {
      const needle = filter.q.toLowerCase();
      rows = rows
        .map((row) => {
          const text = [
            row.conversation.title ?? "",
            row.conversation.summary ?? "",
            ...(this.segments.get(row.conversation.id) ?? []).map((s) => s.text),
          ]
            .join(" ")
            .toLowerCase();
          const keyword = text.includes(needle) ? 1 : 0;
          const stored = this.embeddings.get(row.conversation.id);
          const semantic =
            stored && filter.queryVector ? cosine(stored.vector, filter.queryVector) : 0;
          return { ...row, score: Math.max(keyword, Math.max(0, semantic)) };
        })
        .filter((row) => (row.score ?? 0) >= 0.35)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else {
      rows.sort((a, b) => b.conversation.startedAt.getTime() - a.conversation.startedAt.getTime());
    }

    return Promise.resolve({
      items: rows.slice((filter.page - 1) * filter.size, filter.page * filter.size),
      total: rows.length,
    });
  }

  private peopleOf(conversationId: string): Person[] {
    const ids = new Set(
      (this.speakers.get(conversationId) ?? [])
        .map((s) => s.personId)
        .filter((p): p is string => Boolean(p)),
    );
    return [...ids].map((id) => this.people.get(id)).filter((p): p is Person => Boolean(p)).map(clone);
  }

  findPerson(userId: string, displayName: string): Promise<Person | null> {
    const found = [...this.people.values()].find(
      (p) => p.userId === userId && p.displayName === displayName && !isDeleted(p),
    );
    return Promise.resolve(found ? clone(found) : null);
  }

  findPersonById(id: string): Promise<Person | null> {
    const p = this.people.get(id);
    return Promise.resolve(p && !isDeleted(p) ? clone(p) : null);
  }

  createPerson(person: Person): Promise<Person> {
    this.people.set(person.id, clone(person));
    return Promise.resolve(clone(person));
  }

  listPersons(userId: string, page: number, size: number): Promise<Paged<Person>> {
    const all = [...this.people.values()]
      .filter((p) => p.userId === userId && !isDeleted(p))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, "ko"));
    return Promise.resolve({ items: all.slice((page - 1) * size, page * size).map(clone), total: all.length });
  }

  findActionItem(id: string): Promise<ActionItem | null> {
    for (const list of this.actions.values()) {
      const found = list.find((a) => a.id === id);
      if (found) return Promise.resolve(clone(found));
    }
    return Promise.resolve(null);
  }

  updateActionItem(item: ActionItem): Promise<ActionItem> {
    const list = this.actions.get(item.conversationId) ?? [];
    const next = list.map((a) => (a.id === item.id ? clone(item) : a));
    this.actions.set(item.conversationId, next);
    return Promise.resolve(clone(item));
  }

  // ------------------------------------------------------------ analysis jobs
  async createAnalysisJob(job: AnalysisJob): Promise<AnalysisJob> {
    const active = await this.findActiveAnalysisJob(job.recordingId);
    // PostgreSQL 의 부분 유니크 인덱스(analysis_jobs_active_uk)와 같은 의미.
    if (active) return clone(active);
    this.analysisJobs.set(job.id, clone(job));
    return clone(job);
  }

  findAnalysisJob(id: string): Promise<AnalysisJob | null> {
    const job = this.analysisJobs.get(id);
    return Promise.resolve(job ? clone(job) : null);
  }

  findActiveAnalysisJob(recordingId: string): Promise<AnalysisJob | null> {
    const active = [...this.analysisJobs.values()].find(
      (job) => job.recordingId === recordingId && (job.status === "queued" || job.status === "running"),
    );
    return Promise.resolve(active ? clone(active) : null);
  }

  updateAnalysisJob(job: AnalysisJob): Promise<AnalysisJob> {
    this.analysisJobs.set(job.id, clone(job));
    return Promise.resolve(clone(job));
  }

  async claimNextAnalysisJob(now: Date): Promise<AnalysisJob | null> {
    const jobs = [...this.analysisJobs.values()];

    // 만료 임차 회수. 재시도 한도를 이미 쓴 작업은 실패로 종료한다.
    for (const job of jobs) {
      if (job.status !== "running" || !job.leaseExpiresAt) continue;
      if (job.leaseExpiresAt.getTime() > now.getTime()) continue;
      if (job.attempt >= job.maxAttempts) {
        this.analysisJobs.set(job.id, {
          ...job,
          status: "failed",
          leaseExpiresAt: null,
          finishedAt: now,
          lastError: job.lastError ?? "워커 임차 만료",
          updatedAt: now,
        });
      } else {
        this.analysisJobs.set(job.id, {
          ...job,
          status: "queued",
          availableAt: now,
          leaseExpiresAt: null,
          lastError: "워커 임차 만료",
          updatedAt: now,
        });
      }
    }

    const next = [...this.analysisJobs.values()]
      .filter((job) => job.status === "queued" && job.availableAt.getTime() <= now.getTime())
      .sort(
        (a, b) =>
          a.availableAt.getTime() - b.availableAt.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )[0];
    if (!next) return null;

    const claimed: AnalysisJob = {
      ...next,
      status: "running",
      attempt: next.attempt + 1,
      startedAt: now,
      leaseExpiresAt: new Date(now.getTime() + next.timeoutMs),
      updatedAt: now,
    };
    this.analysisJobs.set(claimed.id, claimed);
    return clone(claimed);
  }

  // ---------------------------------------------------------------- sessions
  createSession(session: Session): Promise<Session> {
    this.authSessions.set(session.id, clone(session));
    return Promise.resolve(clone(session));
  }

  findSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const found = [...this.authSessions.values()].find((session) => session.tokenHash === tokenHash);
    return Promise.resolve(found ? clone(found) : null);
  }

  touchSession(id: string, at: Date): Promise<void> {
    const session = this.authSessions.get(id);
    if (session) this.authSessions.set(id, { ...session, lastUsedAt: at });
    return Promise.resolve();
  }

  revokeSession(id: string, at: Date): Promise<void> {
    const session = this.authSessions.get(id);
    if (session) this.authSessions.set(id, { ...session, revokedAt: at });
    return Promise.resolve();
  }

  revokeUserSessions(userId: string, at: Date): Promise<number> {
    let count = 0;
    for (const [id, session] of this.authSessions) {
      if (session.userId === userId && !session.revokedAt) {
        this.authSessions.set(id, { ...session, revokedAt: at });
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
}

function isDeleted(p: Person): boolean {
  return Boolean((p as Person & { deletedAt?: Date | null }).deletedAt);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
