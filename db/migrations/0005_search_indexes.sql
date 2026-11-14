-- 0005_search_indexes.sql
-- 검색 성능 인덱스 (D-07, W-28).
--
-- 키워드: pg_trgm GIN 으로 ILIKE 부분 일치 후보를 먼저 줄인다.
-- 의미: pgvector HNSW 로 top-K 후보만 가져와 키워드 결과와 합친다.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX conversations_title_trgm_idx
  ON conversations USING gin (title gin_trgm_ops);
CREATE INDEX conversations_summary_trgm_idx
  ON conversations USING gin (summary gin_trgm_ops);
CREATE INDEX transcript_segments_text_trgm_idx
  ON transcript_segments USING gin (text gin_trgm_ops);

CREATE INDEX conversation_embeddings_hnsw_idx
  ON conversation_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

COMMENT ON INDEX conversation_embeddings_hnsw_idx IS
  'D-05 768차원 코사인 HNSW. 검색은 top-K 후보만 사용한다.';
