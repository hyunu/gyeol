# 프로젝트 폴더 구조 (초안 v0.1)

- 상태: **잠정** — 애플리케이션 스택 미확정(OPEN-002)
- 원칙: 이미 만든 자산(문서, 계약, 검증 도구)은 위치를 바꾸지 않는다.

## 1. 현재 구조 (실제)

```text
gyeol/
├── .github/workflows/ci.yml     # 계약 검증 + 테스트
├── .editorconfig
├── .gitignore
├── Makefile                     # install / check / validate / test
├── package.json                 # 계약 검증 도구 전용 (앱 런타임 아님)
├── README.md
├── MEMORIAL_PROJECT_SPEC.md     # 기준 문서 (초안, 사용자 확정 필요)
├── docs/
│   ├── 00-repository-analysis.md
│   ├── 01-requirements.md
│   ├── 02-architecture.md
│   ├── 03-folder-structure.md
│   ├── 04-development-plan.md
│   ├── 05-api-conventions.md
│   ├── 06-phase1-requirements.md
│   ├── 10-domain-model.md       # Phase 1 ERD/필드/상태전이 (승인 대기)
│   └── adr/
│       └── 0001-contract-first.md
├── apps/
│   └── api/
│       └── server.mjs           # L4 워킹 스켈레톤 (프레임워크 없음)
├── contracts/
│   ├── README.md
│   ├── openapi/openapi.yaml
│   ├── schemas/common/{problem,page,health}.json
│   └── examples/common/{valid,invalid}/*.json
└── tools/
    ├── validate-contracts.mjs   # L0 계약 검증
    ├── contract-test.mjs        # 실행 중 서버 ↔ OpenAPI 블랙박스 검증
    └── test/
        ├── contracts.test.mjs
        └── api.test.mjs
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
