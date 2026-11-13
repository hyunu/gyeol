-- analysis_jobs(0002) 제약 실동작 검증
-- 실행: npm run db:checks  (러너가 BEGIN … ROLLBACK 으로 감싼다)

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
  ('01990000-0000-7000-8000-00000000a0a1', '작업 검사 사용자');

INSERT INTO devices (id, user_id, serial_no, model) VALUES
  ('01990000-0000-7000-8000-00000000b0b1',
   '01990000-0000-7000-8000-00000000a0a1',
   'GYL-JOB-CHECK-1', 'xiao-nrf52840-sense');

INSERT INTO recordings (
  id, user_id, device_id, client_recording_id, started_at, ended_at,
  duration_ms, codec, sample_rate_hz, channels, byte_size, sha256
) VALUES
  ('01990000-0000-7000-8000-00000000c0c1',
   '01990000-0000-7000-8000-00000000a0a1',
   '01990000-0000-7000-8000-00000000b0b1',
   'jobcheck:1', now(), now() + interval '10 seconds',
   10000, 'wav_pcm_s16le', 16000, 1, 1024, repeat('a', 64));

INSERT INTO analysis_jobs (id, user_id, recording_id) VALUES
  ('01990000-0000-7000-8000-00000000d0d1',
   '01990000-0000-7000-8000-00000000a0a1',
   '01990000-0000-7000-8000-00000000c0c1');

-- ------------------------------------------------------------ CHECK 제약
SELECT pg_temp.expect_error(
  $q$ INSERT INTO analysis_jobs (id, user_id, recording_id, status)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000a0a1',
        '01990000-0000-7000-8000-00000000c0c1', 'pending') $q$,
  '23514', 'analysis_jobs.status 허용값');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO analysis_jobs (id, user_id, recording_id, attempt, max_attempts)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000a0a1',
        '01990000-0000-7000-8000-00000000c0c1', 4, 3) $q$,
  '23514', 'analysis_jobs.attempt <= max_attempts');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO analysis_jobs (id, user_id, recording_id, max_attempts)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000a0a1',
        '01990000-0000-7000-8000-00000000c0c1', 0) $q$,
  '23514', 'analysis_jobs.max_attempts 범위');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO analysis_jobs (id, user_id, recording_id, timeout_ms)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000a0a1',
        '01990000-0000-7000-8000-00000000c0c1', 10) $q$,
  '23514', 'analysis_jobs.timeout_ms 하한');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO analysis_jobs (id, user_id, recording_id, status)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000a0a1',
        '01990000-0000-7000-8000-00000000c0c1', 'succeeded') $q$,
  '23514', '완료 작업은 finished_at 필수');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO analysis_jobs (id, user_id, recording_id, status, started_at)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000a0a1',
        '01990000-0000-7000-8000-00000000c0c1', 'running', now()) $q$,
  '23514', 'running 은 lease_expires_at 필수');

SELECT pg_temp.expect_error(
  $q$ UPDATE analysis_jobs SET status = 'queued', finished_at = now()
      WHERE id = '01990000-0000-7000-8000-00000000d0d1' $q$,
  '23514', 'queued 는 finished_at 을 가질 수 없다');

-- ------------------------------------------------------------- FK 제약
SELECT pg_temp.expect_error(
  $q$ INSERT INTO analysis_jobs (id, user_id, recording_id)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000a0a1',
        gen_random_uuid()) $q$,
  '23503', 'analysis_jobs.recording_id FK');

-- ---------------------------------------------- 활성 작업 유니크(부분 인덱스)
SELECT pg_temp.expect_error(
  $q$ INSERT INTO analysis_jobs (id, user_id, recording_id)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000a0a1',
        '01990000-0000-7000-8000-00000000c0c1') $q$,
  '23505', '녹음당 활성 작업 1개');

-- 이전 작업이 끝나면 새 작업을 만들 수 있다(과잉 제약 아님).
UPDATE analysis_jobs
SET status = 'failed', finished_at = now(), updated_at = now()
WHERE id = '01990000-0000-7000-8000-00000000d0d1';

INSERT INTO analysis_jobs (id, user_id, recording_id) VALUES
  ('01990000-0000-7000-8000-00000000d0d2',
   '01990000-0000-7000-8000-00000000a0a1',
   '01990000-0000-7000-8000-00000000c0c1');

-- --------------------------------------------------- 인덱스 술어 확인
DO $$
DECLARE
  def text;
BEGIN
  SELECT indexdef INTO def
  FROM pg_indexes
  WHERE schemaname = 'public' AND indexname = 'analysis_jobs_active_uk';

  IF def IS NULL THEN
    RAISE EXCEPTION 'CHECK FAILED: analysis_jobs_active_uk 인덱스가 없다'
      USING ERRCODE = 'P0001';
  END IF;
  IF def NOT LIKE '%UNIQUE%' OR def NOT LIKE '%WHERE%' THEN
    RAISE EXCEPTION 'CHECK FAILED: analysis_jobs_active_uk 가 부분 유니크가 아니다: %', def
      USING ERRCODE = 'P0001';
  END IF;
END $$;
