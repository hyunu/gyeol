# ADR 0007 — 분석은 비동기 작업 큐로 실행한다

- 상태: **채택** (ADR-0004 대체)
- 날짜: 2026-11-14
- 관련: R-023, W-15, `analysis_jobs`, `POST /api/v1/recordings/{recordingId}/analyze`,
  `GET /api/v1/analysis-jobs/{jobId}`

## 맥락

ADR-0004 는 MVP 편의를 위해 `POST .../analyze` 요청 안에서 STT·화자분리·요약을 끝냈다.
`FakeAiPipeline` 은 즉시 끝나지만 실제 provider 는 수십 초~수 분이 걸린다. 요청 타임아웃,
게이트웨이 제한, 재시도 부재, 중복 실행 방지 부재가 그대로 운영 위험이 된다.

## 결정

1. `POST .../analyze` 는 **작업을 등록하고 즉시 202** 를 돌려준다.
   응답은 `{ recording, job }` 이며 `job.status="queued"` 다.
2. 작업은 `analysis_jobs` 테이블에 저장한다. 상태는 `queued → running → succeeded|failed`.
3. 워커가 `claimNextAnalysisJob(now)` 로 작업을 **원자적으로 선점**한다.
   - PostgreSQL: `FOR UPDATE SKIP LOCKED` + 부분 유니크 인덱스(`analysis_jobs_active_uk`).
   - 녹음당 활성(queued|running) 작업은 1개다. 같은 요청이 반복되면 기존 작업을 돌려준다(멱등).
4. `attempt` 는 선점 횟수다. 실패 시 `attempt < maxAttempts` 이면 `queued` 로 되돌리고
   `availableAt = now + min(retryMax, retryBase * 2^(attempt-1))` 로 백오프한다.
   한도를 넘으면 `failed` 로 종료하고 `recordings.status='analysis_failed'` 로 만든다.
5. 워커는 `timeoutMs` 안에 끝나지 않으면 실패로 간주한다. 임차(`lease_expires_at`)가
   만료된 `running` 작업은 다른 워커가 회수한다(워커 프로세스 사망 대응).
6. 클라이언트는 `GET /api/v1/analysis-jobs/{jobId}` 를 폴링한다.
   `succeeded` 이면 `conversationId` 로 대화를 조회한다.
7. MVP 워커는 **API 프로세스 내부 루프**다(`AnalysisWorker`). 외부 큐(Redis/SQS) 없이도
   선점·재시도·임차 회수 계약이 성립한다. 다중 인스턴스는 같은 `claim` 을 공유한다.

## 결과

- 장점: 요청 시간이 짧고, 실패·재시도·중복 실행이 통제된다. 상태를 관찰할 수 있다.
- 비용: 폴링 API 와 작업 테이블이 늘어난다. 대화 생성 시점이 비동기다.
- 테스트: 워커를 `runNextAnalysisJob` 으로 직접 실행해 결정적으로 검증한다(타이머 없음).
- 전환 조건(외부 큐 도입 시): `claimNextAnalysisJob` 만 교체하면 된다. 도메인·API 계약은 유지.
- 재분석: 이전 작업이 끝난 뒤 새 작업을 만든다. `analysisVersion` 은 기존 규칙대로 증가한다.

## 대체한 것

ADR-0004(동기 분석)는 폐기한다. `POST .../analyze` 응답의 `conversationId` 필드는
`job` 객체로 바뀌었다(계약 버전 0.2.0 내 변경).
