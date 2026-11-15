import Foundation
import GyeolBLE

/// 부분 파일을 Documents/recordings 에 유지한다. 앱이 재시작돼도 이어받기가 가능하다.
///
/// 실제 파일 I/O 는 `GyeolBLE.FileTransferStore` 가 담당한다. 앱에서는 저장 위치만
/// 정해 주고, 테스트는 같은 구현을 임시 디렉터리로 검증한다.
final class DiskTransferStore: TransferStore {
    private let store: FileTransferStore

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        store = FileTransferStore(directory: documents.appending(path: "recordings", directoryHint: .isDirectory))
    }

    func get(_ clientRecordingId: String) -> (data: Data, sha256: String?)? {
        store.get(clientRecordingId)
    }

    func put(_ clientRecordingId: String, data: Data, sha256: String?) {
        store.put(clientRecordingId, data: data, sha256: sha256)
    }

    func size(_ clientRecordingId: String) -> Int {
        store.size(clientRecordingId)
    }

    func append(_ clientRecordingId: String, offset: Int, data: Data) -> Int {
        store.append(clientRecordingId, offset: offset, data: data)
    }

    func read(_ clientRecordingId: String, offset: Int, length: Int) -> Data {
        store.read(clientRecordingId, offset: offset, length: length)
    }

    /// BLE 수신이 끝난 시각. 서버 `startedAt` 근사에 쓴다.
    func createdAt(_ clientRecordingId: String) -> Date? {
        store.createdAt(clientRecordingId)
    }

    func setSha256(_ clientRecordingId: String, sha256: String) {
        store.setSha256(clientRecordingId, sha256: sha256)
    }

    func list() -> [BleFileMeta] {
        store.list()
    }
}
