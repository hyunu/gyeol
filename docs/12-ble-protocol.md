# BLE GATT 전송 프로토콜 (W-20)

- 상태: **계약 확정** (2026-11-14)
- 구현: `packages/ble-protocol/` · 테스트: `tests/ble-protocol.test.ts`
- 관련: R-022, `packages/hardware-adapter/port.ts`, W-21~W-24(`HW-PENDING`)

> 이 문서는 기기(웨어러블)–폰 사이의 **바이트 계약**이다. 펌웨어와 iOS 는 같은
> 프레임 인코더/디코더를 구현해야 한다.

## 1. GATT

| 역할 | UUID | 속성 |
| --- | --- | --- |
| Service | `8f2d0001-7b1e-4c3a-9f4d-5a6b7c8d9e01` | primary |
| TX (기기→폰) | `8f2d0002-7b1e-4c3a-9f4d-5a6b7c8d9e01` | Notify |
| RX (폰→기기) | `8f2d0003-7b1e-4c3a-9f4d-5a6b7c8d9e01` | Write Without Response |

- 폰은 TX 의 CCCD 를 구독한다.
- MTU 247 권장. BLE 알림은 **244바이트(MTU 247 - ATT 3)까지만** 전달되므로, 프레임 전체가 244바이트를 넘지 않아야 한다.
  DATA 프레임은 `16(헤더) + 8(오프셋) + chunk` 이므로 **chunk 220바이트**가 기본값이다.
- 프레임 하나가 characteristic 값 하나에 대응한다. 분할은 프레임 계층이 담당한다.

## 2. 프레임

| offset | size | field |
| --- | ---: | --- |
| 0 | 2 | magic `0x47 0x59` ("GY") |
| 2 | 1 | version = 1 |
| 3 | 1 | type |
| 4 | 1 | flags (bit0 `LAST`) |
| 5 | 1 | reserved = 0 |
| 6 | 4 | seq (uint32 BE, 연결 내 단조 증가) |
| 10 | 2 | payloadLength (uint16 BE) |
| 12 | 4 | crc32 (uint32 BE) |
| 16 | N | payload (≤512) |

- CRC32 는 IEEE 802.3(0xEDB88320), **헤더 0..11 + payload** 를 계산해 12..15 에 쓴다.
- 수신측은 magic/version/type/reserved/length/CRC 를 모두 검증하고 하나라도 틀리면 프레임을
  버리고 `ERROR(BAD_*)` 를 보낸다. 길이 불일치는 즉시 연결을 끊지 않는다(다음 프레임부터 복구).
- 최대 프레임 528바이트. 이보다 큰 값은 `PAYLOAD_TOO_LARGE`.

## 3. 메시지

`type` 값과 payload:

| type | 이름 | payload |
| ---: | --- | --- |
| 0x01 | `HELLO` | JSON `{serialNo, model?, firmwareVersion?, pendingFiles?}` |
| 0x02 | `HELLO_ACK` | JSON `{protocolVersion, chunkSizeBytes, maxFrameBytes}` |
| 0x03 | `LIST_REQ` | empty |
| 0x04 | `LIST_RES` | JSON `{files:[{clientRecordingId, byteSize, sha256}]}` |
| 0x05 | `OPEN_REQ` | JSON `{clientRecordingId}` |
| 0x06 | `OPEN_RES` | JSON `{clientRecordingId, startOffset, chunkSizeBytes}` |
| 0x07 | `DATA` | `offset(uint64 BE)` + bytes |
| 0x08 | `ACK` | JSON `{clientRecordingId, receivedBytes}` |
| 0x09 | `COMPLETE_REQ` | JSON `{clientRecordingId, byteSize, sha256}` |
| 0x0a | `COMPLETE_RES` | JSON `{clientRecordingId, status, receivedBytes}` |
| 0x0b | `ERROR` | JSON `{code, detail}` |

- 제어 메시지는 UTF-8 JSON, DATA 만 바이너리다.
- `sha256` 은 소문자 hex 64자다.
- `ACK.receivedBytes` 는 **누적 수신 바이트**(다음 기대 오프셋)다.
- `COMPLETE_RES.status`: `ok` | `mismatch` | `duplicate`.

## 4. 흐름

```text
기기(송신)                         폰(수신)
  HELLO                  ─────▶
                         ◀─────  HELLO_ACK
  OPEN_REQ(id)           ─────▶
                         ◀─────  OPEN_RES(startOffset)
  DATA(offset, bytes)    ─────▶   (창 크기 8)
                         ◀─────  ACK(receivedBytes)
  ...                            (offset == receivedBytes 일 때만 저장)
  COMPLETE_REQ(size, sha)─────▶
                         ◀─────  COMPLETE_RES(ok|mismatch|duplicate)
```

규칙:

1. **OPEN 없이 DATA 금지** → `ERROR(NO_OPEN_FILE)`.
2. `offset == 현재 길이` 일 때만 append. `offset < 길이` 는 중복 → 저장하지 않고 ACK.
3. `offset > 길이` 는 갭 → 저장하지 않고 현재 길이를 ACK(송신측이 그 지점부터 재전송).
4. `COMPLETE_REQ` 에서 크기와 SHA-256 을 모두 검증한다. 하나라도 다르면 `mismatch`.
5. 이미 완료된 파일의 `COMPLETE_REQ` 는 `duplicate` 로 응답한다(멱등).

## 5. 재전송·이어받기

| 파라미터 | 값 | 의미 |
| --- | ---: | --- |
| `chunkSizeBytes` | 220 | DATA 1개 최대 바이트(OPEN_RES 로 협상, 프레임 ≤ 244) |
| `windowFrames` | 8 | ACK 없이 보낼 수 있는 DATA 수 |
| ACK timeout | 1000ms | 이 시간 동안 ACK 없으면 `onTimeout` |
| `maxRetries` | 5 | 초과 시 전송 실패 |

- ACK 는 누적이다. 송신측은 `nextOffset - acked` 가 창 크기를 넘지 않도록 DATA 를 보내고,
  ACK 가 오면 그만큼 창을 채운다.
- 수신측은 **매 프레임 ACK 하지 않아도 된다.** 8프레임(또는 LAST)마다 한 번 ACK 하면
  BLE 왕복 횟수가 줄어 전송이 빨라진다. 실측에서 160KB 기준 28s → 14s 로 줄었다.
- ACK 가 1초 이상 오지 않으면 송신측은 `acked` 지점부터 다시 보낸다(최대 6회).
- **이어받기**: `OPEN_REQ` 에 대해 폰이 저장 중인 부분 파일 길이를 `startOffset` 으로 돌려준다.
  기기는 그 지점부터 DATA 를 보낸다. 폰 앱이 재시작돼도 부분 파일을 유지해야 한다.
- 연결이 끊기면 진행 중인 전송은 `OPEN_REQ` 부터 다시 시작한다. 별도 재개 메시지는 없다.

## 6. 오류 코드

| code | 의미 |
| --- | --- |
| `BAD_MAGIC` / `UNSUPPORTED_VERSION` / `UNKNOWN_TYPE` | 프레임 형식 오류 |
| `BAD_CRC` | 무결성 실패 |
| `LENGTH_MISMATCH` / `PAYLOAD_TOO_LARGE` | 길이 오류 |
| `BAD_OFFSET` | uint64 범위/안전 정수 위반 |
| `NO_OPEN_FILE` | OPEN 없이 DATA |
| `UNEXPECTED_TYPE` | 수신기가 처리하지 않는 타입 |
| `TIMEOUT` / `RETRY_EXCEEDED` | ACK 타임아웃/재전송 한도 |
| `SHA_MISMATCH` / `size` 불일치 | `COMPLETE_RES.mismatch` |

## 7. 보안

- BLE LE Secure Connections + bonding 을 요구한다. 암호화되지 않은 링크에서는 파일 전송을
  시작하지 않는다.
- 기기 serial/model 은 `HELLO` 로 노출되지만, 파일 내용은 인증된 폰에만 전송한다.
- 앱 계층 서명은 두지 않는다(전송 무결성은 CRC + 완료 시 SHA-256). 기기–폰 신뢰는 BLE
  페어링에 의존한다.
- D-14(주변인 녹음 동의)는 이 계층의 범위가 아니다.

## 8. 구현과 테스트

`packages/ble-protocol/`:

- `frame.ts` — 인코더/디코더, CRC32, payload helper
- `transfer.ts` — `TransferSender`, `TransferReceiver`, `MemoryTransferStore`, `runTransfer`

`tests/ble-protocol.test.ts` (9건):

1. 프레임 왕복 + CRC/magic/version/length/크기 검증
2. 정상 전송(오프셋·SHA-256 일치)
3. DATA 유실 → ACK 갭으로 재전송
4. ACK 유실 → 타임아웃 재전송
5. 중간 절단 → 부분 오프셋부터 재개
6. 중복 DATA 무시 + ACK
7. 갭 DATA 거부 + ACK
8. SHA 불일치 → mismatch
9. 완료 파일 `LIST_RES` 메타데이터

## 9. 실기기 검증 (2026-11-14, ESP32-S3 개발 보드)

스펙 대상은 XIAO nRF52840 Sense 이지만, 연결된 **ESP32-S3(8MB PSRAM)** 로 계약을 먼저 검증했다
(`firmware/esp32s3/`).

| 항목 | 결과 |
| --- | --- |
| PDM 녹음 | 5초 16kHz mono WAV 160,256 bytes 생성(단, 입력은 무음에 가까움) |
| 저장 | SD 없음 → LittleFS 폴백. 재부팅 후 파일 유지 |
| BLE 전송 | 160,300 bytes, SHA-256 일치 |
| 중단·재개 | 50,160 bytes에서 끊고 재접속 → 나머지부터 재개, 최종 SHA 일치 |
| 재부팅 후 재개 | 기기를 재플래시/리셋한 뒤 같은 파일에서 재개, 최종 SHA 일치 |
| MTU | 알림 244 bytes(MTU 247). 청크 220 으로 프레임 244 이하 유지 |

- 프레임이 244바이트를 넘으면 ESP32 BLE 스택이 알림을 잘라 CRC 가 깨진다. **청크 220** 은
  이 제약에서 나온 값이다.
- 전송 시간은 160KB 기준 약 14초(재개 포함). ACK 배칭과 창 8 적용 후 측정했다.
- 보드는 **XIAO ESP32S3 + Exp. Board v1.1(Sense 키트)**. PDM 입력은 확인(peak 6706),
  microSD 는 카드 미삽입으로 LittleFS 를 사용했다. 실제 음성 VAD·SD 마운트는 재검증 대상이다.
- 실제 nRF52840·iOS CoreBluetooth·microSD 카드·VAD 는 아직 `HW-PENDING` 이다.
