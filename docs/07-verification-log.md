# 검증 기록 (Phase 1)

- 최종 실행: 2026-11-14
- 명령: `npm run check` · `db:migrate` · `db:checks`
- 결과: **17 tests / pass 17 / fail 0**, 계약 스키마 10 · 예제 15 · OpenAPI 유효,
  DB 마이그레이션 적용 및 제약 검사 통과

## 1. 자동 검증 항목

| # | 검증 | 근거 파일 | 결과 |
| --- | --- | --- | --- |
| 1 | JSON Schema 10종 컴파일·`$id` 유일성 | `tools/validate-contracts.mjs` | 통과 |
| 2 | 모든 스키마에 valid 예제 존재 | 동일 | 통과 |
| 3 | valid 예제가 스키마 통과 / invalid 예제가 실패 | 동일 | 통과 |
| 4 | OpenAPI 3.1 유효 + `$ref` 해석 | 동일 | 통과 |
| 5 | 실행 중 API 응답이 OpenAPI 스키마와 일치 | `tools/contract-test.mjs` | 통과 |
| 6 | Recording 상태 전이표(금지 전이 거부) | `tests/unit/domain.test.ts` | 통과 |
| 7 | M-04 삭제 5조건 판정 | 동일 | 통과 |
| 8 | 무결성(크기+해시) 비교 | 동일 | 통과 |
| 9 | M-03 임계값/격차 미달 → Unknown | 동일 | 통과 |
| 10 | 기기 online 파생(TTL) | 동일 | 통과 |
| 11 | ActionItem 전이 | 동일 | 통과 |
| 12 | 기기→BLE(중단/재개)→업로드(중단/재개)→검증→ACK→분석→검색 | `tests/integration.test.ts` | 통과 |
| 13 | 세션 만료가 Recording 삭제가 아님 + 새 세션 재전송 | 동일 | 통과 |
| 14 | 무결성 불일치 시 stored 금지·바이트 미보관·분석 거부 | 동일 | 통과 |
| 15 | 운영 환경에서 `X-User-Id` 차단(fail-closed) | 동일 | 통과 |
| 16 | 알 수 없는 필드 거부 | 동일 | 통과 |
| 17 | 재분석 시 파생 데이터 교체(중복 누적 없음) | 동일 | 통과 |

## 2. 통합 테스트가 실제로 확인한 것

- 폰 없이 기기에 2건이 쌓이고, 전송 중단 후 재개되어도 무손실이다.
- 업로드 중단 후 재개 시 오프셋이 맞고 최종 SHA-256 이 일치한다.
- **ACK 전에는 `deletable=false` 이고 DELETE 는 `409 RECORDING_NOT_DELETABLE`** 이다.
- ACK 후에만 폰 로컬 삭제가 가능하고, 서버 삭제 시 오브젝트가 실제로 제거된다.
- Unknown Speaker 는 `person` 행을 만들지 않는다(`people` 배열에 없음).
- 인물별 조회·키워드 검색·할 일 상태 변경이 동작한다.
- 실데이터 상태에서도 응답이 계약 스키마를 만족한다.

## 3. ENV-PENDING (완료로 표시하지 않음)

| ID | 항목 | 사유 | 검증 방법(준비됨) |
| --- | --- | --- | --- |
| ENV-01 | `0001_init.sql` 실제 적용 | — | **해소 (2026-11-14)** — 14 테이블·확장 2종 적용 확인 |
| ENV-02 | PostgreSQL `Store` 어댑터 | W-07 미구현 | `npm run test:db` (W-08) |
| ENV-03 | 실물 웨어러블(VAD·PDM·microSD·BLE) | 하드웨어 미확보 | 펌웨어 테스트 + `HW-PENDING` 절차 |
| ENV-04 | iOS CoreBluetooth/AVFoundation 실연동 | 기기·앱 미개발 | 실기기 시나리오 |
| ENV-05 | 실제 STT/화자분리/요약 provider | D-05 등 미확정 | provider 어댑터 계약 테스트 |
| ENV-06 | 한국어 전문검색 토크나이저(D-07) | 미확정 | 검색 품질 측정 |
| ENV-07 | pgvector 인덱스(HNSW) 튜닝 | 차원 미확정(D-05) | 부하 테스트 |

## 3.1 DB 검증 결과 (2026-11-14)

Docker(pgvector/pgvector:pg17) 기동 후 빈 DB 에 `0001_init.sql` 을 적용했다.

| 항목 | 결과 |
| --- | --- |
| 마이그레이션 | `✔ 0001_init.sql` (1건, `schema_migrations` 체크섬 기록) |
| 테이블 | 14 + `schema_migrations` |
| 확장 | `citext` 1.6, `vector` 0.8.7 |
| 인덱스 / CHECK / FK | 42 / 44 / 20 |
| 제약 실동작 | `npm run db:checks` 통과 (CHECK·FK·UNIQUE·부분 인덱스·vector 차원) |

```bash
make db-up
DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run db:migrate
DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run db:checks
```

## 4. 테스트 실행 방법

```bash
npm run check            # 계약 + 타입 + 단위/통합
npm start                # API (메모리 저장소)
npm run contract-test    # 실행 중 서버를 OpenAPI 와 대조

# DB (Docker 필요)
make db-up
DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run db:migrate
DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run db:checks
DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run test:db   # W-08 이후 의미
```

> `npm run test:db` 는 `tests/db/` 가 비어 있으면 **실패**한다(0 tests 거짓 통과 방지).
> 현재는 PostgreSQL `Store` 어댑터(W-07)가 없어 의도적으로 실패한다.
