# iOS 앱 (W-23/W-24)

- Team: `XR84FWAH7L` (LG Electronics Inc., Enterprise) — 사용자 승인됨
- Bundle ID: `com.lge.gyeol` (변경 시 `project.yml` 수정)
- Deployment target: iOS 17
- 생성: [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`project.yml`)

## 구성

| 파일 | 역할 |
| --- | --- |
| `Gyeol/ContentView.swift` | 로그인·대화 타임라인·상세·기기 화면 |
| `Gyeol/AuthController.swift` | Sign in with Apple → 서버 세션 |
| `Gyeol/APIClient.swift` | `/auth/apple`, `/conversations`, 기기·녹음·업로드·ACK·분석 |
| `Gyeol/UploadController.swift` | 기기 등록 → 녹음 생성 → 청크 PUT → `/ack` → `/analyze` 상태 머신 |
| `Gyeol/SessionStore.swift` | 토큰 Keychain 저장 |
| `Gyeol/BleCentral.swift` | CoreBluetooth 수신, ACK 배칭, 디스크 저장 |
| `Gyeol/DiskTransferStore.swift` | Documents/recordings 부분 파일·SHA |
| `Packages/GyeolBLE` | 프레임 코덱·수신기·스트림 재조립·WAV 메타데이터·업로드 계획 (Swift Package) |

## 빌드

```bash
cd apps/ios
xcodegen generate
xcodebuild -project Gyeol.xcodeproj -scheme Gyeol \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

실기기(무서명) 컴파일:

```bash
xcodebuild -project Gyeol.xcodeproj -scheme Gyeol -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/gyeol-ios-device CODE_SIGNING_ALLOWED=NO build
```

서명 포함 실기기 실행은 iPhone 을 연결하고 Xcode 에서 Team 을 확인한다. In-House 배포는
**Apple Distribution 인증서**가 추가로 필요하다(현재 로컬에 없음).

Swift 패키지 테스트(macOS):

```bash
swift test --package-path apps/ios/Packages/GyeolBLE
```

## 로컬 데모

Apple App ID 없이 UI·BLE 를 확인할 때 로그인 화면의 **로컬 데모로 시작**을 쓴다.
서버가 `GYEOL_ENV=local` 일 때만 `X-User-Id` 임시 인증이 허용된다(ADR-0003).
실기기에서는 로그인 화면의 서버 주소를 Mac LAN 주소(예: `http://192.168.0.9:8080`)로 바꾼다.

## Sign in with Apple

- `Gyeol.entitlements` 에 `com.apple.developer.applesignin` 포함.
- 서버 `APPLE_CLIENT_IDS` 에 `com.lge.gyeol` 을 넣어야 `aud` 검증이 통과한다.
- 시뮬레이터에서 Apple ID 로 로그인해 서버 세션을 받는 흐름까지 확인할 수 있다.
  (실제 기기·App ID 등록은 아직 `HW-PENDING`)

## BLE

- 서비스/특성 UUID 는 `docs/12-ble-protocol.md` 와 동일.
- notification 은 MTU 단위로 쪼개지므로 `BleFrameStream` 으로 재조립한다.
- 수신 파일은 `Documents/recordings` 에 부분 저장하며, 앱 재시작 후 `startOffset` 부터
  이어받는다.
- ACK 는 파일당 누적 수신 바이트 기준으로 4프레임(또는 LAST)마다 1회 보내 왕복을 줄인다.
  파일이 바뀌면 ACK 상태를 리셋한다.
- 연결이 끊기면 수신기의 현재 파일(`OPEN_REQ`) 상태도 리셋한다. 재연결 후에는 반드시
  `OPEN_REQ` 부터 시작하므로, 이전 파일에 새 DATA 가 붙지 않는다.

## 서버 업로드 (W-24)

기기 탭의 **완료 파일 올리기**가 아래 순서를 실행한다.

1. `HELLO` 의 `serialNo`·`model` 로 기기를 찾고, 없으면 `POST /api/v1/devices` 로 등록한다.
2. `POST /api/v1/recordings` 로 녹음을 등록한다(`deviceId + clientRecordingId` 멱등).
3. `PUT .../chunks?offset=` 로 256KB 이하 청크를 보낸다. 서버가 `409 OFFSET_MISMATCH` 를
   주면 `detail` 의 `expected=<n>` 지점부터 다시 보낸다.
4. 모든 바이트 전송 + 무결성 검증이 끝나면 `POST .../ack`, 이어서 `POST .../analyze`.
5. 파일별 진행 상태를 `UserDefaults` 에 저장해 앱을 재시작해도 등록·세션·오프셋을 재사용한다.
   세션이 만료되면 `POST .../upload-sessions` 로 새 세션을 발급받는다.

BLE `LIST_RES` 는 `clientRecordingId`·`byteSize`·`sha256` 만 준다. 나머지 등록 필드는
WAV 헤더에서 파생한다.

| 필드 | 출처 |
| --- | --- |
| `codec`·`sampleRateHz`·`channels` | WAV `fmt ` 청크 (PCM/IMA ADPCM) |
| `durationMs` | WAV `data` 바이트 ÷ `byteRate` |
| `startedAt` | 수신 시작 시각(파일 생성 시각) − `durationMs` (기기에 RTC 없음) |
| `endedAt` | `startedAt + durationMs` |

> `startedAt` 은 근사값이다. 기기 시계가 없으므로 BLE 전송이 녹음 직후가 아니면 실제
> 녹음 시각과 차이가 날 수 있다. 정확한 시각이 필요해지면 `LIST_RES` 확장 또는 기기 RTC
> 동기화를 별도 결정으로 다룬다.

## 확인된 것

- 시뮬레이터에서 앱 실행·로그인 화면 렌더 확인(2026-11-14).
- arm64 device 무서명 컴파일 확인.

## 현재 한계

- 실기기에서 CoreBluetooth 전송 E2E 를 아직 실행하지 않았다(컴파일·시뮬레이터·device 빌드만 확인).
- 실기기에서는 설정 탭에서 Mac 의 LAN 주소(예: `http://192.168.0.10:8080`)를 입력해야 한다.
- Sign in with Apple 은 App ID/Service ID 와 entitlement 가 필요하다.
- 웹 로그인(Service ID + client secret)은 별도 작업.
- 푸시·백그라운드 전송·오디오 재생은 범위 밖.
- `/ack` 이후에도 로컬 원본 파일은 자동 삭제하지 않는다. 화면에 업로드 단계만 표시한다.
- 업로드 도중 앱이 종료되면 마지막으로 저장한 체크포인트부터 재개한다. 서버 세션이
  만료됐으면 새 세션을 발급받아 다시 보낸다.
