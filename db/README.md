# db/ — PostgreSQL 스키마

기준 문서: `docs/10-domain-model.md` v1.1

## 구성

```
db/migrations/0001_init.sql   # Phase 1 초기 스키마 (14개 테이블)
```

PostgreSQL 17 + `pgvector`, `citext` 확장이 필요하다.

## 실행

```bash
# 1) 로컬 DB 기동 (Docker)
docker compose -f deploy/docker-compose.yml up -d

# 2) 마이그레이션 적용
export DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol
npm run db:migrate
```

## 규칙

1. 적용된 파일은 **수정하지 않는다**. 변경은 새 마이그레이션으로 추가한다.
   (러너가 체크섬으로 드리프트를 감지해 실패시킨다.)
2. 각 파일은 하나의 트랜잭션으로 적용된다.
3. `updated_at` 자동 갱신 트리거는 두지 않는다 — 애플리케이션이 명시적으로 갱신한다.
4. 상태 값은 `text + CHECK` 로 관리한다(값 추가 시 잠금 없는 마이그레이션).
5. `vector(n)` 차원은 D-05 확정 전 **실험값**이다(화자 256 / 텍스트 768).
   모델 확정 시 새 마이그레이션으로 차원을 바꾸고 재임베딩한다.

## 검증 상태

| 항목 | 상태 |
| --- | --- |
| SQL 작성 | 완료 |
| 실제 PostgreSQL 적용 | **ENV-PENDING** — 개발 환경에 Docker/PostgreSQL 이 없어 미실행 |
| 제약·인덱스 동작 | **ENV-PENDING** (적용 후 `db/checks/` 로 검증 예정) |

> DB 적용 검증 전까지 이 스키마를 "검증 완료"로 표기하지 않는다.
