# ADR 0002 — Recording ↔ Conversation 을 N:M 연결 테이블로 모델링

- 상태: 채택 (승인 M-01)
- 날짜: 2026-11-13
- 관련: `docs/10-domain-model.md` §3.13, R-028

## 맥락

최초 설계는 `recordings` ↔ `conversations` 를 1:1 로 두었다(`conversations.recording_id`
UNIQUE). MVP 에서는 충분하지만 다음 두 경우를 표현할 수 없다.

1. 하나의 긴 녹음 안에 시간적으로 분리된 여러 대화가 포함되는 경우
2. 여러 녹음 파일에 걸쳐 하나의 대화가 이어지는 경우(VAD 분할·기기 재시작)

## 결정

`recording_conversations(recording_id, conversation_id, start_offset_ms, end_offset_ms)`
연결 테이블을 도입하고 `conversations.recording_id` 를 제거한다. PK 는 두 ID 의 쌍이며,
오프셋으로 녹음 내 구간을 나타낸다.

## 대안과 기각 이유

| 대안 | 기각 이유 |
| --- | --- |
| 1:1 유지 후 필요 시 마이그레이션 | 대화 테이블 재작성·데이터 이관 비용. 지금은 비용이 낮다 |
| `conversations` 에 `recording_ids uuid[]` | 구간 오프셋을 담을 수 없고 FK 무결성이 없다 |
| `conversation_segments` 에 녹음 참조 | 세그먼트 단위로만 표현 가능, 대화-녹음 요약 정보가 흩어진다 |

## 결과

- 장점: 구간 단위 다대다 지원, 대화와 녹음의 생명주기 독립.
- 비용: 조회 시 JOIN 필요. 대화의 `started_at/ended_at` 은 세그먼트·연결에서 산출.
- 주의: `end_offset_ms ≤ recordings.duration_ms` 는 DB CHECK 로 표현할 수 없어
  애플리케이션 가드로 강제한다(통합 테스트로 검증).
