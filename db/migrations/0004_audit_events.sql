-- 0004_audit_events.sql
-- 삭제·내보내기 감사 로그 (W-25, ADR-0011).
--
-- 감사 행은 사용자 삭제 후에도 남긴다(user_id SET NULL). metadata 에 대상 id 를 보존한다.

CREATE TABLE audit_events (
  id             uuid PRIMARY KEY,
  user_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  action         text NOT NULL
                 CHECK (action IN ('export', 'account_delete_requested', 'account_purged', 'recording_purged')),
  resource_type  text NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 60),
  resource_id    text,
  trace_id       text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_user_idx ON audit_events (user_id, created_at DESC);
CREATE INDEX audit_events_action_idx ON audit_events (action, created_at DESC);

COMMENT ON TABLE audit_events IS
  '삭제·내보내기 감사. 사용자 삭제 후에도 남기기 위해 user_id 는 SET NULL.';
COMMENT ON COLUMN audit_events.metadata IS
  '민감 내용(대화 본문·파일 경로) 대신 대상 id·건수·정책만 기록한다.';
