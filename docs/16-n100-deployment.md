# n100 배포

GYEOL 데모 스택을 n100-service-hub 단일 서비스(`gyeol`)로 배포한다.
구성은 `deploy/n100/` 에 있고, 서버 빌드 컨텍스트는 `/srv/services/gyeol` 이다.

## 구성

| 컨테이너 | 이미지 | 포트 | 역할 |
| --- | --- | --- | --- |
| `web` | `gyeol-web` (nginx) | host `18080` → 80 | React 빌드 산출물, Basic Auth, `/api` 프록시 |
| `api` | `gyeol-api` (node:24) | 내부 8080 | 마이그레이션 → 데모 시드 → API |
| `db` | `pgvector/pgvector:pg17` | 내부 5432 | PostgreSQL + pgvector |

- API 는 `GYEOL_ENV=local` 로 동작한다. 데모 인증은 `X-User-Id` 이며 공개 배포에는 부적합하다.
- nginx 가 Basic `Authorization` 을 API 로 넘기지 않도록 `proxy_set_header Authorization "";` 를 둔다.
- `/healthz` 는 허브·도커 헬스체크를 위해 인증 없이 프록시한다.

## 절차

1. 배포 번들 생성: `deploy/n100/` 의 Dockerfile·compose·service.yaml 과 소스, `.env`, `.htpasswd` 를 한 디렉터리에 모은다.
2. `hub_service_sync_source(service_id="gyeol", path=<bundle>)`
3. `hub_deploy_plan` 이 `READY` 인지 확인한다.
4. `hub_deploy_apply(service_id="gyeol", confirmed=true)`
5. `hub_deploy_status` 와 `hub_containers_list` 로 3개 컨테이너 running/healthy 를 확인한다.

`security.required_env` 는 두지 않는다. `.env` 는 동기화 번들에 포함되지만 허브 plan 의 필수 변수 검사는
번들 `.env` 를 읽지 않으므로, 넣으면 plan 이 `BLOCKED` 가 된다.

## 검증 (2026-11-14)

- 배포 ID `dep-1fd6cbecfde8`, 상태 `succeeded`
- `gyeol-web-1` running, `gyeol-api-1` healthy, `gyeol-db-1` healthy
- `GET http://<hub-host>:18080/healthz` → 200
- 무인증 `/` → 401, Basic Auth `/` → 200
- Basic Auth + `X-User-Id` 로 `/api/v1/conversations` 데모 대화 3건 응답

## 롤백

`hub_deploy_rollback(deployment_id="dep-1fd6cbecfde8", confirmed=true)` 는 직전 성공 스냅샷으로 되돌린다.
첫 배포이므로 직전 스냅샷은 없고, 문제 시 `hub_deploy_apply` 로 compose down/up 하거나 서비스를 중지한다.

## 재배포 — 대시보드 개편 (2026-11-14)

- 커밋 `30ce0c0` 의 웹 UI를 반영해 `hub_service_sync_source` → `hub_deploy_apply` 를 다시 실행했다.
- 배포 ID `dep-43cef8fdfc5e`. 웹 이미지는 재빌드되어 `index-DJRqdQAL.css` 를 서빙한다.
- 실제 런타임은 정상이다: `web`/`api`/`db` running, `/healthz` 200, Basic Auth `/` 200, 데모 대화 3건.
- 다만 허브의 배포 기록은 `running` 으로 남아 있다. `compose up` 완료 후 상태 갱신 단계에서 500이 발생했고,
  컨테이너는 정상 기동됐다. 후속 배포 전에 허브 서버 로그 확인이 필요하다.

