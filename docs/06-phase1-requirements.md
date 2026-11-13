# Phase 1 요구사항 (웨어러블 대화 기억)

- 기준 문서: `MEMORIAL_PROJECT_SPEC.md` v1.0 (2026-11-13 확정)
- 설계: `docs/10-domain-model.md` v1.1 (확정)
- 상태 코드: `01-requirements.md` §1 과 동일

## 1. 기능 요구사항

| ID | 요구사항 | 검증 방법 | 상태 |
| --- | --- | --- | --- |
| R-020 | 웨어러블은 상시 샘플링하고 VAD 로 음성 구간을 판별해 전후 버퍼를 포함해 녹음한다. | Fake 는 WAV 생성만 대체. 실제 VAD 는 펌웨어 검증 필요 | `HW-PENDING` |
| R-021 | 스마트폰이 없어도 microSD 에 독립 저장을 계속한다. | Fake 기기 오프라인 누적 테스트 통과 | `HW-PENDING` (Fake 검증 완료) |
| R-022 | BLE 전송은 ACK·재전송·이어받기를 지원한다. | GATT 프레임 계약 + 시뮬레이터 9건 통과(`docs/12-ble-protocol.md`). 실기기는 `HW-PENDING` | `HW-PENDING` (계약·시뮬레이터 완료) |
| R-023 | 폰은 STT·화자분리·화자식별·대화구성·요약·정보추출·검색데이터 생성 파이프라인을 실행한다. | Fake AI Pipeline + 비동기 작업 큐(ADR-0007)로 전 구간 통과, 실제 provider 는 ENV-05 | `WIP` |
| R-024 | 결과는 서버에 저장되고 웹에서 날짜별·인물별·요약·검색이 가능하다. | 웹 대시보드(`apps/web`) + Playwright E2E 6건 (날짜·인물·키워드·딥링크·모바일) | `DONE` |
| R-025 | 하드웨어 의존 코드는 Hardware Adapter 인터페이스 뒤에 두고 Fake Adapter 로 테스트한다. | `packages/hardware-adapter/port.ts` + Fake 통과 | `DONE` |
| R-026 | AI 엔진은 Provider Adapter 구조로 교체 가능해야 한다. | `AiPipeline` 포트 + Fake 구현 | `DONE` |
| R-027 | OpenAPI 계약을 먼저 정의하고 구현을 자동 검증한다. | `npm run check` (계약+계약테스트) | `DONE` |
| R-028 | 녹음(원본)과 AI 분석(파생)의 생명주기를 분리한다. | 재분석 시 파생 교체·원본 유지 테스트 | `DONE` |
| R-029 | 원본 음성은 서버 저장·무결성 검증 전까지 삭제하지 않는다. | ACK 전 삭제 거부·로컬 삭제 차단 테스트 | `DONE` |
| R-030 | 화자 식별이 불확실하면 Unknown Speaker 로 처리한다. | 임계값/격차 테스트 + person 미생성 확인 | `DONE` |
| R-031 | 개인정보 보호·암호화·삭제·내보내기를 고려한다. | 설계 문서 반영, 암호화·내보내기 미구현 | `WIP` |
| R-032 | PostgreSQL + pgvector 스키마와 마이그레이션을 작성한다. | `db/migrations/0001_init.sql` + 적용·제약 검증 | `DONE` |
| R-033 | Recording API (등록·업로드·상태)를 구현한다. | 계약 테스트 + 통합 테스트 12~16 | `DONE` |
| R-034 | Conversation API (조회·검색·인물별)를 구현한다. | 통합 테스트 7~9 | `DONE` |
| R-035 | Fake Hardware + Fake Mobile 로 전체 데이터 흐름을 통합 검증한다. | `tests/integration.test.ts` 5건 | `DONE` |
| R-036 | Wi-Fi 직접 업로드는 Phase 1 범위에서 제외하고 확장으로만 설계한다. | 범위 문서 | `N/A` |
| R-037 | QR 추모 페이지·헌화·방문 기록은 이번 단계에서 개발하지 않는다. | 범위 문서 | `N/A` |

## 2. 비기능 요구사항

| ID | 요구사항 | 비고 |
| --- | --- | --- |
| N-01 | 기기 오프라인 중 데이터 유실 0건 | 로컬 저장 우선 |
| N-02 | 업로드 재개 시 중복 바이트 없음 | 오프셋 기반 |
| N-03 | 무결성 불일치 데이터는 분석에 투입하지 않음 | `stored` 전 분석 금지 |
| N-04 | 모든 조회는 소유자 스코프 | 타 사용자 접근 404 |
| N-05 | 분석 재현 가능 | `pipeline` 메타데이터 기록 |

## 3. Phase 1 완료 조건

1. `npm run check` 통과 (계약 + 타입 + 단위/통합) — **충족 (43 tests)**
2. Fake Device → Fake Mobile → API → Fake AI → Conversation 조회/검색 전 구간 통과 — **충족**
3. 전송 중단 → 재개 시나리오 통과 (바이트 무손실, 해시 일치) — **충족**
4. `stored` 이전 삭제 요청이 거부되는 테스트 존재 — **충족**
5. 마이그레이션을 빈 DB 에 적용해 스키마가 재현됨 — **충족 (2026-11-14, ENV-01)**
6. 실제 하드웨어·iPhone 항목은 `HW-PENDING` 으로 분리 (완료 표기 금지) — **충족**

> 완료 조건 1~6 이 모두 충족됐다. 단 실물·실 provider 검증(ENV-03~05)은 여전히 대기이며,
> 이후 작업은 `docs/08-work-order.md` 를 따른다.

## 4. 결정 반영

없음. 실제 착수 순서는 `docs/08-work-order.md` 를 따른다.

## 5. 검증 근거

`docs/07-verification-log.md` 참조.
