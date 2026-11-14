# ESP32-S3 개발 보드 펌웨어 (W-21/W-22 개발 변형)

스펙의 웨어러블은 **XIAO nRF52840 Sense** 이지만 아직 확보되지 않았다. 현재 연결된
**ESP32-S3 (8MB PSRAM)** 보드로 BLE 프로토콜·PDM 녹음·저장·이어받기를 먼저 검증한다.
프로토콜과 WAV 형식은 MCU 독립적이므로 nRF52840 포팅 시에도 그대로 쓴다.

## 하드웨어

| 항목 | 값 |
| --- | --- |
| 보드 | **XIAO ESP32S3 + XIAO ESP32S3 Exp. Board v1.1** (Sense 키트) |
| 칩 | ESP32-S3 QFN56 rev v0.2, 8MB PSRAM |
| USB | USB-Serial/JTAG (`303A:1001`), `/dev/cu.usbmodem1101` |
| PDM 마이크 | CLK GPIO42, DATA GPIO41 |
| microSD | CS 21, SCK 7, MISO 8, MOSI 9 (마운트 실패 시 LittleFS 폴백) |

## 빌드·업로드

```bash
cd firmware/esp32s3
~/.platformio/penv/bin/pio run
~/.platformio/penv/bin/pio run -t upload --upload-port /dev/cu.usbmodem1101
```

시리얼 로그(115200):

```bash
~/.platformio/penv/bin/python - <<'PY'
import serial, time
s = serial.Serial('/dev/cu.usbmodem1101', 115200, timeout=1)
end = time.time() + 10
while time.time() < end:
    line = s.readline()
    if line: print(line.decode(errors='replace').rstrip())
PY
```

## BLE 전송 검증 (macOS)

폰(수신) 역할을 하는 프로브가 실제 GATT 로 파일을 받아 SHA-256 을 확인한다.

```bash
~/.platformio/penv/bin/pip install bleak
~/.platformio/penv/bin/python tools/ble_probe.py --output /tmp/gyeol.wav

# 중단·재개
~/.platformio/penv/bin/python tools/ble_probe.py --output /tmp/gyeol.wav --stop-after 50000
~/.platformio/penv/bin/python tools/ble_probe.py --output /tmp/gyeol.wav
```

2026-11-14 실측: 160,300 bytes, SHA-256 일치, 중단(50,160 bytes) 후 재개 성공, 약 14초.

## VAD

- 20ms 프레임 에너지, 0.5초 프리롤, 3프레임 연속 임계 초과 시 시작, 2초 무음 시 종료.
- 임계값은 캘리브레이션 뒤쪽 10프레임의 노이즈 플로어 × 1.6 (최소 400).
- 부팅 시 파일이 없으면 VAD 녹음을 시도하고, 음성이 없으면 테스트 톤을 만든다.
- 시리얼에서 `r` 을 보내면 수동으로 VAD 녹음을 시작한다(BLE 미연결 상태).

> 테스트 시 **Exp. Board 가 분리된 상태**였거나 microSD 카드가 없어 SD 마운트가 실패하고
> PDM 입력이 무음(에너지 ~1400)이었다. 핀은 Seeed 문서와 일치한다(PDM 42/41, SD CS 21).
> 확장 보드를 완전히 결합하고 FAT32 microSD 를 넣은 뒤 재검증해야 한다.

## 현재 한계

- **PDM/VAD 실입력 미검증**: Exp. Board 결합 상태에서 마이크 입력을 다시 확인해야 한다.
- **microSD 미검증**: 카드 미삽입/확장 보드 분리로 LittleFS 로 대체했다.
- **nRF52840 아님**: 스펙 대상 보드가 아니므로 `HW-PENDING` 은 유지한다.
- **microSD 미검증**: 카드가 없어 LittleFS 로 대체했다. SD 핀·전원·내구성은 실카드로 확인해야 한다.
- **전원 차단 복구**: 리셋(재플래시) 후 동일 파일에서 이어받기를 확인했다. 실제 전원 차단은 별도 측정.
- **iOS 실기기 미연동**: `apps/ios` 는 시뮬레이터 빌드까지만 확인했다.

## 다음

1. Exp. Board 결합 + FAT32 microSD 삽입 후 PDM·microSD 재검증.
2. 전원 차단 리허설, VAD 임계값 실측 튜닝, 파일 분할.
3. nRF52840 Sense 포팅(PDM/TWI·BLE 스택 차이).
4. iOS 실기기에서 CoreBluetooth 전송 E2E.
