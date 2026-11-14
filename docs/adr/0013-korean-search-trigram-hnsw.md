# ADR 0013 — 한국어 검색은 trigram 키워드 + HNSW 의미 후보로 한다

- 상태: **채택** (D-07, 2026-11-14)
- 관련: W-28, `0005_search_indexes.sql`, `PostgresStore.listConversations`
- 이전: D-07 제안 `simple + 키워드 배열`

## 맥락

10,000건 측정에서 검색 p95가 458ms로 잠정 목표(250ms)를 넘었다. 원인은 키워드
후보를 먼저 줄이지 않고 **모든 대화의 점수(임베딩 코사인 포함)를 계산한 뒤**
`WHERE score >= 0.35`를 적용한 쿼리 구조였다. trigram 인덱스만 추가해도 1건 일치
검색이 316ms로 개선이 제한적이었다.

## 결정

1. **키워드 경로**: `pg_trgm` GIN 인덱스로 `title`·`summary`·`transcript_segments.text`의
   `ILIKE '%q%'` 후보를 먼저 좁힌다. 한국어 형태소 분석기 없이도 부분 문자열 검색이 된다.
2. **의미 경로**: `conversation_embeddings`에 **HNSW(cosine)** 인덱스를 두고
   `ORDER BY embedding <=> $vec LIMIT k` 로 top-K 후보만 가져온다. `k = max(200, size×10)`.
3. **결합**: 두 후보를 `UNION ALL` 후 대화별 최대 점수(`GREATEST`/`max`)로 합치고
   `score >= 0.35` 필터·페이지를 적용한다.
4. **키워드 점수는 1.0**, 의미 점수는 `1 - cosine_distance` 다. 키워드 일치가 우선한다.
5. **형태소 분석·동의어 사전은 MVP 범위 밖**이다. 필요해지면 `tsvector`/한국어 토크나이저를
   추가 ADR 로 도입한다.

## 인덱스

```sql
CREATE EXTENSION pg_trgm;
CREATE INDEX ... USING gin (title gin_trgm_ops);          -- conversations
CREATE INDEX ... USING gin (summary gin_trgm_ops);
CREATE INDEX ... USING gin (text gin_trgm_ops);           -- transcript_segments
CREATE INDEX ... ON conversation_embeddings
  USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
```

## 결과 (10,000건, 동시성 20, Fake AI)

| 시나리오 | 이전 p95 | 이후 p95 | RPS |
| --- | ---: | ---: | ---: |
| 키워드 검색(광범위, 전부 일치) | 457.7ms | **175.2ms** | 154 |
| 키워드 검색(1건 일치) | 315.9ms | **176.9ms** | 163 |
| 대화 목록 | 51.0ms | 40.7ms | 630 |

- 검색 p95가 잠정 목표(250ms) 안으로 들어왔다.
- HNSW `ef_search` 기본값(40)에서 측정했다. top-K 200의 재현율을 높이려면
  `hnsw.ef_search` 를 올려야 하며, 지연과 trade-off 다.
- 2글자 이하 키워드는 trigram 인덱스를 타지 못해 순차 검색이 될 수 있다.
- 실제 AI provider 임베딩·한국어 음성 데이터로 재측정해야 한다(ENV-05).

## 남은 일

- `hnsw.ef_search` 튜닝과 재현율 측정 (W-28).
- 형태소/동의어가 필요한지 사용자 검색 로그로 판단 (D-07 후속).
- 2글자 검색 대응(부분 trigram 또는 별도 인덱스).
