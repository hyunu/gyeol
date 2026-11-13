# 백업과 복구 (Backup & Restore)

- 상태: **절차 수립 + 복구 리허설 완료** (W-26, 2026-11-14)
- 관련: `scripts/db-backup.mjs`, `scripts/db-restore-rehearsal.mjs`, `docs/09-observability.md`

> RPO/RTO 목표와 보존 기간은 아직 확정되지 않았다(D-13 보존 정책과 함께 결정).
> 이 문서는 **지금 할 수 있는 복구**를 재현 가능하게 만드는 것이 목적이다.

## 1. 무엇을 백업하는가

| 대상 | 방법 | 비고 |
| --- | --- | --- |
| PostgreSQL 메타데이터 | `pg_dump -Fc` (논리 백업) | 사용자·기기·녹음·대화·분석 작업 |
| 오브젝트 스토리지(원본 음성) | 버킷 버전 관리 + 교차 리전 복제 | DB 백업에 포함되지 않는다 |
| 비밀 값(.env, 키) | 별도 비밀 관리 | 저장소에 커밋 금지 |

**DB 만 복구하면 대화는 보이지만 원본 음성이 없을 수 있다.** 오브젝트 스토리지 수명주기와
복제는 운영 버킷 확정 후 리허설한다(`ENV-08`).

## 2. 백업

### 개발 환경 (docker compose)

```bash
make db-up
DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol npm run db:backup
# → .artifacts/backups/gyeol-<timestamp>.dump
```

컨테이너 `gyeol-postgres` 안의 `pg_dump` 를 사용한다(`PG_CONTAINER` 로 변경 가능).

### 운영 환경

백업 호스트에서 같은 옵션으로 실행한다. 접속 정보는 환경 변수/비밀 관리에서 주입한다.

```bash
pg_dump -Fc --no-owner --no-privileges -d "$DATABASE_URL" -f "gyeol-$(date +%Y%m%dT%H%M%S).dump"
```

- 백업 파일은 암호화된 스토리지에 보관하고, 접근을 백업 역할로 제한한다.
- 정기 실행(예: 일 1회)과 보존 개수는 운영 정책에서 정한다(TBD).
- 백업 성공/실패는 로그·알림으로 감시한다(W-27).

## 3. 복구 리허설

원본 DB 는 건드리지 않고 `<db>_rehearsal` 에 복구한 뒤 비교한다.

```bash
DATABASE_URL=postgres://gyeol:gyeol@localhost:5433/gyeol \
npm run db:restore:rehearsal -- .artifacts/backups/gyeol-....dump
```

검사 항목:

1. 모든 테이블이 복구됐는가 (목록)
2. 테이블별 행 수가 원본과 같은가
3. `schema_migrations` 의 파일명·체크섬이 같은가
4. 확장(`citext`, `vector`)이 같은가

실패하면 종료 코드 1 이고, 리허설 DB 는 정리된다(`--keep` 으로 유지).

### 2026-11-14 리허설 기록

| 항목 | 결과 |
| --- | --- |
| 백업 | `pg_dump -Fc`, 0.06 MiB |
| 복구 | `pg_restore --no-owner --no-privileges` |
| 테이블 | 16/16, 행 수 전부 일치 (예: conversations 4, recordings 11, analysis_jobs 2) |
| 마이그레이션 | 2건, 체크섬 일치 |
| 확장 | 일치 |
| 소요 | 3.4s |
| 원본 영향 | 없음 |

## 4. 실제 복구 절차 (운영)

1. 서비스를 쓰기 중지 상태로 전환한다(점검 모드 또는 인스턴스 중지).
2. 빈 데이터베이스를 만들고 `pg_restore --no-owner --no-privileges` 로 복구한다.
3. 마이그레이션 러너를 실행해 누락분이 없는지 확인한다(`npm run db:migrate`).
4. `/healthz` 의 `db`·`storage` 가 `ok` 인지 확인한다.
5. 읽기 전용 스모크 테스트: 대화 목록·상세 조회, 검색 1건.
6. 오브젝트 스토리지가 별도로 복구됐는지 확인한다(대표 녹음 1건 `audioAvailable`).
7. 서비스를 재개하고 사후 기록을 남긴다.

> 복구 후에도 **분석 작업 큐**는 다시 실행될 수 있다. `running` 상태로 남은 작업은
> 임차 만료 후 회수되거나 실패로 종료된다(ADR-0007).

## 5. 남은 일

- RPO/RTO·보존 개수 확정 (D-13)
- 오브젝트 스토리지 버전 관리/복제 리허설 (`ENV-08`)
- 백업 암호화·보관소 접근 통제의 실제 구성 (배포 환경)
