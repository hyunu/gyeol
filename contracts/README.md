# contracts/ — 언어 중립 계약

애플리케이션 코드보다 먼저 존재하는 계약 계층(L0). 특정 언어/프레임워크에 종속되지 않는다.

## 검증

```bash
npm run check     # 계약 검증 + 테스트
npm run validate  # 계약 검증만
```

검증 항목:

1. 모든 스키마가 JSON Schema 2020-12 로 컴파일되고 `$id` 가 고유한가
2. 스키마마다 valid 예제가 최소 1개 있는가
3. `examples/**/valid/*.json` 이 스키마를 통과하는가
4. `examples/**/invalid/*.json` 이 스키마를 **통과하지 않는가**
5. `openapi/openapi.yaml` 이 유효하고 `$ref` 가 모두 해석되는가

## 추가 방법

새 스키마 `schemas/domain/foo.json` 을 만들 때:

```text
contracts/schemas/domain/foo.json
contracts/examples/domain/valid/foo.json      # 파일명이 스키마명과 일치해야 함
contracts/examples/domain/invalid/foo.json    # 최소 1개 권장
```

- 예제 폴더의 **파일명(basename)** 으로 스키마를 찾는다. 이름이 다르면 검증 실패.
- `$id` 규칙: `https://gyeol.local/schemas/<그룹>/<이름>.json`
- 필드 제약(필수/패턴/열거)을 추가하면 invalid 예제도 함께 추가한다.

## 파일

| 경로 | 설명 |
| --- | --- |
| `openapi/openapi.yaml` | API 계약 (현재 `/healthz`, `/api/v1/info`) |
| `schemas/common/problem.json` | RFC 9457 오류 표현 |
| `schemas/common/page.json` | 목록 페이지 봉투 |
| `schemas/common/health.json` | 상태 확인 응답 |

## 계약 테스트

구현이 계약을 지키는지 확인한다. 스택과 무관하게 동작한다(HTTP 만 사용).

```bash
npm start                 # 터미널 1
npm run contract-test     # 터미널 2 — GET 오퍼레이션 응답을 스키마로 검증
```

- 제외할 오퍼레이션은 `x-gyeol-skip-contract-test: true` 를 붙인다.
- 인증/경로 파라미터가 필요한 엔드포인트는 별도 시나리오 테스트를 작성한다.

## 주의

- 현재 계약은 `x-gyeol-provisional: true` 인 **초안**이다. 도메인 스키마는
  `MEMORIAL_PROJECT_SPEC.md` 확정 후 추가한다.
- 계약을 깨는 변경은 `info.version` 의 major 를 올리고 ADR 을 남긴다.
