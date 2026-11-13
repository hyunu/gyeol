-- 0002_analysis_jobs.sql
-- 비동기 분석 작업 큐 (ADR-0007). ADR-0004(동기 분석)를 대체한다.
--
-- 불변식
--   1. 녹음당 활성(queued|running) 작업은 최대 1개  → analysis_jobs_active_uk
--   2. running 은 started_at·lease_expires_at 을 가진다 → analysis_jobs_running_chk
--   3. succeeded|failed 는 finished_at 을 가진다        → analysis_jobs_finished_chk
--   4. attempt 는 클레임 횟수이며 max_attempts 를 넘겨 실행하지 않는다(애플리케이션 + CHECK)

CREATE TABLE analysis_jobs (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  recording_id      uuid NOT NULL REFERENCES recordings (id) ON DELETE RESTRICT,
  status            text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempt           integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts      integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  timeout_ms        integer NOT NULL DEFAULT 300000 CHECK (timeout_ms BETWEEN 1000 AND 3600000),
  available_at      timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  lease_expires_at  timestamptz,
  conversation_id   uuid REFERENCES conversations (id) ON DELETE SET NULL,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_jobs_finished_chk
    CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT analysis_jobs_running_chk
    CHECK (status <> 'running' OR (started_at IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CONSTRAINT analysis_jobs_attempt_chk CHECK (attempt <= max_attempts)
);

-- 활성 작업은 녹음당 1개. 재분석은 이전 작업이 끝난 뒤 새 작업으로 만든다.
CREATE UNIQUE INDEX analysis_jobs_active_uk
  ON analysis_jobs (recording_id)
  WHERE status IN ('queued', 'running');

-- 워커 선점: 실행 가능한 작업을 오래된 순서로 찾는다.
CREATE INDEX analysis_jobs_claim_idx ON analysis_jobs (available_at) WHERE status = 'queued';

-- 만료 임차 회수 스캔.
CREATE INDEX analysis_jobs_lease_idx ON analysis_jobs (lease_expires_at) WHERE status = 'running';

-- 사용자별 작업 이력(디버깅·관측).
CREATE INDEX analysis_jobs_user_idx ON analysis_jobs (user_id, created_at DESC);

COMMENT ON TABLE analysis_jobs IS
  'ADR-0007. POST /recordings/{id}/analyze 는 작업을 만들고 202 로 돌아간다. 워커가 claim 한다.';
COMMENT ON COLUMN analysis_jobs.attempt IS '클레임 횟수. attempt < max_attempts 이면 재시도 여지가 있다.';
COMMENT ON COLUMN analysis_jobs.lease_expires_at IS '워커 생존 임차. 지나면 다른 워커가 회수한다.';
