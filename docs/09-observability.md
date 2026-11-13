# 관측성 (Observability)

- 상태: **최소 세트 구현** (W-27)
- 관련: `apps/api/src/observability.ts`, `GET /metrics`, `X-Trace-Id`

## 1. 로그

요청마다 stdout 에 JSON 한 줄을 남긴다(테스트 실행에서는 자동으로 끈다).

```json
{
  "time": "2026-11-14T05:15:25.113Z",
  "level": "info",
  "msg": "http_request",
  "traceId": "b6b2caa6-9671-4685-a822-f3f83ff0a9ae",
  "method": "GET",
  "path": "/api/v1/conversations",
  "status": 200,
  "durationMs": 2.31,
  "userId": "0199aaaa-0000-7000-8000-000000000001"
}
```

- `traceId` 는 요청 헤더 `X-Request-Id` 를 그대로 쓰고, 없으면 생성한다.
  모든 응답의 `X-Trace-Id` 와 problem+json 의 `traceId` 에 같은 값이 들어간다.
- **쿼리 문자열은 남기지 않는다.** 검색어(`q`)는 개인정보이므로 `path` 에서 제외한다.
- 5xx 는 `level="error"` 와 `error` 필드(메시지)로 남긴다.
- 남기지 않는 것: 요청 본문, 오디오, 토큰/인증 헤더, DB 파라미터.

## 2. 메트릭 (`GET /metrics`)

Prometheus 텍스트 형식. 외부 의존이 없다.

| 메트릭 | 타입 | 의미 |
| --- | --- | --- |
| `gyeol_http_requests_total{method,status}` | counter | 상태 코드별 요청 수 |
| `gyeol_http_request_duration_ms_bucket{le}` | histogram | 처리 시간 분포 (5ms~10s) |
| `gyeol_http_request_duration_ms_sum` / `_count` | — | 평균 계산용 |
| `gyeol_process_uptime_seconds` | gauge | 프로세스 가동 시간 |
| `gyeol_process_memory_rss_bytes` | gauge | RSS 메모리 |

`/metrics` 는 인증하지 않는다. 리버스 프록시/보안 그룹에서 내부망에만 노출한다.

## 3. 알림 최소 세트

| 알림 | 조건 | 근거 |
| --- | --- | --- |
| API 5xx 비율 | 5분간 5xx / 전체 > 1% | `gyeol_http_requests_total` |
| 지연 | p95 > 1s (5분) | duration histogram |
| 상태 | `/healthz` 가 `down` 3회 연속 | db·storage check |
| 분석 적체 | `analysis_jobs` 의 `queued` 가 10분간 감소하지 않음 | 아래 SQL |
| 분석 실패 | 10분간 `failed` 증가 > 0 | 아래 SQL |

```sql
-- 분석 작업 상태 분포 (알림 수집기가 주기적으로 실행)
SELECT status, count(*) FROM analysis_jobs GROUP BY status;
```

> 작업 큐 메트릭을 HTTP 프로세스에 직접 노출하지 않은 이유: 다중 인스턴스에서 각자 다른
> 큐를 보는 것처럼 보이기 때문이다. DB 를 단일 기준으로 조회한다(W-28 에서 부하와 함께 재검토).

## 4. 확인 방법

```bash
npm start
curl -s localhost:8080/metrics | head -20
curl -s -H 'x-request-id: demo-trace' localhost:8080/healthz | jq
```

`/healthz` checks: `store`, `db`(가능한 경우), `storage`, `device-link`.
`storage` 는 객체 존재 확인(HEAD/stat)으로 실제 연결을 검사한다.

## 5. 남은 일

- 대시보드(Grafana 등) 구성과 알림 전송 채널은 배포 환경 결정 후(W-29).
- 부하/지연 목표 측정은 W-28.
