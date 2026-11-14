-- audit_events(0004) 제약 실동작 검증

CREATE FUNCTION pg_temp.expect_error(stmt text, expected_state text, label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE EXCEPTION 'CHECK FAILED: % — 위반이 거부되지 않았다', label USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = 'P0001' THEN RAISE; END IF;
      IF SQLSTATE <> expected_state THEN
        RAISE EXCEPTION 'CHECK FAILED: % — 기대 SQLSTATE %, 실제 % (%)',
          label, expected_state, SQLSTATE, SQLERRM USING ERRCODE = 'P0001';
      END IF;
  END;
END $$;

INSERT INTO users (id, display_name) VALUES
  ('01990000-0000-7000-8000-0000000a0a01', '감사 검사 사용자');

INSERT INTO audit_events (id, user_id, action, resource_type, resource_id)
VALUES ('01990000-0000-7000-8000-0000000b0b01',
        '01990000-0000-7000-8000-0000000a0a01', 'export', 'user', '01990000-0000-7000-8000-0000000a0a01');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO audit_events (id, action, resource_type)
      VALUES (gen_random_uuid(), 'delete_everything', 'user') $q$,
  '23514', 'audit_events.action 허용값');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO audit_events (id, action, resource_type)
      VALUES (gen_random_uuid(), 'export', '') $q$,
  '23514', 'audit_events.resource_type 빈 문자열');

SELECT pg_temp.expect_error(
  $q$ INSERT INTO audit_events (id, user_id, action, resource_type)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'export', 'user') $q$,
  '23503', 'audit_events.user_id FK');

-- 사용자 삭제 후에도 감사 행은 남고 user_id 만 NULL 이 된다.
DELETE FROM users WHERE id = '01990000-0000-7000-8000-0000000a0a01';
DO $$
DECLARE
  remaining integer;
  null_users integer;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE user_id IS NULL) INTO remaining, null_users
  FROM audit_events WHERE id = '01990000-0000-7000-8000-0000000b0b01';
  IF remaining <> 1 OR null_users <> 1 THEN
    RAISE EXCEPTION 'CHECK FAILED: 사용자 삭제 후 감사 행이 유지되지 않았다'
      USING ERRCODE = 'P0001';
  END IF;
END $$;
