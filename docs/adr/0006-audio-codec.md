# ADR 0006 — 기기 저장·전송 코덱은 IMA ADPCM, 테스트 기준은 WAV PCM

- 상태: **제안** (사용자 승인 대기)
- 날짜: 2026-11-14
- 관련: D-04, R-020~R-022, `packages/hardware-adapter/port.ts`, `recordings.codec`

## 맥락

웨어러블은 VAD 로 음성 구간만 16 kHz mono 로 녹음해 microSD 에 저장하고 BLE 로 폰에 넘긴다.
폰이 STT·화자분리·요약을 수행하므로, 기기 쪽 제약은 다음과 같다.

- MCU: nRF52840 (Cortex-M4F, 256 KB RAM, 1 MB flash) — Opus **인코더**를 돌리기 어렵다.
- 저장: microSD 8 GB, VAD 로 음성 구간만 저장하므로 연속 녹음이 아니다.
- 전송: BLE 처리량이 병목이다. 파일이 4배 작으면 전송 시간도 4배 줄어든다.
- 무결성: `recordings.sha256` 은 **저장된 바이트** 기준이므로 코덱과 무관하게 유지된다.

## 측정 (2026-11-14)

`npm run codec:measure` (ffmpeg, 16 kHz mono, 60초, 실제 파일 크기)

| 코덱 | `codec` 값 | 60초 크기 | kbps | MB/시간 | 8 GB 연속 저장 |
| --- | --- | ---: | ---: | ---: | ---: |
| WAV PCM s16le | `wav_pcm_s16le` | 1875.1 KiB | 256.0 | 115.2 | 69시간 |
| WAV IMA ADPCM | `wav_ima_adpcm` | 471.1 KiB | 64.3 | 28.9 | 276시간 |
| Opus 12 kbps | `opus_ogg_12k` | 88.9 KiB | 12.1 | 5.5 | 1464시간 |
| Opus 16 kbps | `opus_ogg_16k` | 102.7 KiB | 14.0 | 6.3 | 1267시간 |
| Opus 24 kbps | `opus_ogg_24k` | 172.8 KiB | 23.6 | 10.6 | 753시간 |
| Opus 32 kbps | `opus_ogg_32k` | 228.3 KiB | 31.2 | 14.0 | 570시간 |

- 측정치는 압축률 비교용이다. 음성 품질(WER)은 실기기·실음성으로 측정해야 한다(`HW-PENDING`).
- VAD 게이팅으로 실제 저장량은 위 "연속 저장"보다 훨씬 적다(무음 구간 미저장).

## 검토한 선택지

| 선택지 | 장점 | 단점 | 판단 |
| --- | --- | --- | --- |
| WAV PCM 유지 | 구현·검증 최소, AI provider 호환 최고 | 전송·저장 4배, BLE 병목 | 테스트 기준으로 유지 |
| **IMA ADPCM** | 4:1, 정수 연산으로 MCU 구현 가능, WAV 컨테이너 재사용 | 품질 손실, 폰에서 PCM 변환 필요 | **기기 기본값으로 제안** |
| Opus | 압축률 최고, 표준 | nRF52840 인코더 비현실적, 툴체인·RAM 부담 | 폰→서버 구간에서만 선택 |
| FLAC | 무손실 | 압축률 낮고 MCU 인코더 부담 | 제외 |

## 결정 (제안)

1. **기기 저장·BLE 전송 기본 코덱은 `wav_ima_adpcm`** (16 kHz, mono, 4-bit IMA).
2. **Phase 1 테스트·계약 기준은 `wav_pcm_s16le` 유지** — Fake 기기와 기존 예제를 바꾸지 않는다.
3. 폰은 수신 후 필요 시 WAV PCM 으로 디코드해 AI pipeline 에 넣는다.
4. 서버 업로드 구간은 필요하면 폰에서 Opus 로 트랜스코드할 수 있다(기기 코덱과 독립).
5. `recordings.codec` 은 자유 문자열이므로 스키마 변경은 없다. 값은 `wav_pcm_s16le`,
   `wav_ima_adpcm`, `opus_ogg_16k` 처럼 `컨테이너_코덱_비트레이트` 규칙을 쓴다.

## 결과

- 저장 용량: 8 GB 기준 연속 69시간 → 276시간(4배).
- BLE 전송: 같은 음성 구간을 1/4 시간에 전송.
- 추가 작업:
  - 펌웨어 IMA 인코더 + 폰 디코더 (`HW-PENDING`, W-21/W-23)
  - 품질 측정: 한국어 음성에서 WER 저하가 허용 범위인지 확인
  - VAD 파라미터(D-09)와 함께 실제 저장량 측정
- 되돌리기 비용: `codec` 이 자유 문자열이고 무결성은 바이트 기준이므로, 기기·폰 양쪽
  기본값만 바꾸면 된다. 이미 업로드된 녹음은 `codec` 값으로 구분한다.

## 승인 필요

이 문서는 제안이다. 승인 시 `docs/10-domain-model.md` D-04 를 `확정`으로 바꾸고
`packages/hardware-adapter/port.ts` 주석과 Fake 기기 기본값을 갱신한다.
