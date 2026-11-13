-- sessions(0003) 제약 실동작 검증

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

INSERT INTO users (id, display_name) VALUES
  ('01990000-0000-7000-8000-00000000e0e1', '세션 검사 사용자');

INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES
  ('01990000-0000-7000-8000-00000000f0f1',
   '01990000-0000-7000-8000-00000000e0e1',
   repeat('a', 64), now() + interval '30 days');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000e0e1', 'ZZZ', now() + interval '1 day') $q$,
  '23514', 'sessions.token_hash 형식');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000e0e1', repeat('b', 64), now() - interval '1 day') $q$,
  '23514', 'sessions.expires_at > created_at');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (gen_random_uuid(), '01990000-0000-7000-8000-00000000e0e1', repeat('a', 64), now() + interval '1 day') $q$,
  '23505', 'sessions.token_hash 중복');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO sessions (id, user_id, token_hash, expires_at)
      VALUES (gen_random_uuid(), gen_random_uuid(), repeat('c', 64), now() + interval '1 day') $q$,
  '23503', 'sessions.user_id FK');

-- 사용자 삭제는 세션을 함께 지운다(CASCADE).
DELETE FROM users WHERE id = '01990000-0000-7000-8000-00000000e0e1';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sessions WHERE user_id = '01990000-0000-7000-8000-00000000e0e1') THEN
    RAISE EXCEPTION 'CHECK FAILED: 사용자 삭제 후 세션이 남아 있다' USING ERRCODE = 'P0001';
  END IF;
END $$;
