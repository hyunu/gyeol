# AI Provider 계약 (W-18)

- 상태: **계약·어댑터 구현 완료** (2026-11-14). 실제 vendor 연결은 `ENV-05`
- 구현: `apps/api/src/adapters/ai/http-pipeline.ts`
- 테스트: `tests/ai-provider.test.ts` (mock HTTP 서버)
- 관련: `AiPipeline` 포트, ADR-0007(작업 큐), ADR-0009(임베딩 768)

> GYEOL 서버는 provider 와 **HTTP 계약**으로만 연결한다. vendor SDK 를 서버 코드에 넣지
> 않는다. provider 서비스(자체 호스팅 또는 managed)가 이 계약을 구현한다.

## 1. 선택

`GYEOL_AI` 로 고른다.

| 값 | 의미 |
| --- | --- |
| `fake` (기본) | `FakeAiPipeline` — 테스트·개발 |
| `http` | `HttpAiPipeline` — `AI_PROVIDER_URL` 필수 |

잘못된 값이나 URL 누락은 **즉시 실패**한다(fail-closed).

| 환경 변수 | 기본 | 설명 |
| --- | --- | --- |
| `AI_PROVIDER_URL` | — | provider base URL |
| `AI_PROVIDER_TOKEN` | 없음 | `Authorization: Bearer` |
| `AI_PROVIDER_TIMEOUT_MS` | 120000 | 요청 타임아웃 |
| `AI_EMBEDDING_DIM` | 768 | D-05 확정 차원. 다르면 응답 거부 |
| `AI_PROVIDER_NAME` / `AI_PROVIDER_MODEL` | http / unknown | 메타데이터 기본값 |

## 2. `POST /v1/analyze`

`multipart/form-data`:

| part | 타입 | 내용 |
| --- | --- | --- |
| `metadata` | `application/json` | 아래 메타데이터 |
| `audio` | `application/octet-stream` | 원본 오디오 바이트 |

```json
{
  "recording": {
    "id": "0199...",
    "clientRecordingId": "GYL-1:boot:42",
    "startedAt": "2026-11-14T09:12:00.000Z",
    "endedAt": "2026-11-14T09:46:00.000Z",
    "durationMs": 2040000,
    "codec": "wav_ima_adpcm",
    "codecParams": null,
    "sampleRateHz": 16000,
    "channels": 1,
    "byteSize": 384000,
    "sha256": "....64 hex...."
  },
  "expected": { "textEmbeddingDim": 768, "language": "ko" }
}
```

응답 `200 application/json` 은 **`AnalysisResult`** 와 같은 형태다
(`docs/10-domain-model.md` §3, `apps/api/src/domain/types.ts`):

```json
{
  "title": "북한산 등산 계획",
  "summary": "주말에 북한산에 오르기로 했다.",
  "language": "ko",
  "status": "ready",
  "speakers": [{ "label": "SPEAKER_1", "personName": "김민수", "confidence": 0.93 }],
  "segments": [{ "seq": 0, "startMs": 0, "endMs": 1000, "text": "...", "speakerLabel": "SPEAKER_1", "confidence": 0.9 }],
  "entities": [{ "kind": "place", "value": "북한산", "normalizedValue": "북한산", "confidence": 0.9, "segmentSeq": 0 }],
  "actionItems": [{ "title": "토요일 출발 준비", "dueAt": "2026-11-21T00:00:00Z", "confidence": 0.7, "entityIndex": null }],
  "embedding": { "provider": "mock", "model": "mock-embed", "dim": 768, "vector": [0.1, "…768개…"] },
  "pipeline": { "provider": "mock", "model": "mock-v1", "stages": { "stt": "ok" } }
}
```

검증 규칙(서버가 강제):

- `embedding.vector.length == AI_EMBEDDING_DIM` (기본 768)
- `status ∈ {ready, partial}`, `speakers/segments/entities/actionItems` 배열
- `actionItems[].dueAt` 은 ISO 8601 문자열 또는 null
- 하나라도 어긋나면 `AI_INVALID_RESPONSE`(재시도 불가)

## 3. `POST /v1/embed`

```json
{ "text": "북한산", "dim": 768 }
```

응답:

```json
{ "vector": [0.1, "…768개…"] }
```

차원이 다르면 거부한다. 검색 쿼리와 저장 임베딩은 같은 모델·차원이어야 한다(ADR-0009).

## 4. 오류·재시도

| 상황 | 코드 | 재시도 |
| --- | --- | --- |
| 연결 실패 | `AI_UNREACHABLE` | 가능 |
| 타임아웃 | `AI_TIMEOUT` | 가능 |
| 5xx / 429 | `AI_PROVIDER_ERROR` | 가능 |
| 4xx | `AI_PROVIDER_ERROR` | **불가** |
| JSON/스키마 오류 | `AI_INVALID_RESPONSE` | **불가** |

- 재시도 횟수·백오프는 분석 작업 큐가 결정한다(ADR-0007, 기본 3회).
- `AiProviderError.retryable=false` 이면 워커가 첫 시도에 `failed` 로 종료한다.
- provider 는 **부분 결과를 반환하지 않는다.** 실패하면 오류로 끝낸다(fail-closed).

## 5. 보안·개인정보

- 원본 오디오는 민감 정보다. TLS 필수, provider 측 보존 정책을 계약에 명시한다(D-13).
- 서버는 오디오/응답 본문을 로그에 남기지 않는다. `docs/09-observability.md` 참조.
- provider 토큰은 환경 변수/비밀 관리로만 주입한다. 저장소 커밋 금지.

## 6. 실제 provider 연결 시

1. provider 서비스가 위 계약을 구현한다.
2. `GYEOL_AI=http`, `AI_PROVIDER_URL`, `AI_PROVIDER_TOKEN` 을 설정한다.
3. 모델·차원이 D-05(768)와 다르면 재임베딩 전략을 먼저 적용한다(ADR-0009).
4. `ENV-05` 를 실제 응답·지연·비용 측정으로 닫는다.
