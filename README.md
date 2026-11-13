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
| OpenAPI 계약 + 스키마 10종 | 완료 (12 오퍼레이션) |
| Recording / Conversation API | 완료 (메모리 저장소) |
| Fake Hardware / Fake Mobile | 완료 |
| 통합·계약 테스트 | 완료 — 17 tests |
| PostgreSQL 마이그레이션 작성 | 완료 |
| PostgreSQL 실행 검증·어댑터 | **ENV-PENDING** (DB 환경 없음) |
| 실물 웨어러블 / iOS 앱 / 실제 AI | **HW-PENDING** |

## 빠른 시작

```bash
npm install
npm run check      # 계약 + 타입 + 테스트 (17 tests)
npm start          # http://127.0.0.1:8080
```

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
| POST | `/api/v1/recordings/{id}/analyze` | AI 분석(재분석 가능) |
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

- 저장소가 **메모리**다. 재시작하면 데이터가 사라진다(ADR-0005). 운영 배포 금지.
- 분석이 **요청 내 동기 실행**이다(ADR-0004). 실제 AI 도입 시 작업 큐 필요.
- `X-User-Id` 는 **로컬 전용**이며 `GYEOL_ENV != local` 이면 401(ADR-0003).
- DB 마이그레이션은 작성만 됐고 실제 적용 검증은 안 됐다(`db/README.md`).

## 다음 단계

1. PostgreSQL 어댑터 + 마이그레이션 실행 검증 (`make db-up && make db-migrate && npm run test:db`)
2. 웹 대시보드 (타임라인·인물·검색)
3. 실제 AI provider 어댑터
4. 실물 웨어러블 + iOS BLE 연동 (`HW-PENDING`)
