# GYEOL

웨어러블이 주변 대화를 VAD 로 감지해 녹음하고, iPhone 이 BLE 로 받아 AI 분석한 뒤,
서버에서 날짜·인물·검색으로 다시 찾아보는 서비스.

- 최상위 기준 문서: [`MEMORIAL_PROJECT_SPEC.md`](MEMORIAL_PROJECT_SPEC.md) v1.0
- 도메인 설계: [`docs/10-domain-model.md`](docs/10-domain-model.md) v1.1 (승인 완료)
- 검증 기록: [`docs/07-verification-log.md`](docs/07-verification-log.md)

## 현재 상태

| 영역 | 상태 |
| --- | --- |
| 스펙·요구사항 | 완료 |
| 도메인 모델·ERD·상태 전이 | 완료 (M-01~M-04 반영) |
| OpenAPI 계약 + 스키마 11종 | 완료 (13 오퍼레이션) |
| Recording / Conversation API | 완료 (메모리·PostgreSQL 저장소) |
| 비동기 분석 작업 큐 | 완료 (ADR-0007, 재시도·타임아웃·임차 회수) |
| 웹 대시보드 (React) | 완료 — 타임라인·상세·인물 필터·키워드 검색 (`apps/web`) |
| Fake Hardware / Fake Mobile | 완료 |
| 통합·계약 테스트 | 완료 — 49 tests · E2E 6 tests |
| PostgreSQL 마이그레이션·제약 검증 | 완료 (15 테이블, `npm run db:checks`) |
| PostgreSQL `Store` 어댑터 | 완료 — `test:db` 14 tests |
| 오브젝트 스토리지 | 완료 — 로컬 디스크 + S3/MinIO (`GYEOL_STORAGE`), `test:s3` 7 tests |
| 관측성 | 완료 — 요청 JSON 로그, `X-Trace-Id`, `GET /metrics` (`docs/09-observability.md`) |
| 세션 인증 | 완료(서버) — Apple JWKS, Bearer/쿠키 세션, 소유자 스코프. iOS/웹 로그인 UI는 대기 |
| BLE 프로토콜 | 완료 — GATT 프레임·ACK·재전송·이어받기 계약 + 시뮬레이터 (`docs/12-ble-protocol.md`) |
| AI provider 계약 | 완료(계약) — HTTP 파이프라인·mock 계약 테스트 (`docs/13-ai-provider-contract.md`). 실제 vendor는 ENV-05 |
| ESP32-S3 펌웨어 | 개발 변형 — PDM 녹음·BLE 전송·중단 재개 SHA 일치 (`firmware/esp32s3`) |
| 백업/복구 | 완료 — `db:backup`·복구 리허설 통과 (`docs/11-backup-restore.md`) |
| 실물 웨어러블 | **HW-PENDING** — ESP32-S3 개발 보드로 PDM·BLE 전송·재개 검증 |
| iOS 앱 | **PARTIAL** — 시뮬레이터 빌드·수신기 13 tests, 실기기 E2E 대기 |
| 실제 AI provider | **ENV-05** — HTTP 계약·mock 테스트 완료 |

## 빠른 시작

```bash
npm install
npm run check      # 계약 + 타입 + 테스트 (49 tests)
npm start          # http://127.0.0.1:8080 (메모리 저장소)
```

PostgreSQL 저장소로 실행:

```bash
make db-up
export DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol
npm run db:migrate
GYEOL_STORE=postgres npm start

npm run db:checks  # 제약·인덱스 실동작 검증
npm run test:db    # Store·작업 큐 테스트 (14 tests)
```

S3(MinIO) 오브젝트 스토리지:

```bash
make db-up   # compose 가 MinIO(9000/9001)도 함께 띄운다
export GYEOL_STORAGE=s3 \
  S3_ENDPOINT=http://127.0.0.1:9000 \
  S3_ACCESS_KEY_ID=gyeol S3_SECRET_ACCESS_KEY=gyeol-minio
npm start
npm run test:s3    # S3 어댑터·전 구간 (7 tests)
```

웹 대시보드:

```bash
npm run web:install
npm run web:dev      # http://127.0.0.1:5173 (API 8080 프록시)
npm run web:build    # 타입 검사 + 프로덕션 빌드
npm run test:e2e     # Playwright 검색·상세·모바일 E2E
```

화면 타입은 OpenAPI 계약에서 생성한다. 계약을 바꾸면 `npm run web:api-types` 로 갱신한다.

로컬 개발은 임시 인증 헤더를 쓴다(ADR-0003).

```bash
curl -s localhost:8080/healthz | jq
curl -s -H 'x-user-id: 0199aaaa-0000-7000-8000-000000000001' \
  -H 'content-type: application/json' \
  -d '{"serialNo":"GYL-0001","model":"xiao-nrf52840-sense"}' \
  localhost:8080/api/v1/devices | jq
```

실행 중인 서버를 계약과 대조:

```bash
npm run contract-test
```

## API 요약

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/healthz` | 상태(하드웨어는 `skipped`) |
| POST/GET | `/api/v1/devices` | 기기 등록·목록 |
| GET | `/api/v1/devices/{id}` | 기기 단건 |
| POST/GET | `/api/v1/recordings` | 녹음 등록(멱등)·목록 |
| GET/DELETE | `/api/v1/recordings/{id}` | 단건·원본 삭제(M-04 5조건) |
| POST | `/api/v1/recordings/{id}/upload-sessions` | 재전송 세션 발급 |
| PUT | `/api/v1/recordings/{id}/upload-sessions/{sid}/chunks?offset=` | 청크 업로드(재개) |
| POST | `/api/v1/recordings/{id}/ack` | 클라이언트 최종 ACK |
| POST | `/api/v1/recordings/{id}/analyze` | AI 분석 작업 등록(202, 재분석 가능) |
| GET | `/api/v1/analysis-jobs/{id}` | 분석 작업 상태 폴링 |
| GET | `/api/v1/conversations` | 날짜·인물·검색(q) |
| GET | `/api/v1/conversations/{id}` | 상세(세그먼트·화자·엔티티·할 일) |
| GET | `/api/v1/persons` | 인물 목록 |
| PATCH | `/api/v1/action-items/{id}` | 할 일 상태 |

전체 계약: [`contracts/openapi/openapi.yaml`](contracts/openapi/openapi.yaml)

## 구조

```
apps/api/src    도메인 규칙 · 유스케이스 · HTTP (프레임워크 없음)
packages/       하드웨어 포트, Fake 기기, Fake 폰
contracts/      JSON Schema + OpenAPI (코드보다 먼저 존재)
db/migrations/  PostgreSQL 스키마
tests/          단위 + 전 구간 통합
docs/           분석·요구사항·설계·검증 기록, ADR
```

## 설계 핵심

1. **원본/파생 분리** — `recordings`(+오브젝트) vs `conversations` 이하. 재분석은 파생만 교체.
2. **M-04 삭제 5조건** — 크기·SHA-256·스토리지 저장·DB 기록·클라이언트 ACK 전에는 삭제 불가.
3. **이어받기** — 업로드 세션 오프셋. 세션 만료는 녹음 삭제가 아니다.
4. **Unknown Speaker** — 임계값/격차 미달 시 `person_id=NULL`, person 행 생성 안 함.
5. **하드웨어 격리** — `HardwareAdapter`/`AiPipeline` 포트. 실물 없이 전 구간 검증.
6. **계약 우선** — OpenAPI/스키마가 CI 에서 강제된다.

## 알려진 제한 (의도된 현재 상태)

- 기본 저장소는 **메모리**다(ADR-0005). `GYEOL_STORE=postgres` 로 PostgreSQL 을 쓸 수 있다.
- 분석은 **비동기 작업 큐**다(ADR-0007). `POST .../analyze` 는 202 로 작업을 만들고,
  `GET /api/v1/analysis-jobs/{jobId}` 로 폴링한다. 워커는 API 프로세스 안에서 돈다.
- `X-User-Id` 는 **로컬 전용**이며 `GYEOL_ENV != local` 이면 401(ADR-0003).
- Apple 로그인 세션은 서버에 구현됐다(Bearer/쿠키). iOS·웹 로그인 UI 는 Apple 설정 후 연결한다.
  `APPLE_CLIENT_IDS`(bundle/Service ID, 쉼표 구분)가 없으면 `/auth/apple` 은 503 이다.
- 오브젝트 스토리지는 **로컬 디스크**가 기본이고 `GYEOL_STORAGE=s3` 로 S3/MinIO 를 쓴다.
  S3 경유 업로드는 커밋 시 전송량이 2배다(ADR-0008).

## 다음 단계

작업 순서와 완료 조건은 [`docs/08-work-order.md`](docs/08-work-order.md) 를 따른다.

1. Apple 로그인·세션 구현 (W-19, Apple 개발자 설정 필요)
2. 삭제·내보내기 API (W-25, D-13 암호화 범위 결정 후) · 실제 AI provider (W-18)
3. 실물 웨어러블 + iOS BLE 연동 (W-20~W-24, `HW-PENDING`)
