# 검증 기록 (Phase 1)

- 최종 실행: 2026-11-14
- 명령: `npm run check` · `db:migrate` · `db:checks` · `test:db` · `test:s3` · `test:e2e` · `web:build`
- 결과: **53 tests / pass 53 / fail 0**, DB **20 / 20**, S3 **7 / 7**, E2E **6 / 6**, Swift **13 / 13**,
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
| 23 | 스토리지 선택 fail-closed (`GYEOL_STORAGE`) | `tests/storage.test.ts` | 통과 |

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

## 2.3 S3 오브젝트 스토리지 (W-14, 2026-11-14)

MinIO(`minio/minio:latest`, `127.0.0.1:9000`)에 대해 `S3Storage` 를 검증했다 (`tests/s3`, 7건).

| # | 검증 | 결과 |
| --- | --- | --- |
| 1 | 청크 순서 저장 → commit 크기·SHA-256 → read 일치 | 통과 |
| 2 | 오프셋 불일치 청크 거부(재개 규칙) | 통과 |
| 3 | abort 후 임시 청크 제거, commit 실패 | 통과 |
| 4 | 세션 재시작 시 이전 청크 폐기 | 통과 |
| 5 | 8 MiB 초과 업로드 multipart 이어붙임 | 통과 |
| 6 | 없는 객체 `exists=false` / `read` 실패 | 통과 |
| 7 | S3 로 전 구간: 업로드 재개→검증→ACK→분석 | 통과 |

```bash
make db-up
S3_ENDPOINT=http://127.0.0.1:9000 \
S3_ACCESS_KEY_ID=gyeol S3_SECRET_ACCESS_KEY=gyeol-minio \
npm run test:s3
```

- 버킷은 어댑터가 없으면 만든다(`S3_BUCKET`, 기본 `gyeol-test`).
- 커밋이 임시 객체를 읽어 다시 쓰므로 전송량이 2배다. 운영 규모의 대안은
  `docs/adr/0008-object-storage-s3.md` 에 기록했다.
- 서버는 `GYEOL_STORAGE=local|s3` 로 선택하며, 잘못된 값은 fail-closed 다.

## 2.4 관측성 (W-27, 2026-11-14)

| 검증 | 근거 | 결과 |
| --- | --- | --- |
| 요청마다 JSON 로그(traceId·method·path·status·durationMs·userId) | `tests/observability.test.ts` | 통과 |
| `X-Request-Id` 가 `X-Trace-Id` 로 왕복 | 동일 | 통과 |
| 검색어(쿼리 문자열)를 로그에 남기지 않음 | 동일 | 통과 |
| `/metrics` Prometheus 텍스트·요청/지연/프로세스 메트릭 | 동일 | 통과 |
| `/healthz` 에 `storage` 실제 연결 검사 추가 | 동일 | 통과 |
| 테스트 실행 중 로그 소음 제거(`NODE_TEST_CONTEXT`) | 동일 | 확인 |

문서: `docs/09-observability.md` (로그 스키마·메트릭·알림 최소 세트·조회 SQL).

## 2.5 백업/복구 리허설 (W-26, 2026-11-14)

| 단계 | 근거 | 결과 |
| --- | --- | --- |
| 논리 백업 | `npm run db:backup` (`pg_dump -Fc`) | 통과 (0.06 MiB) |
| 별도 DB 복구 | `npm run db:restore:rehearsal` (원본 무변경) | 통과 |
| 테이블·행 수 | 16/16 테이블, 전부 일치 | 통과 |
| 마이그레이션 체크섬 | `schema_migrations` 2건 일치 | 통과 |
| 확장 | `citext`·`vector` 일치 | 통과 |
| 소요 | 3.4s | 기록 |

문서: `docs/11-backup-restore.md` (운영 절차·한계·오브젝트 스토리지 별도 백업).

## 2.6 결정 반영 (2026-11-14)

코드 변경 없이 스키마·정책 기준을 확정했다. 근거는 ADR 이다.

| 결정 | 내용 | 근거 |
| --- | --- | --- |
| D-04 | 기기 `wav_ima_adpcm`, 테스트 기준 `wav_pcm_s16le` | ADR-0006 |
| D-05 | 화자 256 / 텍스트 768, 모델은 W-18 | ADR-0009 |
| D-01 | Apple 로그인 + 불투명 서버 세션(30일) | ADR-0010 |
| D-08·D-11 | 분석 종료 후 30일 원본 purge, 파생 유지 | ADR-0011 |
| D-13 | 저장 암호화(at-rest)+TLS만, 앱 필드 암호화는 PII 추가 시 재검토 | ADR-0011 |
| D-15 | 감사 로그는 W-25 최소 세트로 구현 | W-25 |

## 2.7 웹 E2E (W-17, 2026-11-14)

Playwright 로 실제 브라우저에서 검색·상세·모바일 전환을 검증했다 (`tests/e2e`, 6건).
`globalSetup` 이 메모리 API(8080)를 띄우고 고정 데이터 3건을 넣으며, Vite(5273)를 자동 기동한다.

| # | 시나리오 | 결과 |
| --- | --- | --- |
| 1 | 날짜별 타임라인 3건·날짜 그룹 3개 | 통과 |
| 2 | 키워드 검색 → 1건, 결과 없음 → 필터 지우기 | 통과 |
| 3 | 인물 필터·해제, URL 반영 | 통과 |
| 4 | 상세 요약·대화·할 일, 토글 후 새로고침 유지 | 통과 |
| 5 | 상세 URL 딥링크 | 통과 |
| 6 | 모바일(390px): 목록↔상세, 목록으로 | 통과 |

> 로컬 Vite(5173)와 충돌하지 않도록 E2E 는 5273 을 쓰고 기존 서버를 재사용하지 않는다.

## 2.8 Apple 세션 인증 (W-19 서버, 2026-11-14)

| # | 검증 | 근거 | 결과 |
| --- | --- | --- | --- |
| 1 | Apple 로그인 → 세션 발급, Bearer 접근, 같은 sub 는 같은 사용자 | `tests/auth.test.ts` | 통과 |
| 2 | 토큰 원문 미저장(해시만), 로그인마다 새 세션 | 동일 | 통과 |
| 3 | 쿠키(`gyeol_session`) 인증, 로그아웃 후 즉시 401 | 동일 | 통과 |
| 4 | 30일 만료, 잘못된 토큰 fail-closed(로컬 헤더로 미전환) | 동일 | 통과 |
| 5 | Apple 검증 실패 401 / 검증기 미설정 503 | 동일 | 통과 |
| 6 | 타 사용자의 기기·녹음·대화·할 일·분석 작업 404 | 동일 | 통과 |
| 7 | 로컬 `X-User-Id` 유지 | 동일 | 통과 |
| 8 | DB: auth_subject upsert, 세션 생명주기, token_hash 중복 거부 | `tests/db/auth.test.ts` | 통과 |
| 9 | DB 제약: token_hash 형식·만료·FK·CASCADE | `db/checks/0003_sessions.sql` | 통과 |

> 실제 Apple JWKS 토큰 검증은 App ID/Service ID 와 실제 identity token 이 필요해 아직 실행하지
> 않았다(`ENV-09`). Fake verifier 로 서버 경로만 검증했다.

## 2.9 BLE GATT 프로토콜 (W-20, 2026-11-14)

| # | 검증 | 근거 | 결과 |
| --- | --- | --- | --- |
| 1 | 프레임 왕복 + CRC/magic/version/length/최대 크기 검증 | `tests/ble-protocol.test.ts` | 통과 |
| 2 | 정상 전송(오프셋·SHA-256 일치) | 동일 | 통과 |
| 3 | DATA 유실 → ACK 갭으로 재전송 | 동일 | 통과 |
| 4 | ACK 유실 → 타임아웃 재전송 | 동일 | 통과 |
| 5 | 중간 절단 → 부분 오프셋부터 재개 | 동일 | 통과 |
| 6 | 중복 DATA 무시 + ACK | 동일 | 통과 |
| 7 | 갭 DATA 거부 + ACK | 동일 | 통과 |
| 8 | SHA 불일치 → `COMPLETE_RES.mismatch` | 동일 | 통과 |
| 9 | 완료 파일 `LIST_RES` 메타데이터 | 동일 | 통과 |

명세: `docs/12-ble-protocol.md`. 실기기 MTU·타이밍·전원 차단 복구는 `HW-PENDING`(W-21~W-24).

## 2.10 AI provider 계약 (W-18, 2026-11-14)

| # | 검증 | 근거 | 결과 |
| --- | --- | --- | --- |
| 1 | multipart 분석 요청(메타데이터+오디오)과 도메인 타입 변환 | `tests/ai-provider.test.ts` | 통과 |
| 2 | embed 차원 검증, 잘못된 응답 거부 | 동일 | 통과 |
| 3 | 5xx 재시도 가능 / 4xx 재시도 불가 | 동일 | 통과 |
| 4 | 타임아웃·비JSON 응답 fail-closed | 동일 | 통과 |
| 5 | `GYEOL_AI` fail-closed, Fake 와 HTTP 동일 포트 형태 | 동일 | 통과 |
| 6 | 재시도 불가 오류는 분석 작업이 첫 시도에 실패 | `tests/async-analysis.test.ts` | 통과 |

계약: `docs/13-ai-provider-contract.md`. 실제 vendor·지연·비용은 `ENV-05`.

## 2.11 실기기·iOS (2026-11-14)

연결된 **ESP32-S3 (8MB PSRAM)** 개발 보드와 Xcode 27.2 로 검증했다. 스펙 대상인
nRF52840 Sense 는 아니므로 `HW-PENDING` 은 유지한다.

| # | 검증 | 근거 | 결과 |
| --- | --- | --- | --- |
| 1 | PDM 5초 녹음 → WAV 160,256 bytes | `firmware/esp32s3` 시리얼 로그 | 통과 |
| 2 | SD 없음 → LittleFS 폴백, 재부팅 후 파일 유지 | 동일 | 통과 |
| 3 | BLE 160,300 bytes 전송, SHA-256 일치 | `tools/ble_probe.py` | 통과 |
| 4 | 50,160 bytes 에서 중단 → 재접속 후 재개, 최종 SHA 일치 | 동일 | 통과 |
| 4b | 기기 재부팅(재플래시) 후 같은 파일에서 재개, 최종 SHA 일치 | 동일 | 통과 |
| 5 | VAD(white noise) 트리거 → 208,000 bytes 저장 → BLE SHA 일치 | `ble_probe.py` | 통과 |
| 6 | SD 없이 LittleFS 회전: 전송 완료 파일 삭제 후 재녹음 | 시리얼 로그 | 통과 |
| 7 | microSD(2GB FAT16, Mac 포맷) 마운트 | CMD0=0xFF | **실패** — 슬롯/접촉/전원 문제 |
| 5 | Swift 프레임·수신기·스트림 재조립 13 tests | `apps/ios/Packages/GyeolBLE` | 통과 |
| 6 | iOS 앱 시뮬레이터 빌드(서명 없이) | `xcodebuild ... iphonesimulator` | 통과 |
| 7 | iOS device(arm64) 무서명 컴파일 + 서버 주소 설정 UI | `xcodebuild ... iphoneos` | 통과 |

- MTU 247 에서 알림이 244바이트로 잘리므로 **청크 220** 으로 조정했다. 이전 240 은
  프레임이 잘려 CRC 오류가 났다.
- ACK 배칭·창 8 적용 후 160KB 전송이 약 28초 → 14초로 줄었다.
- 보드는 XIAO ESP32S3 + Exp. Board v1.1(Sense 키트). PDM peak 6706 확인, white noise 로 VAD 트리거
  및 208KB 클립 BLE 전송 SHA 일치. 실제 음성 튜닝과 microSD(카드 미삽입)는 남았다.
- iOS 실기기 CoreBluetooth E2E, VAD, microSD 카드, nRF52840 포팅은 아직 `HW-PENDING`.

## 2.12 삭제·내보내기·감사 (W-25, 2026-11-14)

| # | 검증 | 근거 | 결과 |
| --- | --- | --- | --- |
| 1 | export 는 본인 데이터만, attachment 헤더, 감사 기록 | `tests/privacy.test.ts` | 통과 |
| 2 | 계정 삭제: 세션 폐기, 재로그인 401, 30일 유예, 멱등 | 동일 | 통과 |
| 3 | 30일 경과 원본만 purge, ACK 없는 녹음 제외, 멱등 | 동일 | 통과 |
| 4 | 30일 경과 삭제 계정 하드 삭제·오브젝트 삭제 | 동일 | 통과 |
| 5 | 사용자 상태·purge 후보·감사 최신순·purge 후 SET NULL | `tests/db/privacy.test.ts` | 통과 |
| 6 | audit_events CHECK/FK/SET NULL | `db/checks/0004_audit_events.sql` | 통과 |
| 7 | purge 스크립트 실행(현재 0건) | `npm run purge` | 통과 |

명세: `docs/adr/0012-export-account-deletion-audit.md`, `GET /api/v1/export`, `DELETE /api/v1/me`.

## 2.13 성능 기준선 (W-28, 2026-11-14)

| 시나리오 | RPS | p50 | p95 | 오류 | 근거 |
| --- | ---: | ---: | ---: | ---: | --- |
| 대화 목록 | 1,873 | 10.0ms | 14.9ms | 0 | `npm run bench` (120건) |
| 대화 상세 | 1,633 | 11.7ms | 16.8ms | 0 | 동일 |
| 키워드 검색 | 1,414 | 13.5ms | 19.7ms | 0 | 동일 |
| 기기 목록 | 5,198 | 3.6ms | 5.5ms | 0 | 동일 |
| 대화 목록 (10k) | 557 | 33.9ms | 51.0ms | 0 | `BENCH_CONVERSATIONS=10000` |
| 키워드 검색 (10k) | 67 | 297.8ms | 457.7ms | 0 | 동일 — 잠정 목표 초과 |
| trigram 실험 (10k, 1건 일치) | 107 | 177.7ms | 315.9ms | 0 | 인덱스만으로 부족 |
| trigram+HNSW 적용 후 (10k, 광범위) | 154 | 126.9ms | **175.2ms** | 0 | ADR-0013, 목표 달성 |
| trigram+HNSW 적용 후 (10k, 1건) | 163 | 119.8ms | **176.9ms** | 0 | 동일 |

- 환경: PostgreSQL 17, 대화 120건, 동시성 20, 3초×4 시나리오, Fake AI.
- 10,000건 검색 p95는 인덱스 전 458ms → trigram+HNSW 후 175ms 로 목표(250ms) 안에 들어왔다.
- 실제 provider·TLS/프록시·다중 인스턴스는 아직 측정하지 않았다.
- 상세: `docs/14-performance-baseline.md`.

## 2.14 릴리스 수용 테스트 (W-29, 2026-11-14)

`npm run acceptance -- --with-ios` 로 8개 검증을 한 번에 실행했다.

| 검증 | 결과 | 시간 |
| --- | --- | ---: |
| 계약 + 타입 + 단위/통합 | PASS | 3.1s |
| DB 마이그레이션 제약 | PASS | 0.4s |
| PostgreSQL 패리티 | PASS | 2.3s |
| S3/MinIO | PASS | 1.5s |
| 웹 E2E | PASS | 7.2s |
| Swift BLE 패키지 | PASS | 3.9s |
| 펌웨어 빌드 | PASS | 2.1s |
| iOS 시뮬레이터 빌드 | PASS | 4.0s |

- **8/8 통과**, 0 실패.
- 릴리스 판정은 **NO-GO** 다. 실물·실 provider·배포 인증서 등 10개 차단 항목은
  `docs/15-release-checklist.md` 에 정리했다.

## 3. ENV-PENDING (완료로 표시하지 않음)

| ID | 항목 | 사유 | 검증 방법(준비됨) |
| --- | --- | --- | --- |
| ENV-01 | `0001_init.sql` 실제 적용 | — | **해소 (2026-11-14)** — 14 테이블·확장 2종 적용 확인 |
| ENV-02 | PostgreSQL `Store` 어댑터 | — | **해소 (2026-11-14)** — `PostgresStore` + `tests/db` 14건 통과 |
| ENV-03 | 실물 웨어러블(VAD·PDM·microSD·BLE) | 하드웨어 미확보 | 펌웨어 테스트 + `HW-PENDING` 절차 |
| ENV-04 | iOS CoreBluetooth/AVFoundation 실연동 | 기기·앱 미개발 | 실기기 시나리오 |
| ENV-05 | 실제 STT/화자분리/요약 provider | provider 미선정(W-18) | provider 어댑터 계약 테스트 |
| ENV-06 | 한국어 전문검색 토크나이저(D-07) | 미확정 | 검색 품질 측정 |
| ENV-07 | pgvector 인덱스(HNSW) 튜닝 | 차원 확정(256/768), 모델·부하 미측정 | W-18 이후 부하 테스트 |
| ENV-08 | 실제 S3/AWS(운영) | MinIO 로만 검증 | 운영 버킷·권한·수명주기 리허설 (W-26) |
| ENV-09 | 실제 Apple identity token 검증 | App ID/Service ID·실기기 미연결 | Apple JWKS + 실제 토큰으로 로그인 E2E |

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
