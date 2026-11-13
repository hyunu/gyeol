# 검증 기록 (Phase 1)

- 최종 실행: 2026-11-14
- 명령: `npm run check` · `db:migrate` · `db:checks` · `test:db` · `web:build`
- 결과: **26 tests / pass 26 / fail 0**, DB **14 tests / pass 14 / fail 0**,
  계약 스키마 11 · 예제 17 · OpenAPI 유효, DB 마이그레이션(2건)·제약 검사 통과

## 1. 자동 검증 항목

| # | 검증 | 근거 파일 | 결과 |
| --- | --- | --- | --- |
| 1 | JSON Schema 11종 컴파일·`$id` 유일성 | `tools/validate-contracts.mjs` | 통과 |
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
| 18 | 비동기 분석: 등록→선점→성공, 활성 작업 멱등 | `tests/async-analysis.test.ts` | 통과 |
| 19 | 백오프 재시도(attempt 증가)와 한도 초과 실패 | 동일 | 통과 |
| 20 | 분석 타임아웃 → `failed`, 녹음 `analysis_failed` | 동일 | 통과 |
| 21 | 만료 임차 회수(attempt 증가), 타 사용자 작업 404 | 동일 | 통과 |
| 22 | API 백그라운드 워커가 등록 작업을 처리(HTTP 폴링) | 동일 | 통과 |

## 2. 통합 테스트가 실제로 확인한 것

- 폰 없이 기기에 2건이 쌓이고, 전송 중단 후 재개되어도 무손실이다.
- 업로드 중단 후 재개 시 오프셋이 맞고 최종 SHA-256 이 일치한다.
- **ACK 전에는 `deletable=false` 이고 DELETE 는 `409 RECORDING_NOT_DELETABLE`** 이다.
- ACK 후에만 폰 로컬 삭제가 가능하고, 서버 삭제 시 오브젝트가 실제로 제거된다.
- Unknown Speaker 는 `person` 행을 만들지 않는다(`people` 배열에 없음).
- 인물별 조회·키워드 검색·할 일 상태 변경이 동작한다.
- 실데이터 상태에서도 응답이 계약 스키마를 만족한다.

## 2.1 PostgreSQL 패리티 (2026-11-14)

`PostgresStore` 가 MemoryStore 와 같은 의미를 갖는지 실제 SQL 로 확인했다 (`tests/db`, 14건).

| # | 검증 | 결과 |
| --- | --- | --- |
| 18 | `ensureUser` 멱등 · 표시 이름 | 통과 |
| 19 | serial 중복 → `DEVICE_ALREADY_REGISTERED`, smallint 매핑 | 통과 |
| 20 | 멱등 키 중복 → `RECORDING_ALREADY_EXISTS`, bigint·기간 필터 | 통과 |
| 21 | 열린 업로드 세션 1개 · 만료 · 완료 세션 허용 | 통과 |
| 22 | 대화 상세 파생 데이터·사람·연결, Unknown 은 `people` 제외 | 통과 |
| 23 | 인물·기간·키워드(세그먼트 본문) 검색과 페이지 | 통과 |
| 24 | 재분석 교체(중복 없음) + 실패 시 트랜잭션 롤백 | 통과 |
| 25 | 할 일 상태 변경, 인물 조회 | 통과 |
| 26 | `GYEOL_STORE=postgres` API: `/healthz` db=ok + 계약 테스트 | 통과 |
| 27 | 전 구간(PostgreSQL): 업로드 재개→ACK→분석→검색→재분석→삭제 | 통과 |
| 28 | analysis_jobs 활성 작업 1개, 상태·attempt·시간 제약 | 통과 |
| 29 | 선점 원자성(SKIP LOCKED)과 미래 `available_at` 미선점 | 통과 |
| 30 | 임차 만료 회수, 한도 초과 시 실패 종료 | 통과 |
| 31 | 재시도 대기(queued+미래 시각) 후 재선점 | 통과 |

- `numeric` 이 문자열이 아닌 `number` 로, `int8` 이 `number` 로 매핑되는 것을 단언한다.
- 검색은 MemoryStore 와 같은 규칙(키워드 1.0 / 코사인 유사도, 임계값 0.35, 최신순)을 쓴다.

## 2.2 웹 대시보드 (W-16, 2026-11-14)

`apps/web` — React 19 + Vite. 화면 타입은 OpenAPI 계약에서 생성한다.

| 검증 | 근거 | 결과 |
| --- | --- | --- |
| 계약 타입 재생성 | `npm run web:api-types` → `src/api/schema.ts` | 통과 |
| 타입 검사 + 빌드 | `npm run web:build` (`tsc --noEmit` + `vite build`) | 통과 (21 modules) |
| 계약-타입 드리프트 | CI 에서 재생성 후 `git diff --exit-code` | 구성됨 |
| 레이아웃 | 1440 / 1024 / 900 / 390 px 렌더 확인 | 통과 |
| 대비 | `--ink-3` 를 5.1:1 로 조정 (한지 바탕) | 통과 |
| 키보드/보조기기 | skip link, `:focus-visible`, 검색 label, `aria-pressed`·`aria-current`, 상태 `role="status|alert"` | 확인 |
| 터치 | 입력·버튼·인물 칩 최소 44px | 확인 |
| 모션 | `prefers-reduced-motion` 에서 스켈레톤 정지, `prefers-reduced-transparency` 에서 그레인 제거 | 확인 |

구현한 상태: 첫 로딩 스켈레톤 · 기존 목록 유지 갱신 · 첫 사용 빈 상태 · 검색 결과 없음 · 오류+재시도 ·
상세 미선택/로딩/오류 · `partial` 대화 안내 · 할 일 낙관적 갱신/실패 롤백.
필터·선택은 URL(`q`, `person`, `id`)에 반영된다.

> 브라우저 E2E 자동화는 아직 없다. W-17 에서 날짜·인물·키워드 검색 시나리오로 추가한다.
> 그때까지 R-024 는 `WIP` 로 둔다.

## 3. ENV-PENDING (완료로 표시하지 않음)

| ID | 항목 | 사유 | 검증 방법(준비됨) |
| --- | --- | --- | --- |
| ENV-01 | `0001_init.sql` 실제 적용 | — | **해소 (2026-11-14)** — 14 테이블·확장 2종 적용 확인 |
| ENV-02 | PostgreSQL `Store` 어댑터 | — | **해소 (2026-11-14)** — `PostgresStore` + `tests/db` 14건 통과 |
| ENV-03 | 실물 웨어러블(VAD·PDM·microSD·BLE) | 하드웨어 미확보 | 펌웨어 테스트 + `HW-PENDING` 절차 |
| ENV-04 | iOS CoreBluetooth/AVFoundation 실연동 | 기기·앱 미개발 | 실기기 시나리오 |
| ENV-05 | 실제 STT/화자분리/요약 provider | D-05 등 미확정 | provider 어댑터 계약 테스트 |
| ENV-06 | 한국어 전문검색 토크나이저(D-07) | 미확정 | 검색 품질 측정 |
| ENV-07 | pgvector 인덱스(HNSW) 튜닝 | 차원 미확정(D-05) | 부하 테스트 |

## 3.1 DB 검증 결과 (2026-11-14)

Docker(pgvector/pgvector:pg17) 기동 후 빈 DB 에 `0001_init.sql` 을 적용했다.

| 항목 | 결과 |
| --- | --- |
| 마이그레이션 | `✔ 0001_init.sql`, `✔ 0002_analysis_jobs.sql` (2건, `schema_migrations` 체크섬 기록) |
| 테이블 | 15 + `schema_migrations` |
| 확장 | `citext` 1.6, `vector` 0.8.7 |
| 인덱스 / CHECK / FK | 47 / 51 / 23 |
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
DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run test:db
```

> `npm run test:db` 는 `tests/db/` 가 비어 있으면 **실패**한다(0 tests 거짓 통과 방지).
