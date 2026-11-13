-- DB 제약·인덱스 실동작 검증
--
-- 목적: 0001_init.sql 이 만든 CHECK/FK/UNIQUE/부분 인덱스가 실제 PostgreSQL 에서
--       "위반을 거부"하는지 확인한다. 스키마를 읽는 것만으로는 부족하다.
--
-- 실행: npm run db:checks   (스크립트가 BEGIN … ROLLBACK 으로 감싼다)
-- 규칙: 모든 검사는 예외로 실패해야 한다. 기대한 SQLSTATE 가 아니면 실패로 본다.

-- ---------------------------------------------------------------- helper
CREATE FUNCTION pg_temp.expect_error(stmt text, expected_state text, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE EXCEPTION 'CHECK FAILED: % — 위반이 거부되지 않았다', label
      USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0001' THEN
        RAISE;
      END IF;
      IF SQLSTATE <> expected_state THEN
        RAISE EXCEPTION 'CHECK FAILED: % — 기대 SQLSTATE %, 실제 % (%)',
          label, expected_state, SQLSTATE, SQLERRM
          USING ERRCODE = 'P0001';
      END IF;
  END;
END $$;

-- -------------------------------------------------------------- fixtures
INSERT INTO users (id, display_name) VALUES
  ('01990000-0000-7000-8000-0000000000a1', '검사 사용자 A'),
  ('01990000-0000-7000-8000-0000000000a2', '검사 사용자 B');

INSERT INTO devices (id, user_id, serial_no, model) VALUES
  ('01990000-0000-7000-8000-0000000000b1',
   '01990000-0000-7000-8000-0000000000a1',
   'GYL-CHECK-0001', 'xiao-nrf52840-sense');

INSERT INTO recordings (
  id, user_id, device_id, client_recording_id, started_at, ended_at,
  duration_ms, codec, sample_rate_hz, channels, byte_size, sha256
) VALUES (
  '01990000-0000-7000-8000-0000000000c1',
  '01990000-0000-7000-8000-0000000000a1',
  '01990000-0000-7000-8000-0000000000b1',
  'check:0001', now(), now() + interval '10 seconds',
  10000, 'wav_pcm_s16le', 16000, 1, 1024, repeat('a', 64)
);

INSERT INTO conversations (id, user_id, started_at, ended_at) VALUES
  ('01990000-0000-7000-8000-0000000000d1',
   '01990000-0000-7000-8000-0000000000a1',
   now(), now() + interval '10 seconds');

INSERT INTO persons (id, user_id, display_name) VALUES
  ('01990000-0000-7000-8000-0000000000e1',
   '01990000-0000-7000-8000-0000000000a1', '검사 인물');

INSERT INTO speaker_clusters (id, conversation_id, label) VALUES
  ('01990000-0000-7000-8000-0000000000f3',
   '01990000-0000-7000-8000-0000000000d1', 'S2');

-- ------------------------------------------------------------ CHECK 제약
SELECT pg_temp.expect_error(
  $q$ INSERT INTO users (id, display_name) VALUES (gen_random_uuid(), '') $q$,
  '23514', 'users.display_name 빈 문자열');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO devices (id, user_id, serial_no, model, battery_pct)
      VALUES (gen_random_uuid(), NULL, 'GYL-CHECK-0002', 'm', 101) $q$,
  '23514', 'devices.battery_pct 범위');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO recordings (id, user_id, device_id, client_recording_id,
        started_at, ended_at, duration_ms, codec, sample_rate_hz, channels, byte_size, sha256)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-0000000000a1',
        '01990000-0000-7000-8000-0000000000b1', 'check:bad-duration',
        now(), now() + interval '1 second', 0, 'wav_pcm_s16le', 16000, 1, 1, repeat('a', 64)) $q$,
  '23514', 'recordings.duration_ms > 0');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO recordings (id, user_id, device_id, client_recording_id,
        started_at, ended_at, duration_ms, codec, sample_rate_hz, channels, byte_size, sha256)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-0000000000a1',
        '01990000-0000-7000-8000-0000000000b1', 'check:bad-sha',
        now(), now() + interval '1 second', 1000, 'wav_pcm_s16le', 16000, 1, 1, 'ZZZ') $q$,
  '23514', 'recordings.sha256 형식');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO recordings (id, user_id, device_id, client_recording_id,
        started_at, ended_at, duration_ms, codec, sample_rate_hz, channels, byte_size, sha256)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-0000000000a1',
        '01990000-0000-7000-8000-0000000000b1', 'check:time-window',
        now(), now(), 1, 'wav_pcm_s16le', 16000, 1, 1, repeat('b', 64)) $q$,
  '23514', 'recordings.ended_at > started_at');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO speaker_clusters (id, conversation_id, label, identification_status)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-0000000000d1', 'S1', 'confirmed') $q$,
  '23514', 'speaker_clusters 확정 화자는 person_id 필수');

SELECT pg_temp.expect_error(
  $q$ UPDATE persons SET merged_into_person_id = id
      WHERE id = '01990000-0000-7000-8000-0000000000e1' $q$,
  '23514', 'persons 자기 병합 금지');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO transcript_segments (id, conversation_id, seq, start_ms, end_ms, text)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-0000000000d1', 0, 100, 100, 'x') $q$,
  '23514', 'transcript_segments.end_ms > start_ms');

-- ------------------------------------------------------------- FK 제약
SELECT pg_temp.expect_error(
  $q$ INSERT INTO recordings (id, user_id, device_id, client_recording_id,
        started_at, ended_at, duration_ms, codec, sample_rate_hz, channels, byte_size, sha256)
      VALUES (gen_random_uuid(), gen_random_uuid(),
        '01990000-0000-7000-8000-0000000000b1', 'check:missing-user',
        now(), now() + interval '1 second', 1, 'wav_pcm_s16le', 16000, 1, 1, repeat('c', 64)) $q$,
  '23503', 'recordings.user_id FK');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO conversations (id, user_id, started_at, ended_at)
      VALUES (gen_random_uuid(), gen_random_uuid(), now(), now() + interval '1 second') $q$,
  '23503', 'conversations.user_id FK');

-- --------------------------------------------------------- UNIQUE 제약
SELECT pg_temp.expect_error(
  $q$ INSERT INTO recordings (id, user_id, device_id, client_recording_id,
        started_at, ended_at, duration_ms, codec, sample_rate_hz, channels, byte_size, sha256)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-0000000000a1',
        '01990000-0000-7000-8000-0000000000b1', 'check:0001',
        now(), now() + interval '1 second', 1, 'wav_pcm_s16le', 16000, 1, 1, repeat('d', 64)) $q$,
  '23505', 'recordings (device_id, client_recording_id) 중복');

-- -------------------------------------------- 부분 유니크 인덱스(open 세션)
INSERT INTO upload_sessions (id, recording_id, expected_bytes, expected_sha256,
  chunk_size_bytes, expires_at)
VALUES ('01990000-0000-7000-8000-0000000000f1', '01990000-0000-7000-8000-0000000000c1',
  1024, repeat('a', 64), 262144, now() + interval '1 day');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO upload_sessions (id, recording_id, expected_bytes, expected_sha256,
        chunk_size_bytes, expires_at)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-0000000000c1',
        1024, repeat('a', 64), 262144, now() + interval '1 day') $q$,
  '23505', 'upload_sessions 열린 세션은 녹음당 1개');

-- 부분 인덱스는 open 이외 상태를 막지 않는다(과잉 제약 아님).
INSERT INTO upload_sessions (id, recording_id, status, expected_bytes, expected_sha256,
  chunk_size_bytes, expires_at, completed_at)
VALUES ('01990000-0000-7000-8000-0000000000f2', '01990000-0000-7000-8000-0000000000c1',
  'completed', 1024, repeat('a', 64), 262144, now() + interval '1 day', now());

SELECT pg_temp.expect_error(
  $q$ UPDATE upload_sessions SET received_bytes = expected_bytes + 1
      WHERE id = '01990000-0000-7000-8000-0000000000f1' $q$,
  '23514', 'upload_sessions.received_bytes <= expected_bytes');

-- ------------------------------------------------------- pgvector 차원
SELECT pg_temp.expect_error(
  $q$ INSERT INTO speaker_embeddings (id, speaker_cluster_id, dim, embedding)
      VALUES (gen_random_uuid(),
        '01990000-0000-7000-8000-0000000000f3',
        768, array_fill(0.1::real, ARRAY[768])::vector) $q$,
  '22000', 'speaker_embeddings vector(256) 차원');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO conversation_embeddings (conversation_id, dim, embedding)
      VALUES ('01990000-0000-7000-8000-0000000000d1', 256,
        array_fill(0.1::real, ARRAY[256])::vector) $q$,
  '22000', 'conversation_embeddings vector(768) 차원');

-- --------------------------------------------------- 인덱스 술어 확인
DO $$
DECLARE
  predicate text;
BEGIN
  SELECT indexdef INTO predicate
  FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'upload_sessions_open_uk';

  IF predicate IS NULL THEN
    RAISE EXCEPTION 'CHECK FAILED: upload_sessions_open_uk 인덱스가 없다'
      USING ERRCODE = 'P0001';
  END IF;
  IF predicate NOT LIKE '%WHERE (status = ''open''::text)%' THEN
    RAISE EXCEPTION 'CHECK FAILED: upload_sessions_open_uk 부분 인덱스 술어가 다르다: %', predicate
      USING ERRCODE = 'P0001';
  END IF;
END $$;
