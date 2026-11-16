# 릴리스 체크리스트 (W-29)

- 기준: `MEMORIAL_PROJECT_SPEC.md` v1.0, 계약 버전 **0.2.0**
- 최종 판정: **NO-GO** — 로컬 수용 테스트는 통과했지만 실물·실 provider·배포 자격 증명이 남아 있다.
- 실행: `make acceptance` (내부적으로 `npm run acceptance -- --with-ios`)

## 1. 로컬 수용 테스트 (2026-11-14)

| 검증 | 결과 | 시간 |
| --- | --- | ---: |
| 계약 + 타입 + 단위/통합 (53 tests) | PASS | 3.1s |
| DB 마이그레이션 제약 (4 files) | PASS | 0.4s |
| PostgreSQL 패리티 (20 tests) | PASS | 2.3s |
| S3/MinIO 스토리지 (7 tests) | PASS | 1.5s |
| 웹 E2E (6 tests) | PASS | 7.2s |
| Swift BLE 패키지 (13 tests) | PASS | 3.9s |
| 펌웨어 빌드 (ESP32-S3) | PASS | 2.1s |
| iOS 시뮬레이터 빌드 | PASS | 4.0s |

- **8/8 통과**, 오류 0. 실행 로그는 CI/로컬에서 재현한다.

### 2026-11-16 재실행

현재 코드 기준으로 `npm run acceptance -- --with-ios` 를 다시 돌렸다. 이 환경에는 Docker 와
PlatformIO 가 없어 DB·S3·펌웨어 항목은 SKIP 이다.

| 검증 | 결과 | 시간 |
| --- | --- | ---: |
| 계약 + 타입 + 단위/통합 (56 tests) | PASS | 2.7s |
| 웹 E2E (6 tests) | PASS | 5.4s |
| Swift BLE 패키지 (34 tests) | PASS | 2.9s |
| iOS 시뮬레이터 빌드 | PASS | 12.6s |
| DB 마이그레이션 제약 | SKIP (DATABASE_URL 없음) | — |
| PostgreSQL 패리티 | SKIP (DATABASE_URL 없음) | — |
| S3/MinIO 스토리지 | SKIP (S3_ENDPOINT 없음) | — |
| 펌웨어 빌드 (ESP32-S3) | SKIP (PlatformIO 없음) | — |

- **4 통과, 4 건너뜀, 0 실패.** 수용 러너는 이제 필수 도구 부재를 FAIL 이 아니라 SKIP 으로
  표시한다. DB·S3·펌웨어 포함 8/8 판정은 해당 도구가 있는 환경에서 다시 확인해야 한다.
- 테스트 수는 2026-11-16 기준 TS **56** · Swift **34** 으로 갱신됐다.
- 성능 기준선: 목록 p95 14.9ms, 상세 16.8ms, 검색 19.7ms (120건·동시성 20).

## 2. 릴리스 차단 목록 (NO-GO 사유)

| # | 차단 항목 | 현재 상태 | 해소 조건 |
| ---: | --- | --- | --- |
| 1 | **nRF52840 Sense 실물** | ESP32-S3 개발 보드만 연결. SD/PDM 미동작(Sense 변형 아님 가능성) | Sense 보드에서 PDM·microSD·VAD 실측 (W-21) |
| 2 | **iOS 실기기 E2E** | 시뮬레이터 빌드만. 연결된 iPhone 없음 | 실기기에서 Sign in with Apple + BLE 전송 + 서버 업로드/ACK/분석 (W-24) |
| 3 | **Apple 실 토큰 검증** | Fake verifier 로 서버 경로만 검증 (ENV-09). 웹 Apple JS 로그인 UI 는 구현 | App ID/Service ID 등록 + 실제 identity token 으로 서버·웹 E2E |
| 4 | **In-House 배포 인증서** | Apple Distribution 인증서 없음 | 팀 관리자가 인증서 발급·설치 |
| 5 | **실제 AI provider** | HTTP 계약·mock 테스트만 (ENV-05) | provider 선정·키·비용/데이터 정책, 실측 |
| 6 | **10k 규모 성능** | 120건 기준선만 | 10,000건·TLS·프록시·다중 인스턴스 측정 |
| 7 | **운영 S3/AWS** | MinIO 로컬만 (ENV-08) | 운영 버킷·권한·수명주기·복제 리허설 |
| 8 | **주변인 녹음 동의(D-14)** | TBD | 고지·법무 검토, 기기 LED/음성 안내 |
| 9 | **한국어 검색(D-07)** | ILIKE 기준선 | 전문검색/토크나이저 결정·측정 |
| 10 | **보안 검토** | 세션·소유자 스코프·감사 구현 | 외부 검토(인증·암호화·삭제) |

## 3. 배포 전 필수 확인

- [ ] `make acceptance` 8/8 통과
- [ ] 마이그레이션 `0001~0004` 빈 DB 적용 + `db:checks`
- [ ] 백업/복구 리허설 (`docs/11-backup-restore.md`) 최신 백업으로 재실행
- [ ] `npm run purge` 가 기대 건수만 삭제하는지 확인
- [ ] `/healthz` 의 `db`·`storage` = `ok`
- [ ] `/metrics` 수집·알림 연결 (`docs/09-observability.md`)
- [ ] Apple/운영 자격 증명이 저장소에 없는지 확인
- [ ] 계정 삭제·내보내기 수동 시나리오 1회
- [ ] 실기기 BLE 전송·중단 재개·재부팅 재개 1회

## 4. 롤백·사고 대응

| 상황 | 대응 |
| --- | --- |
| 마이그레이션 실패 | 트랜잭션 롤백 확인 후 이전 이미지로 복구, DB는 백업에서 복원 |
| 배포 후 5xx 급증 | 이전 버전 롤백, `/metrics`·로그 traceId 로 원인 확인 |
| 데이터 삭제 사고 | 백업 복구 절차(`docs/11`) + 감사 로그(`audit_events`)로 범위 확인 |
| 원본 유출 의심 | 세션 전체 폐기(`revokeUserSessions`), 원본 purge, 감사 기록 |

## 5. 서명

| 역할 | 이름 | 판정 |
| --- | --- | --- |
| 제품 |  | 보류 |
| 개발 |  | 로컬 검증 완료 |
| 법무/개인정보 |  | D-14 대기 |

> 위 차단 목록이 해소되고 서명이 완료될 때까지 **배포하지 않는다.**
