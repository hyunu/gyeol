# API 규약 (초안 v0.1)

- 적용 범위: `contracts/openapi/openapi.yaml` 및 이후 추가되는 모든 엔드포인트
- 상태: 잠정. 스펙 확정 시 확장하되, 아래 규칙은 유지한다.

## 1. 버전과 호환성

| 항목 | 규칙 |
| --- | --- |
| 경로 버전 | `/api/v{n}`. 호환 불가 변경 시 n 증가 |
| 계약 버전 | `info.version` (semver). 필드 추가는 minor, 삭제/의미 변경은 major |
| 임시 계약 표시 | 문서 루트에 `x-gyeol-provisional: true` |
| 필드 추가 | 클라이언트는 알 수 없는 필드를 무시해야 한다(전방 호환) |

## 2. 표현 규칙

- 본문: `application/json` (UTF-8)
- 오류: `application/problem+json` (RFC 9457)
- 시각: RFC 3339 UTC, `Z` 접미사. 로컬 시간대 문자열 금지
- 식별자: 불투명 문자열. 길이/형식 가정 금지
- 금액/수치: 부동소수 오차가 문제되는 값은 정수 최소 단위 또는 문자열 사용
- 열거형: 소문자 snake_case (`pending_review`)

## 3. 목록 조회

| 파라미터 | 기본 | 제약 |
| --- | --- | --- |
| `page` | 1 | ≥ 1 |
| `size` | 20 | 1~200 |
| `sort` | 엔드포인트별 | 허용 필드만 |

응답은 `Page` 봉투(`contracts/schemas/common/page.json`)를 쓴다. 총 개수 산출이
비싼 엔드포인트는 `total` 생략을 별도 계약으로 정의한다(현재 봉투는 필수).

## 4. 오류 처리

- 분기 기준은 `code` 이며 `title`/`detail` 은 표시용이다.
- 검증 실패는 `422` + `errors[]`(JSON Pointer).
- 형식 오류는 `400`, 대상 없음 `404`, 상태 충돌 `409`, 인증 `401`, 권한 `403`,
  레이트리밋 `429`, 내부 오류 `500`, 의존성 장애 `503`.
- `traceId` 는 항상 포함한다(로그 상관관계).

### 오류 코드 레지스트리

| code | HTTP | 의미 | 도입 |
| --- | --- | --- | --- |
| `VALIDATION_FAILED` | 422 | 필드 검증 실패 | v0.1 |
| `BAD_REQUEST` | 400 | 요청 형식 오류 | v0.1 |
| `NOT_FOUND` | 404 | 대상 없음 | v0.1 |
| `CONFLICT` | 409 | 상태 충돌 | v0.1 |
| `METHOD_NOT_ALLOWED` | 405 | 경로는 있으나 메서드 미지원 (`Allow` 헤더 필수) | v0.1 |
| `UNAUTHORIZED` | 401 | 인증 필요/실패 | 예정 (OPEN-004) |
| `FORBIDDEN` | 403 | 권한 없음 | 예정 (OPEN-004) |
| `RATE_LIMITED` | 429 | 호출 제한 | 예정 |
| `INTERNAL_ERROR` | 500 | 내부 오류 | v0.1 |
| `DEPENDENCY_UNAVAILABLE` | 503 | 의존성 장애 | v0.1 |

> 코드 추가 시 이 표와 `contracts/examples/common/valid/problem.json` 을 함께 갱신한다.

## 5. 멱등성과 재시도

- 생성 요청은 `Idempotency-Key` 헤더를 지원한다(스펙 확정 시 의무화 여부 결정).
- `retryable: true` 인 오류만 지수 백오프로 재시도한다.
- `POST` 재시도는 멱등키 없이 금지한다.

## 6. 상태 확인

`GET /healthz` 는 인증 없이 제공한다. 하위 검사는 `checks[]` 로 노출하며,
실물 하드웨어 미연결 시 `skipped` 로 표기한다(거짓 `ok` 금지 — R-011).
