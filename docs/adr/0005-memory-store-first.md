# ADR 0005 — 저장소는 메모리 어댑터 우선, PostgreSQL 어댑터는 후속

- 상태: 채택 (임시)
- 날짜: 2026-11-13
- 관련: R-032, `db/migrations/0001_init.sql`

## 맥락

스택은 PostgreSQL + pgvector 로 확정됐고 마이그레이션도 작성했다. 그러나 개발 환경에
Docker 데몬과 PostgreSQL 이 없어 **실제 DB 에 스키마를 적용해 검증할 수 없다.**
이 상태에서 PostgreSQL 리포지토리를 작성하면 "컴파일만 되는, 한 번도 실행되지 않은" 코드가
핵심 경로에 들어간다.

## 결정

1. `Store` 포트를 두고, **메모리 어댑터를 기준 구현(reference)** 으로 사용한다.
   유니크 제약·페이지 정렬·검색 점수 의미를 PostgreSQL 과 동일하게 맞춘다.
2. API·도메인·Fake Device/Mobile·통합 테스트는 메모리 어댑터로 전 구간 검증한다.
3. PostgreSQL 어댑터는 별도 작업으로 추가하고, **DB 가 있는 환경에서만** 통합 테스트를
   통과시킨 뒤 채택한다(`npm run test:db`).
4. 마이그레이션은 작성 완료 상태로 두되, **실행 검증 전까지 `ENV-PENDING`** 으로 표기한다.

## 결과

- 장점: 검증되지 않은 SQL 이 제품 경로에 섞이지 않는다. 도메인/계약은 지금 확정된다.
- 비용: 서버를 재시작하면 데이터가 사라진다(메모리). **개발용으로만 사용한다.**
- 리스크: 메모리 구현과 PostgreSQL 구현의 의미 차이. 완화책:
  - `Store` 계약 테스트를 두 어댑터에 동일하게 적용
  - 유니크/페이지/검색 시맨틱을 문서(`docs/10-domain-model.md`)에 고정
- 전환 조건: `docker compose -f deploy/docker-compose.yml up -d` + `npm run db:migrate`
  성공, 그리고 `npm run test:db` 통과.
