-- 0003_sessions.sql
-- 서버 세션 (ADR-0010). Apple identity token 검증 후 발급하는 불투명 토큰.
--
-- 불변식
--   1. token_hash 는 SHA-256 hex 이며 유일하다.
--   2. expires_at > created_at.
--   3. revoked_at 이 있으면 더 이상 인증에 쓸 수 없다(행은 감사용으로 남긴다).

CREATE TABLE sessions (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  user_agent    text,
  CONSTRAINT sessions_expiry_chk CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE sessions IS
  'ADR-0010. 토큰 원문은 저장하지 않는다. 서버는 SHA-256 해시로만 조회한다.';
COMMENT ON COLUMN sessions.token_hash IS 'Bearer/쿠키 토큰의 SHA-256 hex';
COMMENT ON COLUMN sessions.expires_at IS '절대 만료(30일). 갱신하지 않는다.';

COMMENT ON COLUMN users.auth_subject IS
  'ADR-0010. Apple identity token 의 sub → apple:<sub>. UNIQUE.';
