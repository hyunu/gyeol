-- GYEOL Phase 1 초기 스키마
-- 기준: docs/10-domain-model.md v1.1 (M-01~M-04 반영)
--
-- 실행: npm run db:migrate   (트랜잭션은 마이그레이션 러너가 관리한다)
-- 주의: 이 파일은 아직 실제 PostgreSQL 에서 실행 검증되지 않았다 (ENV-PENDING).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id                uuid PRIMARY KEY,
  auth_subject      text UNIQUE,
  email             citext UNIQUE,
  display_name      text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  locale            text NOT NULL DEFAULT 'ko-KR',
  timezone          text NOT NULL DEFAULT 'Asia/Seoul',
  status            text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX users_status_idx ON users (status);

COMMENT ON COLUMN users.auth_subject IS 'TBD(D-01): 인증 방식 확정 시 사용';

-- ---------------------------------------------------------------- devices
CREATE TABLE devices (
  id                  uuid PRIMARY KEY,
  user_id             uuid REFERENCES users (id) ON DELETE SET NULL,
  serial_no           text NOT NULL UNIQUE,
  model               text NOT NULL,
  hardware_revision   text,
  firmware_version    text,
  lifecycle_status    text NOT NULL DEFAULT 'provisioned'
                      CHECK (lifecycle_status IN ('provisioned', 'active', 'retired')),
  last_seen_at        timestamptz,
  battery_pct         smallint CHECK (battery_pct BETWEEN 0 AND 100),
  storage_free_bytes  bigint CHECK (storage_free_bytes >= 0),
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices (user_id);
CREATE INDEX devices_last_seen_idx ON devices (last_seen_at);

COMMENT ON TABLE devices IS '연결 상태(online/offline)는 last_seen_at + TTL 로 파생한다. 컬럼으로 저장하지 않는다.';

-- ---------------------------------------------------------- recordings
CREATE TABLE recordings (
  id                      uuid PRIMARY KEY,
  user_id                 uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  device_id               uuid NOT NULL REFERENCES devices (id) ON DELETE RESTRICT,
  client_recording_id     text NOT NULL,
  device_seq              bigint,
  started_at              timestamptz NOT NULL,
  ended_at                timestamptz NOT NULL,
  captured_offset_min     smallint CHECK (captured_offset_min BETWEEN -840 AND 840),
  duration_ms             integer NOT NULL CHECK (duration_ms > 0),
  codec                   text NOT NULL,
  codec_params            jsonb,
  sample_rate_hz          integer NOT NULL CHECK (sample_rate_hz > 0),
  channels                smallint NOT NULL CHECK (channels > 0),
  byte_size               bigint NOT NULL CHECK (byte_size > 0),
  sha256                  char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key             text,
  status                  text NOT NULL DEFAULT 'initiated'
                          CHECK (status IN ('initiated', 'uploading', 'stored', 'analyzing',
                                            'analyzed', 'analysis_failed', 'integrity_failed',
                                            'purged')),
  vad                     jsonb,
  uploaded_at             timestamptz,
  integrity_verified_at   timestamptz,
  storage_verified_at     timestamptz,
  client_ack_at           timestamptz,
  analyzed_at             timestamptz,
  purged_at               timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT recordings_time_window_chk CHECK (ended_at > started_at)
);
CREATE UNIQUE INDEX recordings_device_client_uk ON recordings (device_id, client_recording_id);
CREATE INDEX recordings_user_started_idx ON recordings (user_id, started_at DESC);
CREATE INDEX recordings_device_status_idx ON recordings (device_id, status);

COMMENT ON COLUMN recordings.codec IS 'D-04 미확정. WAV/ADPCM/Opus 비교 전까지 자유 문자열';
COMMENT ON COLUMN recordings.codec_params IS '코덱별 파라미터(bit depth, frame size 등)';
COMMENT ON COLUMN recordings.integrity_verified_at IS 'M-04 조건 1,2: 크기·SHA-256 검증 완료';
COMMENT ON COLUMN recordings.storage_verified_at IS 'M-04 조건 3: Object Storage 저장 완료';
COMMENT ON COLUMN recordings.client_ack_at IS 'M-04 조건 5: 클라이언트 최종 ACK 수신';

-- ------------------------------------------------------ upload_sessions
CREATE TABLE upload_sessions (
  id                uuid PRIMARY KEY,
  recording_id      uuid NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'completed', 'aborted', 'expired')),
  expected_bytes    bigint NOT NULL CHECK (expected_bytes > 0),
  received_bytes    bigint NOT NULL DEFAULT 0
                    CHECK (received_bytes >= 0 AND received_bytes <= expected_bytes),
  expected_sha256   char(64) NOT NULL CHECK (expected_sha256 ~ '^[0-9a-f]{64}$'),
  chunk_size_bytes  integer NOT NULL CHECK (chunk_size_bytes > 0),
  expires_at        timestamptz NOT NULL,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX upload_sessions_open_uk ON upload_sessions (recording_id)
  WHERE status = 'open';
CREATE INDEX upload_sessions_expiry_idx ON upload_sessions (expires_at)
  WHERE status = 'open';

COMMENT ON TABLE upload_sessions IS '세션 만료는 Recording 삭제가 아니다. 새 세션으로 재전송한다(M-04).';

-- -------------------------------------------------------- conversations
CREATE TABLE conversations (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  title             text CHECK (title IS NULL OR char_length(title) <= 200),
  summary           text,
  language          text NOT NULL DEFAULT 'ko',
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz NOT NULL,
  analysis_version  integer NOT NULL DEFAULT 1 CHECK (analysis_version > 0),
  status            text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'partial')),
  pipeline          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  CONSTRAINT conversations_time_window_chk CHECK (ended_at > started_at)
);
CREATE INDEX conversations_user_started_idx ON conversations (user_id, started_at DESC);
CREATE INDEX conversations_status_idx ON conversations (status);

-- ------------------------------------------- recording_conversations (M-01)
CREATE TABLE recording_conversations (
  recording_id      uuid NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  start_offset_ms   integer NOT NULL CHECK (start_offset_ms >= 0),
  end_offset_ms     integer NOT NULL CHECK (end_offset_ms > start_offset_ms),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, conversation_id)
);
CREATE INDEX recording_conversations_conversation_idx
  ON recording_conversations (conversation_id);
CREATE INDEX recording_conversations_recording_idx
  ON recording_conversations (recording_id, start_offset_ms);

COMMENT ON TABLE recording_conversations IS 'M-01: 하나의 녹음에 여러 대화, 여러 녹음에 걸친 하나의 대화를 지원';

-- --------------------------------------------------------------- persons
CREATE TABLE persons (
  id                      uuid PRIMARY KEY,
  user_id                 uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  display_name            text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  notes                   text,
  merged_into_person_id   uuid REFERENCES persons (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CONSTRAINT persons_no_self_merge CHECK (merged_into_person_id IS NULL
                                          OR merged_into_person_id <> id)
);
CREATE INDEX persons_user_name_idx ON persons (user_id, display_name);

-- ------------------------------------------------------ speaker_clusters
CREATE TABLE speaker_clusters (
  id                     uuid PRIMARY KEY,
  conversation_id        uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  label                  text NOT NULL,
  person_id              uuid REFERENCES persons (id) ON DELETE SET NULL,
  identification_status  text NOT NULL DEFAULT 'unknown'
                         CHECK (identification_status IN ('unknown', 'suggested', 'confirmed')),
  confidence             numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, label),
  CONSTRAINT speaker_clusters_person_consistency_chk
    CHECK (identification_status = 'unknown' OR person_id IS NOT NULL)
);
CREATE INDEX speaker_clusters_person_idx ON speaker_clusters (person_id);

COMMENT ON TABLE speaker_clusters IS 'Unknown Speaker 는 person_id IS NULL 로 표현한다. persons 행을 만들지 않는다.';

-- --------------------------------------------------- transcript_segments
CREATE TABLE transcript_segments (
  id                   uuid PRIMARY KEY,
  conversation_id      uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  seq                  integer NOT NULL CHECK (seq >= 0),
  start_ms             integer NOT NULL CHECK (start_ms >= 0),
  end_ms               integer NOT NULL,
  text                 text NOT NULL,
  speaker_cluster_id   uuid REFERENCES speaker_clusters (id) ON DELETE SET NULL,
  confidence           numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  CONSTRAINT transcript_segments_time_chk CHECK (end_ms > start_ms)
);
CREATE INDEX transcript_segments_conversation_idx ON transcript_segments (conversation_id, seq);

-- ---------------------------------------------------- speaker_embeddings
CREATE TABLE speaker_embeddings (
  id                   uuid PRIMARY KEY,
  person_id            uuid REFERENCES persons (id) ON DELETE CASCADE,
  speaker_cluster_id   uuid REFERENCES speaker_clusters (id) ON DELETE CASCADE,
  provider             text NOT NULL,
  model                text NOT NULL,
  dim                  smallint NOT NULL CHECK (dim > 0),
  embedding            vector(256) NOT NULL,
  quality              numeric(4, 3) CHECK (quality BETWEEN 0 AND 1),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT speaker_embeddings_owner_chk
    CHECK (person_id IS NOT NULL OR speaker_cluster_id IS NOT NULL)
);
CREATE INDEX speaker_embeddings_person_idx ON speaker_embeddings (person_id);
CREATE INDEX speaker_embeddings_cluster_idx ON speaker_embeddings (speaker_cluster_id);

COMMENT ON COLUMN speaker_embeddings.embedding IS 'D-05 실험값 256차원. 모델 확정 시 마이그레이션으로 변경';
COMMENT ON TABLE speaker_embeddings IS '음성 생체 정보. 원본 오디오와 별도로 삭제한다.';

-- ---------------------------------------------------- extracted_entities
CREATE TABLE extracted_entities (
  id                 uuid PRIMARY KEY,
  conversation_id    uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  segment_id         uuid REFERENCES transcript_segments (id) ON DELETE SET NULL,
  kind               text NOT NULL
                     CHECK (kind IN ('person', 'place', 'event', 'appointment', 'task', 'other')),
  value              text NOT NULL,
  normalized_value   text,
  confidence         numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extracted_entities_conversation_idx ON extracted_entities (conversation_id, kind);
CREATE INDEX extracted_entities_normalized_idx ON extracted_entities (normalized_value);

-- --------------------------------------------------------- action_items
CREATE TABLE action_items (
  id                 uuid PRIMARY KEY,
  conversation_id    uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  entity_id          uuid REFERENCES extracted_entities (id) ON DELETE SET NULL,
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  due_at             timestamptz,
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'done', 'dismissed')),
  confidence         numeric(4, 3) CHECK (confidence BETWEEN 0 AND 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz
);
CREATE INDEX action_items_conversation_idx ON action_items (conversation_id, status);
CREATE INDEX action_items_open_due_idx ON action_items (due_at) WHERE status = 'open';

-- ------------------------------------------------ conversation_embeddings
CREATE TABLE conversation_embeddings (
  id                 uuid PRIMARY KEY,
  conversation_id    uuid NOT NULL UNIQUE REFERENCES conversations (id) ON DELETE CASCADE,
  provider           text NOT NULL,
  model              text NOT NULL,
  dim                smallint NOT NULL CHECK (dim > 0),
  embedding          vector(768) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN conversation_embeddings.embedding IS 'D-05 실험값 768차원. 모델 확정 시 마이그레이션으로 변경';

-- --------------------------------------------------- speaker_id_thresholds
CREATE TABLE speaker_id_thresholds (
  provider          text NOT NULL,
  model             text NOT NULL,
  threshold         numeric(4, 3) NOT NULL DEFAULT 0.800 CHECK (threshold BETWEEN 0 AND 1),
  margin            numeric(4, 3) NOT NULL DEFAULT 0.050 CHECK (margin BETWEEN 0 AND 1),
  is_experimental   boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model)
);

COMMENT ON TABLE speaker_id_thresholds IS 'M-03: 모델별 임계값. 미달 시 Unknown Speaker. 값은 실험값';
