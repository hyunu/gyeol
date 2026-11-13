# ESP32-S3 개발 보드 펌웨어 (W-21/W-22 개발 변형)

스펙의 웨어러블은 **XIAO nRF52840 Sense** 이지만 아직 확보되지 않았다. 현재 연결된
**ESP32-S3 (8MB PSRAM)** 보드로 BLE 프로토콜·PDM 녹음·저장·이어받기를 먼저 검증한다.
프로토콜과 WAV 형식은 MCU 독립적이므로 nRF52840 포팅 시에도 그대로 쓴다.

## 하드웨어

| 항목 | 값 |
| --- | --- |
| 칩 | ESP32-S3 QFN56 rev v0.2, 8MB PSRAM |
| USB | USB-Serial/JTAG (`303A:1001`), `/dev/cu.usbmodem1101` |
| PDM 마이크 | CLK GPIO42, DATA GPIO41 |
| microSD | CS 21, SCK 7, MISO 8, MOSI 9 (카드 미삽입 시 LittleFS 폴백) |

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

## 현재 한계

- **VAD 없음**: 부팅 시 5초를 한 번 녹음한다. 에너지 기반 VAD·프리롤·무음 컷은 다음 작업.
- **nRF52840 아님**: 스펙 대상 보드가 아니므로 `HW-PENDING` 은 유지한다.
- **microSD 미검증**: 카드가 없어 LittleFS 로 대체했다. SD 핀·전원·내구성은 실카드로 확인해야 한다.
- **전원 차단 복구**: LittleFS 저널링에 의존한다. 전원 차단 리허설은 별도 측정이 필요하다.
- **iOS 실기기 미연동**: `apps/ios` 는 시뮬레이터 빌드까지만 확인했다.

## 다음

1. VAD(에너지 임계값 + 프리롤 0.5s + 무음 2s 종료)와 파일 분할.
2. microSD 카드 삽입 후 마운트·전원 차단 복구 리허설.
3. nRF52840 Sense 포팅(PDM/TWI·BLE 스택 차이).
4. iOS 실기기에서 CoreBluetooth 전송 E2E.
