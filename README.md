# GYEOL (가칭)

추모/기념 프로젝트. 현재 **Phase 0(기반 구축)** 완료, **Phase 1(스펙 확정) 대기** 상태다.

> 최상위 기준 문서 `MEMORIAL_PROJECT_SPEC.md` 는 아직 **초안(자리표시자)** 이다.
> 원본 스펙을 확보하면 교체하고 개발을 재개한다.

## 빠른 시작

```bash
make install   # 의존성 설치
make check     # 계약 검증 + 테스트
npm start      # API 실행 (http://127.0.0.1:8080)
npm run contract-test   # 실행 중인 서버를 OpenAPI 와 대조
```

요구사항: Node.js 20+ (계약 검증 도구용)

## 현재 상태

| 영역 | 상태 |
| --- | --- |
| 저장소 분석 | 완료 — `docs/00-repository-analysis.md` |
| 요구사항 기준선 | 완료 — `docs/01-requirements.md` |
| 아키텍처(잠정) | 완료 — `docs/02-architecture.md` |
| 폴더 구조(잠정) | 완료 — `docs/03-folder-structure.md` |
| 개발 계획 | 완료 — `docs/04-development-plan.md` |
| API 규약 | 완료 — `docs/05-api-conventions.md` |
| 공통 계약 | 완료 — `contracts/` (스키마 3 · OpenAPI) |
| 계약 검증 파이프라인 | 완료 — CI + `npm run check` |
| 워킹 스켈레톤 API | 완료 — `apps/api/` (`/healthz`, `/api/v1/info`) + 계약 테스트 |
| Phase 1 스펙 | 확정 — `MEMORIAL_PROJECT_SPEC.md` v1.0 |
| Phase 1 요구사항 | 완료 — `docs/06-phase1-requirements.md` |
| 도메인 모델·ERD | **검토 대기** — `docs/10-domain-model.md` |
| 마이그레이션·도메인 코드 | 승인 후 착수 |
| 하드웨어 | 미착수 — `HW-PENDING` |

## 구조

```
docs/        설계·분석·계획 문서 (여기서 먼저 결정한다)
contracts/   언어 중립 계약: JSON Schema + OpenAPI + 예제
tools/       계약 검증기와 테스트
```

## 개발 원칙

1. 계약 우선 — 스키마/API 계약이 코드보다 먼저다. (`docs/adr/0001-contract-first.md`)
2. 하드웨어는 포트/어댑터 뒤에 격리한다.
3. 실물 하드웨어 검증 전에는 어떤 항목도 "완료"로 표기하지 않는다. → `HW-PENDING`
4. 모든 작업은 테스트와 문서 갱신을 동반한다.
5. 기존 자산은 삭제·전면 교체하지 않는다.

## 다음 할 일

- [ ] `docs/10-domain-model.md` §11 승인 (D-03, 1:1, `stored` 시점, `speaker_clusters`, TBD 기본값)
- [ ] PostgreSQL 마이그레이션 `0001_init.sql`
- [ ] OpenAPI 확장 (Recording / Conversation)
- [ ] 도메인 코어 + 유스케이스
- [ ] Fake Hardware / Fake Mobile + 통합 테스트
- [ ] 실제 하드웨어·iPhone 연결 (`HW-PENDING`)
