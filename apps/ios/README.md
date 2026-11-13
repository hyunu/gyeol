# iOS 앱 (W-23/W-24 스캐폴드)

- Team: `XR84FWAH7L` (LG Electronics Inc., Enterprise) — 사용자 승인됨
- Bundle ID: `com.lge.gyeol` (변경 시 `project.yml` 수정)
- Deployment target: iOS 17
- 생성: [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`project.yml`)

## 구성

| 파일 | 역할 |
| --- | --- |
| `Gyeol/ContentView.swift` | 로그인·대화 타임라인·상세·기기 화면 |
| `Gyeol/AuthController.swift` | Sign in with Apple → 서버 세션 |
| `Gyeol/APIClient.swift` | `/auth/apple`, `/conversations` |
| `Gyeol/SessionStore.swift` | 토큰 Keychain 저장 |
| `Gyeol/BleCentral.swift` | CoreBluetooth 수신, ACK 배칭, 디스크 저장 |
| `Gyeol/DiskTransferStore.swift` | Documents/recordings 부분 파일·SHA |
| `Packages/GyeolBLE` | 프레임 코덱·수신기·스트림 재조립 (Swift Package) |

## 빌드

```bash
cd apps/ios
xcodegen generate
xcodebuild -project Gyeol.xcodeproj -scheme Gyeol \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

서명 포함 실기기 빌드는 Xcode 에서 Team 을 확인하고 실행한다. In-House 배포는
**Apple Distribution 인증서**가 추가로 필요하다(현재 로컬에 없음).

Swift 패키지 테스트(macOS):

```bash
swift test --package-path apps/ios/Packages/GyeolBLE
```

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
- ACK 는 8프레임마다 1회만 보내 왕복을 줄인다.

## 현재 한계

- 실기기에서 CoreBluetooth 전송 E2E 를 아직 실행하지 않았다(컴파일·시뮬레이터 빌드만 확인).
- 웹 로그인(Service ID + client secret)은 별도 작업.
- 푸시·백그라운드 전송·오디오 재생은 범위 밖.
