# 프로젝트 폴더 구조 (v1.0)

- 상태: **확정** (2026-11-13, 스택 확정 및 Phase 1 구현 반영)
- 원칙: 이미 만든 자산(문서, 계약, 검증 도구)은 위치를 바꾸지 않는다.

## 1. 현재 구조 (실제)

```text
gyeol/
├── MEMORIAL_PROJECT_SPEC.md        # 최상위 기준 문서 v1.0 (확정)
├── apps/api/
│   ├── server.mjs                  # 실행 진입점 (얇은 래퍼)
│   └── src/
│       ├── domain/                 # L1: 순수 규칙 (상태전이·삭제조건·화자판정)
│       ├── ports/                  # Store / AiPipeline / ObjectStorage 계약
│       ├── observability.ts        # 요청 로그·Prometheus 메트릭
│       ├── usecases/               # L2: 디바이스·녹음·대화·비동기 분석 유스케이스
│       ├── adapters/
│       │   ├── memory/store.ts     # 기준 구현 (테스트·개발)
│       │   ├── postgres/store.ts   # PostgreSQL 구현 (ADR-0005)
│       │   ├── storage/local-disk.ts
│       │   ├── storage/s3.ts       # S3 호환 (ADR-0008)
│       │   ├── ai/fake-pipeline.ts
│       │   ├── ai/http-pipeline.ts # HTTP provider 계약 (W-18)
│       │   └── identity/apple.ts   # Apple JWKS 검증 (ADR-0010)
│       └── http/                   # L4: 라우팅·검증·problem+json·DTO
├── apps/web/                       # React 대시보드 (계약 타입 생성, Vite)
│   ├── src/api/schema.ts           # OpenAPI 에서 생성 (커밋)
│   ├── src/components/             # Timeline · Detail · Sidebar
│   └── src/styles.css              # Warm Editorial 토큰
├── apps/ios/                       # SwiftUI 앱 + GyeolBLE Swift Package (Enterprise 팀)
├── firmware/esp32s3/               # ESP32-S3 개발 보드 펌웨어 (W-21/W-22)
├── packages/
│   ├── ble-protocol/               # GATT 프레임·전송 상태 기계 (W-20)
│   ├── hardware-adapter/port.ts    # 웨어러블 포트 (실물/Fake 공통)
│   ├── device-fake/index.ts        # WAV 생성·로컬 저장·전송 ACK
│   └── mobile-fake/index.ts        # BLE 수신·재개, 업로드·재개, ACK 원장
├── contracts/
│   ├── openapi/openapi.yaml        # 13개 오퍼레이션
│   ├── schemas/common/*.json       # problem, page, health
│   ├── schemas/domain/*.json       # device, recording, session, conversation…
│   └── examples/**/{valid,invalid}
├── db/
│   ├── migrations/0001_init.sql    # 14개 테이블
│   ├── migrations/0002_analysis_jobs.sql  # 비동기 분석 작업 큐 (ADR-0007)
│   ├── migrations/0003_sessions.sql       # Apple 세션 (ADR-0010)
│   ├── checks/*.sql                # 제약 실동작 검증
│   └── README.md
├── deploy/docker-compose.yml       # pgvector·MinIO 로컬 서비스
├── scripts/db-migrate.mjs          # 체크섬 기반 마이그레이션 러너
├── scripts/db-checks.mjs           # DB 제약 검증 러너
├── scripts/test-s3.mjs             # MinIO 스토리지 테스트 러너
├── scripts/db-backup.mjs           # pg_dump 논리 백업
├── scripts/db-restore-rehearsal.mjs # 별도 DB 복구·비교
├── tests/
│   ├── integration.test.ts         # 전 구간 시나리오
│   ├── async-analysis.test.ts      # 작업 큐·재시도·타임아웃·임차 회수
│   ├── auth.test.ts                # 세션·소유자 스코프
│   ├── ble-protocol.test.ts        # 프레임·재전송·이어받기
│   ├── ai-provider.test.ts         # provider 계약·실패 경로
│   ├── e2e/                        # Playwright 검색·상세·모바일
│   ├── db/                         # PostgreSQL 패리티·작업 큐
│   ├── s3/                         # S3 어댑터·전 구간
│   └── unit/domain.test.ts         # 도메인 규칙
├── tools/
│   ├── validate-contracts.mjs
│   ├── contract-test.mjs
│   └── test/
├── docs/ (00~13, adr/0001~0011)
├── tools/ (codec 측정, BLE 프로브는 firmware/esp32s3/tools)
└── Makefile, package.json, tsconfig.json, .github/workflows/ci.yml
```

## 2. 목표 구조 (스택 확정 — Phase 1)

```text
gyeol/
├── contracts/              # L0. 언어 중립 계약 (현재 구현됨)
├── db/
│   └── migrations/         # 0001_init.sql 등 (Phase 2)
├── packages/
│   ├── domain/             # L1. 순수 도메인 (외부 의존 0)
│   ├── application/        # L2. 유스케이스 + 포트 정의
│   ├── adapters/
│   │   ├── persistence/    # L3. PostgreSQL
│   │   ├── storage/        # L3. 오브젝트 스토리지(로컬 구현 포함)
│   │   ├── ai/             # L3. AI Provider (fake 포함)
│   │   └── device-fake/    # L3. Fake Hardware Adapter
│   ├── device-fake/        # 웨어러블 시뮬레이터
│   └── mobile-fake/        # BLE 수신·재개·업로드 시뮬레이터
├── apps/
│   ├── api/                # L4. HTTP 엣지
│   └── simulator/          # Fake 기기→폰→서버 E2E 실행기
├── tools/                  # 계약 검증/계약 테스트
└── docs/
```

> 스택은 `MEMORIAL_PROJECT_SPEC.md` §3 으로 확정되었다(Node/TS, PostgreSQL+pgvector, iOS, React).
> 디렉터리는 해당 단계에서 생성한다(빈 껍데기를 미리 만들지 않는다).

## 3. 명명 규칙

| 대상 | 규칙 | 예 |
| --- | --- | --- |
| 문서 | `NN-kebab-case.md`, 번호는 의존 순서 | `05-api-conventions.md` |
| ADR | `NNNN-kebab-title.md` | `0001-contract-first.md` |
| 스키마 | `kebab-case.json`, `$id` 는 `https://gyeol.local/schemas/<그룹>/<이름>.json` | `common/problem.json` |
| 예제 | 스키마 파일명과 동일해야 검증기가 매칭 | `examples/common/valid/page.json` |
| 오류 코드 | `UPPER_SNAKE_CASE` | `VALIDATION_FAILED` |

## 4. 구조 규칙

1. `contracts/` 는 특정 언어에 종속되지 않는다. 코드 생성물을 커밋하지 않는다.
2. `docs/` 는 구현보다 앞서 갱신한다(설계 우선). 결정은 `docs/adr/` 에 남긴다.
3. `tools/` 는 개발 편의 도구이며 제품 런타임에 포함되지 않는다.
4. 계층별 디렉터리는 스택 확정 후 생성하고, 생성 즉시 의존 방향 린트를 붙인다.
