# ADR 0011 — 원본 음성은 30일 뒤 purge 하고 파생 데이터는 유지한다

- 상태: **채택** (D-08, D-11. D-13 암호화 범위는 TBD)
- 날짜: 2026-11-14
- 관련: W-13, W-25, M-04, `recordings.status='purged'`, `docs/11-backup-restore.md`

## 맥락

원본 음성은 가장 민감한 데이터다. 대화·요약·할 일은 사용자가 계속 읽을 가치가 있지만,
원본을 무기한 보관할 이유는 약하다. M-04 는 검증·ACK 전 삭제를 금지하므로 purge 는
그 이후에만 가능하다.

## 결정

1. **원본 음성은 분석이 끝난 뒤 30일이 지나면 purge 한다.**
   - 기준 시각: `COALESCE(analyzed_at, client_ack_at)`
   - 대상 상태: `analyzed`, `analysis_failed`, `stored` 중 `client_ack_at` 이 있는 것
   - `client_ack_at` 이 없으면 M-04 에 따라 삭제하지 않는다.
2. purge 는 **오브젝트 삭제 + `recordings` 행 갱신**이다.
   - `status='purged'`, `storage_key=NULL`, `purged_at=now()`
   - 행 자체는 남긴다(무결성·ACK·감사 기록).
3. **파생 데이터는 유지한다** (D-11).
   - conversations, transcript_segments, extracted_entities, action_items,
     conversation_embeddings, speaker_clusters, persons 는 그대로 둔다.
   - 원본 재청취는 불가능해지고, `audioAvailable=false` 가 된다.
4. 계정 삭제·내보내기는 별도 절차다(W-25). 삭제 유예 기간은 그때 정한다.
5. 암호화(D-13)는 **아직 TBD**다. 이 ADR 은 보존 기간만 확정한다.
   - 기본선: DB·오브젝트 스토리지의 저장 암호화(at-rest)와 전송 TLS 를 전제로 한다.
   - 필드 단위 암호화 범위(전화번호·이메일 등)는 W-25 에서 결정한다.

## purge 작업 설계 (W-25 에서 구현)

```sql
-- 후보 선별 (배치, 잠금)
SELECT id, storage_key
FROM recordings
WHERE status IN ('analyzed', 'analysis_failed', 'stored')
  AND client_ack_at IS NOT NULL
  AND COALESCE(analyzed_at, client_ack_at) <= now() - interval '30 days'
  AND storage_key IS NOT NULL
ORDER BY COALESCE(analyzed_at, client_ack_at) ASC
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

1. 후보별로 오브젝트를 삭제한다. **없는 객체(404)는 성공으로 본다.**
2. 성공한 행만 `purged` 로 갱신한다. 오브젝트 삭제가 실패하면 행을 그대로 두고 다음 주기에 재시도한다.
3. 삭제 결과(건수·실패)를 로그와 감사 기록에 남긴다.
4. 작업은 분석 워커와 분리된 스케줄(예: 1시간)로 실행한다.

> DB 를 먼저 갱신하면 `storage_key` 를 잃고 오브젝트가 고아가 된다. **오브젝트 먼저,
> 행 갱신 나중** 순서를 지킨다. 중간 실패 시 다음 주기가 404 를 성공으로 처리한다.

## 결과

- 저장 비용 감소, 유출 시 원본 음성 노출 창이 30일로 제한된다.
- 사용자는 30일 이후 원본을 다시 들을 수 없다. UI 는 `audioAvailable` 로 이를 표시한다.
- 백업: 30일이 지나기 전 백업에 원본 음성이 남을 수 있다. 백업 보존 기간(D-13/운영 정책)과
  함께 조정해야 한다. 복구 리허설은 `docs/11-backup-restore.md` 를 따른다.
- 테스트(W-25): 30일 경계, ACK 없는 녹음 제외, 오브젝트 삭제 실패 시 미갱신, 파생 유지.
