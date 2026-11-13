# MEMORIAL PROJECT SPEC

- 최상위 개발 기준 문서
- 원문 출처: 사용자 제공 (2026-11-13)
- 상태: **Phase 1 확정** (이후 변경은 변경 이력에 기록)

## 1. 핵심 시나리오

사용자가 Memorial 웨어러블을 착용하면 주변의 음성을 자동으로 감지하고 대화 구간을 녹음한다.

- 녹음 데이터는 웨어러블 내부 저장장치에 보관되며, 스마트폰이 연결되면 BLE 를 통해 전송된다.
- iPhone 앱은 수신한 음성을 저장하고 다음 AI 처리를 수행한다.
  음성 인식(STT), 화자 분리(Diarization), 화자 식별(Speaker Identification),
  대화 단위 구성, 대화 요약, 인물·장소·일정·약속·할 일 추출, 키워드·의미 기반 검색용 데이터 생성
- 처리 결과는 서버에 저장되며, 사용자는 웹 대시보드에서 날짜별 대화, 인물별 기록, 요약 및
  검색을 이용한다.
- 스마트폰이 없을 때도 웨어러블은 독립적으로 녹음하고 저장해야 한다.

## 2. 하드웨어 구성 및 데이터 인터페이스

### 2.1 기본 하드웨어

| 항목 | 내용 |
| --- | --- |
| MCU | Seeed Studio XIAO nRF52840 Sense |
| 마이크 | 보드 내장 PDM MEMS Microphone |
| 저장장치 | 8GB microSD |
| 무선통신 | BLE |
| 배터리 | LiPo 500mAh (초기 후보) |
| 외형 | Oval, Matte 표면 |
| 착용 방식 | 소형 웨어러블 펜던트 |

### 2.2 웨어러블 동작

1. 마이크는 상시 음성 샘플링한다.
2. VAD 로 음성 구간을 판별한다.
3. 음성 구간과 앞뒤 버퍼를 포함하여 녹음한다.
4. 녹음 파일은 microSD 에 저장한다.
5. BLE 로 스마트폰에 파일을 전송한다.
6. 스마트폰이 없으면 로컬 저장을 계속한다.
7. 파일 전송 중 연결이 끊기면 재연결 후 이어서 전송한다.

### 2.3 스마트폰 역할

- BLE 자동 연결 및 파일 수신
- 로컬 음성 파일 관리
- AI 처리 파이프라인 실행
- 서버 업로드 및 동기화
- 웨어러블 설정 및 상태 관리

### 2.4 향후 확장 (Phase 1 범위 아님)

충전 중 등록된 집 Wi-Fi 로 웨어러블이 서버에 직접 업로드하는 기능. 현재 MCU(nRF52840)에는
Wi-Fi 가 없으므로 ESP32-C3 등 추가 모듈이 필요하다.

하드웨어 구현에 종속되지 않도록 **Hardware Adapter 인터페이스**를 정의하고 Fake Adapter 로
테스트할 수 있어야 한다.

## 3. 기술 스택

| 영역 | 스택 |
| --- | --- |
| Backend | Node.js, TypeScript, REST API, OpenAPI 계약 우선, PostgreSQL, pgvector, Object Storage |
| Mobile | iOS 우선, Swift/SwiftUI, CoreBluetooth, AVFoundation, 로컬 DB·파일 저장소, AI 모듈은 독립 인터페이스 |
| Firmware | C/C++, nRF Connect SDK/Zephyr, PDM Audio Capture, VAD, microSD, BLE GATT |
| Web | TypeScript, React, REST 연동, 대화 타임라인·검색 UI |
| AI | STT, Speaker Diarization, Speaker Identification, Summarization, Entity/Action Extraction, Semantic Search — **Provider Adapter 구조** |

## 4. 핵심 엔티티

`User`, `Device`, `Recording`, `Conversation`, `Person`
+ 하위: `TranscriptSegment`, `SpeakerEmbedding`, `ExtractedEntity`, `ActionItem`

## 5. 개발 원칙

- 기존 Phase 0b 구현 및 API 계약을 유지한다.
- OpenAPI 계약을 먼저 정의하고 구현과 자동 검증한다.
- 실제 하드웨어 없이 Fake Adapter 로 전체 데이터 흐름을 검증한다.
- 녹음 데이터와 AI 분석 데이터의 **생명주기를 분리**한다.
- BLE 전송은 ACK, 재전송, 이어받기를 지원한다.
- AI 분석 결과는 원본 데이터와 분리하여 저장한다.
- 화자 식별이 불확실하면 Unknown Speaker 로 처리한다.
- 원본 음성 파일은 서버 저장 및 무결성 검증 전까지 삭제하지 않는다.
- 개인정보 보호, 암호화, 데이터 삭제 및 내보내기를 고려한다.
- 확정되지 않은 사항은 임의로 확정하지 말고 **TBD** 로 기록한다.

## 6. Phase 1 개발 목표 (순서)

1. 도메인 모델 및 ERD
2. OpenAPI 계약 확장
3. PostgreSQL 마이그레이션
4. 도메인 코어 및 유스케이스
5. Recording 및 Conversation API
6. Fake Hardware Adapter
7. Fake Mobile Client
8. 통합 테스트

실제 하드웨어 연결은 이후 단계. **QR 기반 추모 페이지, 헌화 기록, 방문 기록 등은 이번 단계에서
개발하지 않는다.**

## 7. 변경 이력

| 버전 | 날짜 | 변경 |
| --- | --- | --- |
| 1.0 | 2026-11-13 | 사용자 제공 원문으로 확정 (자리표시자 초안 대체) |
