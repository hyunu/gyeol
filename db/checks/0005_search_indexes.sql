-- 0005 검색 인덱스 존재·정의 검증

DO $$
DECLARE
  missing text[];
  ext_count integer;
BEGIN
  SELECT count(*) INTO ext_count FROM pg_extension WHERE extname = 'pg_trgm';
  IF ext_count <> 1 THEN
    RAISE EXCEPTION 'CHECK FAILED: pg_trgm 확장이 없다' USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(name) INTO missing
  FROM (VALUES
    ('conversations_title_trgm_idx'),
    ('conversations_summary_trgm_idx'),
    ('transcript_segments_text_trgm_idx'),
    ('conversation_embeddings_hnsw_idx')
  ) AS expected(name)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = expected.name
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'CHECK FAILED: 누락 인덱스 %', missing USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'conversation_embeddings_hnsw_idx'
      AND indexdef LIKE '%USING hnsw%'
  ) THEN
    RAISE EXCEPTION 'CHECK FAILED: HNSW 인덱스 정의가 다르다' USING ERRCODE = 'P0001';
  END IF;
END $$;
