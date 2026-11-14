# ADR 0012 — 내보내기·계정 삭제·감사 로그

- 상태: **채택** (W-25, 2026-11-14)
- 관련: ADR-0011(보존), W-19(세션), `GET /api/v1/export`, `DELETE /api/v1/me`,
  `audit_events`, `scripts/purge.mjs`

## 맥락

사용자는 자신의 기록을 내려받고, 계정과 데이터를 삭제할 수 있어야 한다. 삭제·내보내기는
민감한 작업이므로 **누가·언제·무엇을** 했는지 최소한의 감사 근거를 남겨야 한다.
원본 음성은 ADR-0011 에 따라 30일 뒤 자동 purge 된다.

## 결정

1. **내보내기** — `GET /api/v1/export`
   - 사용자 소유의 인물·녹음 메타데이터·대화 상세를 JSON 한 파일로 반환한다.
   - **오디오 바이너리는 포함하지 않는다.** 원본은 별도 다운로드 경로가 필요하다(향후).
   - `Content-Disposition: attachment` 로 저장하게 한다.
   - MVP 는 동기 응답이다. 대화가 매우 많은 계정은 향후 비동기 export job 으로 전환한다.
2. **계정 삭제** — `DELETE /api/v1/me`
   - 즉시 **모든 세션을 폐기**하고 `users.status='deleted'`, `users.deleted_at=now` 로 표시한다.
   - 응답은 `202 {deletion:{status:'pending_purge', requestedAt, purgeAfter}}`.
   - **30일 유예** 후 하드 삭제한다. 재요청은 멱등이며 최초 `requestedAt` 을 유지한다.
   - 삭제된 계정은 재로그인할 수 없다(Apple `sub` 로 다시 들어와도 401).
3. **감사 로그** — `audit_events`
   - action: `export`, `account_delete_requested`, `account_purged`, `recording_purged`.
   - `user_id` 는 사용자 삭제 후 `SET NULL` 로 남겨 이력을 보존한다.
   - metadata 에는 대상 id·건수·정책만 넣고 **대화 본문·파일 경로는 넣지 않는다.**
   - 녹음 원본 삭제(API)도 `recording_purged` 로 기록한다.
4. **보존 purge** — `npm run purge` (cron/배치)
   - 분석 종료 후 30일 지난 원본: 오브젝트 먼저 삭제 → `purged` 갱신 → 감사.
   - 삭제 요청 후 30일 지난 계정: 오브젝트 삭제 → 사용자·파생 데이터 하드 삭제 → 감사.
   - `GYEOL_STORE=postgres` 에서만 실행한다. 실패 건은 다음 실행에서 재시도한다.
5. **D-15(감사) 최소 세트**: 위 4개 action 만 우선 구현한다. 열람 감사는 범위 밖이다.

## 결과

- 장점: 사용자 통제권(내보내기·삭제)과 운영 감사 근거를 확보했다.
- 비용: 내보내기는 대화 수에 비례해 커진다. 계정 삭제는 30일간 데이터가 남는다.
- 주의: **백업에는 삭제 전 데이터가 남을 수 있다.** 백업 보존 기간과 함께 조정해야 한다.
- 테스트: `tests/privacy.test.ts` 4건, `tests/db/privacy.test.ts` 3건, DB 제약 검사.
- 되돌리기: 계정 삭제 유예 기간은 `ACCOUNT_PURGE_GRACE_MS` 한 곳에서 조정한다.
