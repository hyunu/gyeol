import pg from "pg";
import { conflict } from "../../domain/errors.ts";
import { uuidv7 } from "../../domain/ids.ts";
import type {
  ActionItem,
  AnalysisJob,
  AuditEvent,
  Conversation,
  ConversationDetail,
  Device,
  ExtractedEntity,
  Person,
  Recording,
  Session,
  SpeakerCluster,
  TranscriptSegment,
  UploadSession,
  User,
  UserAccount,
} from "../../domain/types.ts";
import type {
  ConversationFilter,
  ConversationListItem,
  NewConversation,
  Paged,
  RecordingFilter,
  Store,
} from "../../ports/store.ts";

/**
 * PostgreSQL 저장소 어댑터.
 *
 * 의미(유니크 제약, 정렬, 검색 점수, 재분석 시 파생 교체)는 MemoryStore 와 맞춘다.
 * 스키마: db/migrations/0001_init.sql (ENV-01 적용 검증 완료)
 */

// pg 는 int8/numeric 을 문자열로 돌려준다. 이 어댑터가 다루는 값은 모두 안전한 정수 범위다.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => Number(value));

type Row = Record<string, any>;

const CONVERSATION_COLUMNS = `id, user_id, title, summary, language, started_at, ended_at,
  analysis_version, status, pipeline, created_at, updated_at, deleted_at`;

const PERSON_COLUMNS = `id, user_id, display_name, notes, created_at, updated_at`;

export interface PostgresStoreOptions {
  connectionString?: string;
  pool?: pg.Pool;
}

export class PostgresStore implements Store {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;

  constructor(options: PostgresStoreOptions = {}) {
    const connectionString = options.connectionString ?? process.env.DATABASE_URL;
    if (!options.pool && !connectionString) {
      throw new Error("DATABASE_URL 이 필요합니다. (PostgresStore)");
    }
    this.pool =
      options.pool ??
      new pg.Pool({
        connectionString,
        max: Number(process.env.GYEOL_PG_POOL ?? 10),
      });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ------------------------------------------------------------------ users
  async ensureUser(id: string): Promise<User> {
    await this.pool.query(
      `INSERT INTO users (id, display_name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [id, `로컬 사용자 ${id.slice(0, 8)}`],
    );
    const { rows } = await this.pool.query(
      `SELECT id, display_name, created_at FROM users WHERE id = $1`,
      [id],
    );
    return mapUser(rows[0]);
  }

  async upsertUserByAuthSubject(input: {
    id: string;
    authSubject: string;
    displayName: string;
  }): Promise<User> {
    const { rows } = await this.pool.query(
      `INSERT INTO users (id, auth_subject, display_name) VALUES ($1, $2, $3)
       ON CONFLICT (auth_subject) DO UPDATE SET updated_at = now()
       RETURNING id, display_name, created_at`,
      [input.id, input.authSubject, input.displayName],
    );
    return mapUser(rows[0]);
  }

  // ---------------------------------------------------------------- devices
  async createDevice(device: Device): Promise<Device> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO devices (id, user_id, serial_no, model, hardware_revision, firmware_version,
           lifecycle_status, last_seen_at, battery_pct, storage_free_bytes, config, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          device.id,
          device.userId,
          device.serialNo,
          device.model,
          device.hardwareRevision,
          device.firmwareVersion,
          device.lifecycleStatus,
          device.lastSeenAt,
          device.batteryPct,
          device.storageFreeBytes,
          device.config,
          device.createdAt,
          device.updatedAt,
        ],
      );
      return mapDevice(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err, "devices_serial_no_key")) {
        throw conflict("DEVICE_ALREADY_REGISTERED", "이미 등록된 기기입니다.", device.serialNo);
      }
      throw err;
    }
  }

  async findDevice(id: string): Promise<Device | null> {
    const { rows } = await this.pool.query(`SELECT * FROM devices WHERE id = $1`, [id]);
    return rows[0] ? mapDevice(rows[0]) : null;
  }

  async findDeviceBySerial(serialNo: string): Promise<Device | null> {
    const { rows } = await this.pool.query(`SELECT * FROM devices WHERE serial_no = $1`, [serialNo]);
    return rows[0] ? mapDevice(rows[0]) : null;
  }

  async updateDevice(device: Device): Promise<Device> {
    const { rows } = await this.pool.query(
      `UPDATE devices SET user_id = $2, serial_no = $3, model = $4, hardware_revision = $5,
         firmware_version = $6, lifecycle_status = $7, last_seen_at = $8, battery_pct = $9,
         storage_free_bytes = $10, config = $11, updated_at = $12
       WHERE id = $1
       RETURNING *`,
      [
        device.id,
        device.userId,
        device.serialNo,
        device.model,
        device.hardwareRevision,
        device.firmwareVersion,
        device.lifecycleStatus,
        device.lastSeenAt,
        device.batteryPct,
        device.storageFreeBytes,
        device.config,
        device.updatedAt,
      ],
    );
    return rows[0] ? mapDevice(rows[0]) : device;
  }

  async listDevices(userId: string, page: number, size: number): Promise<Paged<Device>> {
    const { rows } = await this.pool.query(
      `SELECT *, count(*) OVER() AS total FROM devices
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [userId, size, (page - 1) * size],
    );
    return paged(rows, mapDevice);
  }

  // ------------------------------------------------------------- recordings
  async createRecording(recording: Recording): Promise<Recording> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO recordings (
           id, user_id, device_id, client_recording_id, device_seq, started_at, ended_at,
           captured_offset_min, duration_ms, codec, codec_params, sample_rate_hz, channels,
           byte_size, sha256, storage_key, status, vad, uploaded_at, integrity_verified_at,
           storage_verified_at, client_ack_at, analyzed_at, purged_at, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         RETURNING *`,
        recordingParams(recording),
      );
      return mapRecording(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err, "recordings_device_client_uk")) {
        throw conflict(
          "RECORDING_ALREADY_EXISTS",
          "이미 등록된 녹음입니다.",
          recording.clientRecordingId,
        );
      }
      throw err;
    }
  }

  async findRecording(id: string): Promise<Recording | null> {
    const { rows } = await this.pool.query(`SELECT * FROM recordings WHERE id = $1`, [id]);
    return rows[0] ? mapRecording(rows[0]) : null;
  }

  async findRecordingByClientKey(
    deviceId: string,
    clientRecordingId: string,
  ): Promise<Recording | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM recordings WHERE device_id = $1 AND client_recording_id = $2`,
      [deviceId, clientRecordingId],
    );
    return rows[0] ? mapRecording(rows[0]) : null;
  }

  async updateRecording(recording: Recording): Promise<Recording> {
    const { rows } = await this.pool.query(
      `UPDATE recordings SET
         user_id = $2, device_id = $3, client_recording_id = $4, device_seq = $5,
         started_at = $6, ended_at = $7, captured_offset_min = $8, duration_ms = $9,
         codec = $10, codec_params = $11, sample_rate_hz = $12, channels = $13,
         byte_size = $14, sha256 = $15, storage_key = $16, status = $17, vad = $18,
         uploaded_at = $19, integrity_verified_at = $20, storage_verified_at = $21,
         client_ack_at = $22, analyzed_at = $23, purged_at = $24, updated_at = $25, deleted_at = $26
       WHERE id = $1
       RETURNING *`,
      recordingUpdateParams(recording),
    );
    return rows[0] ? mapRecording(rows[0]) : recording;
  }

  async listRecordings(filter: RecordingFilter): Promise<Paged<Recording>> {
    const conditions = ["user_id = $1", "deleted_at IS NULL"];
    const params: unknown[] = [filter.userId];

    if (filter.deviceId) {
      params.push(filter.deviceId);
      conditions.push(`device_id = $${params.length}::uuid`);
    }
    if (filter.status) {
      params.push(filter.status);
      conditions.push(`status = $${params.length}`);
    }
    if (filter.from) {
      params.push(filter.from);
      conditions.push(`started_at >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      conditions.push(`started_at < $${params.length}`);
    }

    params.push(filter.size, (filter.page - 1) * filter.size);
    const { rows } = await this.pool.query(
      `SELECT *, count(*) OVER() AS total FROM recordings
       WHERE ${conditions.join(" AND ")}
       ORDER BY started_at DESC, id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return paged(rows, mapRecording);
  }

  // --------------------------------------------------------- upload sessions
  async createUploadSession(session: UploadSession): Promise<UploadSession> {
    const existing = await this.findOpenUploadSession(session.recordingId);
    if (existing) {
      throw conflict("UPLOAD_SESSION_OPEN", "열린 업로드 세션이 이미 있습니다.", existing.id);
    }
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO upload_sessions (
           id, recording_id, status, expected_bytes, received_bytes, expected_sha256,
           chunk_size_bytes, expires_at, completed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          session.id,
          session.recordingId,
          session.status,
          session.expectedBytes,
          session.receivedBytes,
          session.expectedSha256,
          session.chunkSizeBytes,
          session.expiresAt,
          session.completedAt,
          session.createdAt,
          session.updatedAt,
        ],
      );
      return mapUploadSession(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err, "upload_sessions_open_uk")) {
        throw conflict("UPLOAD_SESSION_OPEN", "열린 업로드 세션이 이미 있습니다.");
      }
      throw err;
    }
  }

  async findUploadSession(id: string): Promise<UploadSession | null> {
    const { rows } = await this.pool.query(`SELECT * FROM upload_sessions WHERE id = $1`, [id]);
    return rows[0] ? mapUploadSession(rows[0]) : null;
  }

  async findOpenUploadSession(recordingId: string): Promise<UploadSession | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM upload_sessions WHERE recording_id = $1 AND status = 'open'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [recordingId],
    );
    return rows[0] ? mapUploadSession(rows[0]) : null;
  }

  async updateUploadSession(session: UploadSession): Promise<UploadSession> {
    const { rows } = await this.pool.query(
      `UPDATE upload_sessions SET status = $2, expected_bytes = $3, received_bytes = $4,
         expected_sha256 = $5, chunk_size_bytes = $6, expires_at = $7, completed_at = $8,
         updated_at = $9
       WHERE id = $1
       RETURNING *`,
      [
        session.id,
        session.status,
        session.expectedBytes,
        session.receivedBytes,
        session.expectedSha256,
        session.chunkSizeBytes,
        session.expiresAt,
        session.completedAt,
        session.updatedAt,
      ],
    );
    return rows[0] ? mapUploadSession(rows[0]) : session;
  }

  async expireUploadSessions(now: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE upload_sessions SET status = 'expired', updated_at = $1
       WHERE status = 'open' AND expires_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  // ---------------------------------------------------------- conversations
  async createConversation(input: NewConversation): Promise<Conversation> {
    return this.tx(async (client) => {
      const id = uuidv7();
      const now = new Date();
      const { rows } = await client.query(
        `INSERT INTO conversations (
           id, user_id, title, summary, language, started_at, ended_at,
           analysis_version, status, pipeline, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING ${CONVERSATION_COLUMNS}`,
        [
          id,
          input.userId,
          input.title || null,
          input.summary || null,
          input.language,
          input.startedAt,
          input.endedAt,
          input.analysisVersion,
          input.status,
          input.pipeline,
          now,
          now,
        ],
      );
      await this.writeDerived(client, id, input);
      return mapConversation(rows[0]);
    });
  }

  async replaceConversation(conversationId: string, input: NewConversation): Promise<Conversation> {
    return this.tx(async (client) => {
      const { rows } = await client.query(
        `UPDATE conversations SET
           title = $2, summary = $3, language = $4, started_at = $5, ended_at = $6,
           analysis_version = $7, status = $8, pipeline = $9, updated_at = now()
         WHERE id = $1
         RETURNING ${CONVERSATION_COLUMNS}`,
        [
          conversationId,
          input.title || null,
          input.summary || null,
          input.language,
          input.startedAt,
          input.endedAt,
          input.analysisVersion,
          input.status,
          input.pipeline,
        ],
      );
      if (!rows[0]) throw conflict("CONVERSATION_MISSING", "대화를 찾을 수 없습니다.", conversationId);

      // 파생 데이터는 교체한다(중복 누적 금지). 삭제 순서는 FK 의존을 따른다.
      await client.query(`DELETE FROM action_items WHERE conversation_id = $1`, [conversationId]);
      await client.query(`DELETE FROM extracted_entities WHERE conversation_id = $1`, [conversationId]);
      await client.query(`DELETE FROM transcript_segments WHERE conversation_id = $1`, [conversationId]);
      await client.query(`DELETE FROM speaker_clusters WHERE conversation_id = $1`, [conversationId]);
      await client.query(`DELETE FROM recording_conversations WHERE conversation_id = $1`, [conversationId]);
      await client.query(`DELETE FROM conversation_embeddings WHERE conversation_id = $1`, [conversationId]);

      await this.writeDerived(client, conversationId, input);
      return mapConversation(rows[0]);
    });
  }

  private async writeDerived(
    client: pg.PoolClient,
    conversationId: string,
    input: NewConversation,
  ): Promise<void> {
    const speakerIdByLabel = new Map<string, string>();
    for (const speaker of input.speakers) {
      const id = uuidv7();
      speakerIdByLabel.set(speaker.label, id);
      await client.query(
        `INSERT INTO speaker_clusters (
           id, conversation_id, label, person_id, identification_status, confidence)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, conversationId, speaker.label, speaker.personId, speaker.identificationStatus, speaker.confidence],
      );
    }

    const segmentIdBySeq = new Map<number, string>();
    for (const segment of input.segments) {
      const id = uuidv7();
      segmentIdBySeq.set(segment.seq, id);
      await client.query(
        `INSERT INTO transcript_segments (
           id, conversation_id, seq, start_ms, end_ms, text, speaker_cluster_id, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          conversationId,
          segment.seq,
          segment.startMs,
          segment.endMs,
          segment.text,
          segment.speakerLabel ? (speakerIdByLabel.get(segment.speakerLabel) ?? null) : null,
          segment.confidence,
        ],
      );
    }

    const entityIds: string[] = [];
    for (const entity of input.entities) {
      const id = uuidv7();
      entityIds.push(id);
      await client.query(
        `INSERT INTO extracted_entities (
           id, conversation_id, segment_id, kind, value, normalized_value, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          conversationId,
          entity.segmentSeq === null ? null : (segmentIdBySeq.get(entity.segmentSeq) ?? null),
          entity.kind,
          entity.value,
          entity.normalizedValue,
          entity.confidence,
        ],
      );
    }

    for (const item of input.actionItems) {
      await client.query(
        `INSERT INTO action_items (
           id, conversation_id, entity_id, title, due_at, status, confidence, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'open',$6,now(),now())`,
        [
          uuidv7(),
          conversationId,
          item.entityIndex === null ? null : (entityIds[item.entityIndex] ?? null),
          item.title,
          item.dueAt,
          item.confidence,
        ],
      );
    }

    await client.query(
      `INSERT INTO conversation_embeddings (id, conversation_id, provider, model, dim, embedding)
       VALUES ($1,$2,$3,$4,$5,$6::vector)`,
      [
        uuidv7(),
        conversationId,
        input.embedding.provider,
        input.embedding.model,
        input.embedding.dim,
        toVector(input.embedding.vector),
      ],
    );

    for (const link of input.recordingLinks) {
      await client.query(
        `INSERT INTO recording_conversations (
           recording_id, conversation_id, start_offset_ms, end_offset_ms)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (recording_id, conversation_id) DO UPDATE SET
           start_offset_ms = EXCLUDED.start_offset_ms,
           end_offset_ms = EXCLUDED.end_offset_ms`,
        [link.recordingId, conversationId, link.startOffsetMs, link.endOffsetMs],
      );
    }
  }

  async findConversation(id: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query(
      `SELECT ${CONVERSATION_COLUMNS} FROM conversations
       WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? mapConversation(rows[0]) : null;
  }

  async findConversationByRecordingId(recordingId: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query(
      `SELECT ${CONVERSATION_COLUMNS.split(",").map((c) => `c.${c.trim()}`).join(", ")}
       FROM conversations c
       JOIN recording_conversations rc ON rc.conversation_id = c.id
       WHERE rc.recording_id = $1 AND c.deleted_at IS NULL
       ORDER BY rc.created_at DESC, c.id DESC
       LIMIT 1`,
      [recordingId],
    );
    return rows[0] ? mapConversation(rows[0]) : null;
  }

  async listRecordingLinks(
    conversationId: string,
  ): Promise<Array<{ recordingId: string; startOffsetMs: number; endOffsetMs: number }>> {
    const { rows } = await this.pool.query(
      `SELECT recording_id, start_offset_ms, end_offset_ms FROM recording_conversations
       WHERE conversation_id = $1 ORDER BY start_offset_ms ASC, recording_id ASC`,
      [conversationId],
    );
    return rows.map((row) => ({
      recordingId: row.recording_id,
      startOffsetMs: row.start_offset_ms,
      endOffsetMs: row.end_offset_ms,
    }));
  }

  async getConversationDetail(id: string): Promise<ConversationDetail | null> {
    const conversation = await this.findConversation(id);
    if (!conversation) return null;

    const [speakers, segments, entities, actionItems, people, links] = await Promise.all([
      this.pool.query(`SELECT * FROM speaker_clusters WHERE conversation_id = $1 ORDER BY label ASC`, [id]),
      this.pool.query(
        `SELECT * FROM transcript_segments WHERE conversation_id = $1 ORDER BY seq ASC, id ASC`,
        [id],
      ),
      this.pool.query(
        `SELECT * FROM extracted_entities WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
        [id],
      ),
      this.pool.query(
        `SELECT * FROM action_items WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC`,
        [id],
      ),
      this.pool.query(
        `SELECT DISTINCT p.id, p.user_id, p.display_name, p.notes, p.created_at, p.updated_at
         FROM persons p
         JOIN speaker_clusters sc ON sc.person_id = p.id
         WHERE sc.conversation_id = ANY($1::uuid[]) AND p.deleted_at IS NULL
         ORDER BY p.display_name ASC, p.id ASC`,
        [[id]],
      ),
      this.listRecordingLinks(id),
    ]);

    return {
      conversation,
      speakers: speakers.rows.map(mapSpeakerCluster),
      segments: segments.rows.map(mapTranscriptSegment),
      entities: entities.rows.map(mapExtractedEntity),
      actionItems: actionItems.rows.map(mapActionItem),
      people: people.rows.map(mapPerson),
      recordingIds: links.map((link) => link.recordingId),
    };
  }

  async listConversations(filter: ConversationFilter): Promise<Paged<ConversationListItem>> {
    const conditions = ["c.user_id = $1", "c.deleted_at IS NULL"];
    const params: unknown[] = [filter.userId];

    if (filter.from) {
      params.push(filter.from);
      conditions.push(`c.started_at >= $${params.length}`);
    }
    if (filter.to) {
      params.push(filter.to);
      conditions.push(`c.started_at < $${params.length}`);
    }
    if (filter.personId) {
      params.push(filter.personId);
      conditions.push(
        `EXISTS (SELECT 1 FROM speaker_clusters sc
                 WHERE sc.conversation_id = c.id AND sc.person_id = $${params.length}::uuid)`,
      );
    }

    if (filter.q) {
      // 키워드 후보를 먼저 좁히고(trigram GIN), 의미 후보는 HNSW top-K 로 가져와 합친다.
      params.push(`%${escapeLike(filter.q)}%`);
      const pattern = `$${params.length}`;
      const textHit = `(c.title ILIKE ${pattern} ESCAPE '\\'
        OR c.summary ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM transcript_segments ts
                   WHERE ts.conversation_id = c.id AND ts.text ILIKE ${pattern} ESCAPE '\\'))`;

      let semanticCte = `SELECT NULL::uuid AS id, 0::double precision AS score WHERE false`;
      let unionSemantic = "";
      if (filter.queryVector) {
        params.push(toVector(filter.queryVector));
        const vector = `$${params.length}::vector`;
        const topK = Math.max(200, filter.size * 10);
        params.push(topK);
        const k = `$${params.length}`;
        semanticCte = `SELECT ce.conversation_id AS id,
             (1 - (ce.embedding <=> ${vector}))::double precision AS score
           FROM conversation_embeddings ce
           JOIN conversations c ON c.id = ce.conversation_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY ce.embedding <=> ${vector}
           LIMIT ${k}`;
        unionSemantic = "UNION ALL SELECT * FROM semantic";
      }

      params.push(filter.size, (filter.page - 1) * filter.size);
      const limitIndex = params.length - 1;
      const offsetIndex = params.length;
      const { rows } = await this.pool.query(
        `WITH keyword AS (
           SELECT c.id, 1.0::double precision AS score
           FROM conversations c
           WHERE ${conditions.join(" AND ")} AND ${textHit}
         ),
         semantic AS (
           ${semanticCte}
         ),
         combined AS (
           SELECT id, max(score) AS score
           FROM (SELECT * FROM keyword ${unionSemantic}) candidates
           GROUP BY id
         )
         SELECT ${CONVERSATION_COLUMNS.split(",").map((c) => `c.${c.trim()}`).join(", ")},
                combined.score, count(*) OVER() AS total
         FROM combined
         JOIN conversations c ON c.id = combined.id
         WHERE combined.score >= 0.35
         ORDER BY combined.score DESC, c.started_at DESC, c.id DESC
         LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
        params,
      );
      return this.mapConversationPage(rows, true);
    }

    params.push(filter.size, (filter.page - 1) * filter.size);
    const limitIndex = params.length - 1;
    const offsetIndex = params.length;
    const { rows } = await this.pool.query(
      `SELECT ${CONVERSATION_COLUMNS.split(",").map((c) => `c.${c.trim()}`).join(", ")},
              count(*) OVER() AS total
       FROM conversations c
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.started_at DESC, c.id DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      params,
    );
    return this.mapConversationPage(rows);
  }

  private async mapConversationPage(
    rows: Row[],
    includeScore = false,
  ): Promise<Paged<ConversationListItem>> {
    if (rows.length === 0) return { items: [], total: 0 };
    const ids = rows.map((row) => row.id);
    const [peopleLinks, linkRows] = await Promise.all([
      this.pool.query(
        `SELECT DISTINCT sc.conversation_id, p.id, p.user_id, p.display_name, p.notes,
                p.created_at, p.updated_at
         FROM speaker_clusters sc
         JOIN persons p ON p.id = sc.person_id
         WHERE sc.conversation_id = ANY($1::uuid[]) AND p.deleted_at IS NULL
         ORDER BY sc.conversation_id ASC, p.display_name ASC`,
        [ids],
      ),
      this.pool.query(
        `SELECT conversation_id, recording_id FROM recording_conversations
         WHERE conversation_id = ANY($1::uuid[]) ORDER BY start_offset_ms ASC, recording_id ASC`,
        [ids],
      ),
    ]);

    const peopleByConversation = new Map<string, Person[]>();
    for (const row of peopleLinks.rows) {
      const list = peopleByConversation.get(row.conversation_id) ?? [];
      list.push(mapPerson(row));
      peopleByConversation.set(row.conversation_id, list);
    }

    const linksByConversation = new Map<string, string[]>();
    for (const row of linkRows.rows) {
      const list = linksByConversation.get(row.conversation_id) ?? [];
      list.push(row.recording_id);
      linksByConversation.set(row.conversation_id, list);
    }

    const total = Number(rows[0].total ?? 0);
    const items: ConversationListItem[] = rows.map((row) => ({
      conversation: mapConversation(row),
      people: peopleByConversation.get(row.id) ?? [],
      recordingIds: linksByConversation.get(row.id) ?? [],
      ...(includeScore ? { score: Number(row.score ?? 0) } : {}),
    }));

    return { items, total };
  }

  // ---------------------------------------------------------------- persons
  async findPerson(userId: string, displayName: string): Promise<Person | null> {
    const { rows } = await this.pool.query(
      `SELECT ${PERSON_COLUMNS} FROM persons
       WHERE user_id = $1 AND display_name = $2 AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
      [userId, displayName],
    );
    return rows[0] ? mapPerson(rows[0]) : null;
  }

  async findPersonById(id: string): Promise<Person | null> {
    const { rows } = await this.pool.query(
      `SELECT ${PERSON_COLUMNS} FROM persons WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] ? mapPerson(rows[0]) : null;
  }

  async createPerson(person: Person): Promise<Person> {
    const { rows } = await this.pool.query(
      `INSERT INTO persons (id, user_id, display_name, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${PERSON_COLUMNS}`,
      [person.id, person.userId, person.displayName, person.notes, person.createdAt, person.updatedAt],
    );
    return mapPerson(rows[0]);
  }

  async listPersons(userId: string, page: number, size: number): Promise<Paged<Person>> {
    const { rows } = await this.pool.query(
      `SELECT *, count(*) OVER() AS total FROM persons
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY display_name ASC, id ASC
       LIMIT $2 OFFSET $3`,
      [userId, size, (page - 1) * size],
    );
    return paged(rows, mapPerson);
  }

  // ------------------------------------------------------------ action items
  async findActionItem(id: string): Promise<ActionItem | null> {
    const { rows } = await this.pool.query(`SELECT * FROM action_items WHERE id = $1`, [id]);
    return rows[0] ? mapActionItem(rows[0]) : null;
  }

  async updateActionItem(item: ActionItem): Promise<ActionItem> {
    const { rows } = await this.pool.query(
      `UPDATE action_items SET entity_id = $2, title = $3, due_at = $4, status = $5,
         confidence = $6, updated_at = $7, completed_at = $8
       WHERE id = $1
       RETURNING *`,
      [
        item.id,
        item.entityId,
        item.title,
        item.dueAt,
        item.status,
        item.confidence,
        item.updatedAt,
        item.completedAt,
      ],
    );
    return rows[0] ? mapActionItem(rows[0]) : item;
  }

  // ----------------------------------------------------------- analysis jobs
  async createAnalysisJob(job: AnalysisJob): Promise<AnalysisJob> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO analysis_jobs (
           id, user_id, recording_id, status, attempt, max_attempts, timeout_ms,
           available_at, started_at, finished_at, lease_expires_at, conversation_id,
           last_error, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        analysisJobParams(job),
      );
      return mapAnalysisJob(rows[0]);
    } catch (err) {
      if (isUniqueViolation(err, "analysis_jobs_active_uk")) {
        const active = await this.findActiveAnalysisJob(job.recordingId);
        if (active) return active;
      }
      throw err;
    }
  }

  async findUserAccount(id: string): Promise<UserAccount | null> {
    const { rows } = await this.pool.query(
      `SELECT id, display_name, status, deleted_at FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapUserAccount(rows[0]) : null;
  }

  async markUserDeleted(id: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE users SET status = 'deleted', deleted_at = COALESCE(deleted_at, $2), updated_at = $2
       WHERE id = $1`,
      [id, at],
    );
  }

  async listUsersPendingPurge(cutoff: Date, limit: number): Promise<UserAccount[]> {
    const { rows } = await this.pool.query(
      `SELECT id, display_name, status, deleted_at FROM users
       WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at <= $1
       ORDER BY deleted_at ASC LIMIT $2`,
      [cutoff, limit],
    );
    return rows.map(mapUserAccount);
  }

  async purgeUser(userId: string): Promise<void> {
    await this.tx(async (client) => {
      await client.query(`DELETE FROM analysis_jobs WHERE user_id = $1`, [userId]);
      await client.query(
        `DELETE FROM speaker_embeddings
         WHERE speaker_cluster_id IN (
           SELECT sc.id FROM speaker_clusters sc
           JOIN conversations c ON c.id = sc.conversation_id WHERE c.user_id = $1
         ) OR person_id IN (SELECT id FROM persons WHERE user_id = $1)`,
        [userId],
      );
      for (const table of [
        "action_items",
        "extracted_entities",
        "transcript_segments",
        "speaker_clusters",
        "conversation_embeddings",
      ]) {
        await client.query(
          `DELETE FROM ${table} WHERE conversation_id IN
           (SELECT id FROM conversations WHERE user_id = $1)`,
          [userId],
        );
      }
      await client.query(
        `DELETE FROM recording_conversations
         WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = $1)
            OR recording_id IN (SELECT id FROM recordings WHERE user_id = $1)`,
        [userId],
      );
      await client.query(`DELETE FROM conversations WHERE user_id = $1`, [userId]);
      await client.query(
        `DELETE FROM upload_sessions WHERE recording_id IN
         (SELECT id FROM recordings WHERE user_id = $1)`,
        [userId],
      );
      await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM recordings WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM persons WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM devices WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });
  }

  async findRecordingPurgeCandidates(cutoff: Date, limit: number): Promise<Recording[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM recordings
       WHERE status IN ('analyzed', 'analysis_failed', 'stored')
         AND client_ack_at IS NOT NULL
         AND storage_key IS NOT NULL
         AND deleted_at IS NULL
         AND COALESCE(analyzed_at, client_ack_at) <= $1
       ORDER BY COALESCE(analyzed_at, client_ack_at) ASC
       LIMIT $2`,
      [cutoff, limit],
    );
    return rows.map(mapRecording);
  }

  async createAuditEvent(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (id, user_id, action, resource_type, resource_id, trace_id, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        event.id,
        event.userId,
        event.action,
        event.resourceType,
        event.resourceId,
        event.traceId,
        event.metadata,
        event.createdAt,
      ],
    );
  }

  async listAuditEvents(userId: string, limit = 100): Promise<AuditEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM audit_events WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(mapAuditEvent);
  }

  async findAnalysisJob(id: string): Promise<AnalysisJob | null> {
    const { rows } = await this.pool.query(`SELECT * FROM analysis_jobs WHERE id = $1`, [id]);
    return rows[0] ? mapAnalysisJob(rows[0]) : null;
  }

  async findActiveAnalysisJob(recordingId: string): Promise<AnalysisJob | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM analysis_jobs
       WHERE recording_id = $1 AND status IN ('queued', 'running')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [recordingId],
    );
    return rows[0] ? mapAnalysisJob(rows[0]) : null;
  }

  async updateAnalysisJob(job: AnalysisJob): Promise<AnalysisJob> {
    const { rows } = await this.pool.query(
      `UPDATE analysis_jobs SET
         status = $2, attempt = $3, max_attempts = $4, timeout_ms = $5, available_at = $6,
         started_at = $7, finished_at = $8, lease_expires_at = $9, conversation_id = $10,
         last_error = $11, updated_at = $12
       WHERE id = $1
       RETURNING *`,
      [
        job.id,
        job.status,
        job.attempt,
        job.maxAttempts,
        job.timeoutMs,
        job.availableAt,
        job.startedAt,
        job.finishedAt,
        job.leaseExpiresAt,
        job.conversationId,
        job.lastError,
        job.updatedAt,
      ],
    );
    return rows[0] ? mapAnalysisJob(rows[0]) : job;
  }

  async claimNextAnalysisJob(now: Date): Promise<AnalysisJob | null> {
    return this.tx(async (client) => {
      // 워커가 죽어 임차가 만료된 작업을 회수한다. 재시도 한도를 쓴 작업은 종료한다.
      await client.query(
        `UPDATE analysis_jobs SET status = 'failed', finished_at = $1, updated_at = $1,
           last_error = COALESCE(last_error, '워커 임차 만료')
         WHERE status = 'running' AND lease_expires_at <= $1 AND attempt >= max_attempts`,
        [now],
      );
      await client.query(
        `UPDATE analysis_jobs SET status = 'queued', available_at = $1, updated_at = $1,
           last_error = COALESCE(last_error, '워커 임차 만료')
         WHERE status = 'running' AND lease_expires_at <= $1`,
        [now],
      );

      const { rows } = await client.query(
        `UPDATE analysis_jobs SET
           status = 'running', attempt = attempt + 1, started_at = $1,
           lease_expires_at = $1::timestamptz + (timeout_ms * interval '1 millisecond'),
           updated_at = $1
         WHERE id = (
           SELECT id FROM analysis_jobs
           WHERE status = 'queued' AND available_at <= $1
           ORDER BY available_at ASC, created_at ASC, id ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [now],
      );
      return rows[0] ? mapAnalysisJob(rows[0]) : null;
    });
  }

  // ---------------------------------------------------------------- sessions
  async createSession(session: Session): Promise<Session> {
    const { rows } = await this.pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at,
         last_used_at, revoked_at, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        session.id,
        session.userId,
        session.tokenHash,
        session.createdAt,
        session.expiresAt,
        session.lastUsedAt,
        session.revokedAt,
        session.userAgent,
      ],
    );
    return mapSession(rows[0]);
  }

  async findSessionByTokenHash(tokenHash: string): Promise<Session | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async touchSession(id: string, at: Date): Promise<void> {
    await this.pool.query(`UPDATE sessions SET last_used_at = $2 WHERE id = $1`, [id, at]);
  }

  async revokeSession(id: string, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1`,
      [id, at],
    );
  }

  async revokeUserSessions(userId: string, at: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE sessions SET revoked_at = $2
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, at],
    );
    return result.rowCount ?? 0;
  }
}

// ------------------------------------------------------------------ mapping

function paged<T>(rows: Row[], map: (row: Row) => T): Paged<T> {
  if (rows.length === 0) return { items: [], total: 0 };
  return { items: rows.map(map), total: Number(rows[0].total ?? 0) };
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function mapUser(row: Row): User {
  return { id: row.id, displayName: row.display_name, createdAt: row.created_at };
}

function mapUserAccount(row: Row): UserAccount {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    deletedAt: row.deleted_at ?? null,
  };
}

function mapAuditEvent(row: Row): AuditEvent {
  return {
    id: row.id,
    userId: row.user_id ?? null,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? null,
    traceId: row.trace_id ?? null,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function mapDevice(row: Row): Device {
  return {
    id: row.id,
    userId: row.user_id ?? null,
    serialNo: row.serial_no,
    model: row.model,
    hardwareRevision: row.hardware_revision ?? null,
    firmwareVersion: row.firmware_version ?? null,
    lifecycleStatus: row.lifecycle_status,
    lastSeenAt: row.last_seen_at ?? null,
    batteryPct: num(row.battery_pct),
    storageFreeBytes: num(row.storage_free_bytes),
    config: row.config ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRecording(row: Row): Recording {
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    clientRecordingId: row.client_recording_id,
    deviceSeq: num(row.device_seq),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    capturedOffsetMin: num(row.captured_offset_min),
    durationMs: Number(row.duration_ms),
    codec: row.codec,
    codecParams: row.codec_params ?? null,
    sampleRateHz: Number(row.sample_rate_hz),
    channels: Number(row.channels),
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    storageKey: row.storage_key ?? null,
    status: row.status,
    vad: row.vad ?? null,
    uploadedAt: row.uploaded_at ?? null,
    integrityVerifiedAt: row.integrity_verified_at ?? null,
    storageVerifiedAt: row.storage_verified_at ?? null,
    clientAckAt: row.client_ack_at ?? null,
    analyzedAt: row.analyzed_at ?? null,
    purgedAt: row.purged_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

function mapUploadSession(row: Row): UploadSession {
  return {
    id: row.id,
    recordingId: row.recording_id,
    status: row.status,
    expectedBytes: Number(row.expected_bytes),
    receivedBytes: Number(row.received_bytes),
    expectedSha256: row.expected_sha256,
    chunkSizeBytes: Number(row.chunk_size_bytes),
    expiresAt: row.expires_at,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: Row): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title ?? null,
    summary: row.summary ?? null,
    language: row.language,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    analysisVersion: Number(row.analysis_version),
    status: row.status,
    pipeline: row.pipeline ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

function mapPerson(row: Row): Person {
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSpeakerCluster(row: Row): SpeakerCluster {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    label: row.label,
    personId: row.person_id ?? null,
    identificationStatus: row.identification_status,
    confidence: num(row.confidence),
  };
}

function mapTranscriptSegment(row: Row): TranscriptSegment {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    seq: Number(row.seq),
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    text: row.text,
    speakerClusterId: row.speaker_cluster_id ?? null,
    confidence: num(row.confidence),
  };
}

function mapExtractedEntity(row: Row): ExtractedEntity {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    segmentId: row.segment_id ?? null,
    kind: row.kind,
    value: row.value,
    normalizedValue: row.normalized_value ?? null,
    confidence: num(row.confidence),
  };
}

function mapActionItem(row: Row): ActionItem {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    entityId: row.entity_id ?? null,
    title: row.title,
    dueAt: row.due_at ?? null,
    status: row.status,
    confidence: num(row.confidence),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

function mapSession(row: Row): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at ?? null,
    revokedAt: row.revoked_at ?? null,
    userAgent: row.user_agent ?? null,
  };
}

function mapAnalysisJob(row: Row): AnalysisJob {
  return {
    id: row.id,
    userId: row.user_id,
    recordingId: row.recording_id,
    status: row.status,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    timeoutMs: Number(row.timeout_ms),
    availableAt: row.available_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    conversationId: row.conversation_id ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ------------------------------------------------------------------- params

function recordingParams(recording: Recording): unknown[] {
  return [
    recording.id,
    recording.userId,
    recording.deviceId,
    recording.clientRecordingId,
    recording.deviceSeq,
    recording.startedAt,
    recording.endedAt,
    recording.capturedOffsetMin,
    recording.durationMs,
    recording.codec,
    recording.codecParams,
    recording.sampleRateHz,
    recording.channels,
    recording.byteSize,
    recording.sha256,
    recording.storageKey,
    recording.status,
    recording.vad,
    recording.uploadedAt,
    recording.integrityVerifiedAt,
    recording.storageVerifiedAt,
    recording.clientAckAt,
    recording.analyzedAt,
    recording.purgedAt,
    recording.createdAt,
    recording.updatedAt,
    recording.deletedAt,
  ];
}

function recordingUpdateParams(recording: Recording): unknown[] {
  const params = recordingParams(recording);
  // UPDATE 는 created_at 을 바꾸지 않는다(recordingParams 의 25번째 값, 0-based index 24).
  params.splice(24, 1);
  return params;
}

function analysisJobParams(job: AnalysisJob): unknown[] {
  return [
    job.id,
    job.userId,
    job.recordingId,
    job.status,
    job.attempt,
    job.maxAttempts,
    job.timeoutMs,
    job.availableAt,
    job.startedAt,
    job.finishedAt,
    job.leaseExpiresAt,
    job.conversationId,
    job.lastError,
    job.createdAt,
    job.updatedAt,
  ];
}

// ------------------------------------------------------------------- helpers

function toVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pgError = err as { code?: string; constraint?: string };
  return pgError.code === "23505" && pgError.constraint === constraint;
}
