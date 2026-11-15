import CryptoKit
import Foundation

/// 파일 시스템에 부분 파일을 유지하는 `TransferStore`.
///
/// 과거 구현은 DATA 프레임마다 전체 파일을 읽고 다시 쓰는 방식이어서
/// 파일 크기에 대해 O(n²) I/O 가 발생했다. 이 구현은 프레임을 파일 끝에
/// append 하고, 크기 조회는 파일 메타데이터만 읽는다. SHA-256 은 완료 시
/// 한 번만 계산해 별도 파일에 기록한다.
public final class FileTransferStore: TransferStore {
    private let directory: URL
    private let fileManager: FileManager

    public init(directory: URL, fileManager: FileManager = .default) {
        self.directory = directory
        self.fileManager = fileManager
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    public func get(_ clientRecordingId: String) -> (data: Data, sha256: String?)? {
        let base = baseName(clientRecordingId)
        guard let data = try? Data(contentsOf: partURL(base)) else { return nil }
        let sha = try? String(contentsOf: shaURL(base), encoding: .utf8)
        return (data, sha)
    }

    public func put(_ clientRecordingId: String, data: Data, sha256: String?) {
        let base = baseName(clientRecordingId)
        try? Data(clientRecordingId.utf8).write(to: idURL(base), options: .atomic)
        try? data.write(to: partURL(base), options: .atomic)
        if let sha256 {
            try? Data(sha256.utf8).write(to: shaURL(base), options: .atomic)
        }
    }

    /// 현재까지 저장된 바이트 수. 전체 파일을 읽지 않는다.
    public func size(_ clientRecordingId: String) -> Int {
        let base = baseName(clientRecordingId)
        guard
            let attributes = try? fileManager.attributesOfItem(atPath: partURL(base).path),
            let size = attributes[.size] as? NSNumber
        else {
            return 0
        }
        return size.intValue
    }

    /// `offset` 위치에 청크를 append 하고 새 크기를 돌려준다.
    ///
    /// 저장된 크기와 `offset` 이 다르면 아무것도 쓰지 않고 현재 크기를 돌려준다.
    /// 호출자는 이 값을 ACK 로 보내 송신측이 올바른 지점부터 재개하게 한다.
    @discardableResult
    public func append(_ clientRecordingId: String, offset: Int, data: Data) -> Int {
        let base = baseName(clientRecordingId)
        let part = partURL(base)

        if !fileManager.fileExists(atPath: part.path) {
            fileManager.createFile(atPath: part.path, contents: nil)
            try? Data(clientRecordingId.utf8).write(to: idURL(base), options: .atomic)
        }

        guard let handle = try? FileHandle(forWritingTo: part) else {
            return size(clientRecordingId)
        }
        defer { try? handle.close() }

        do {
            let current = Int(try handle.seekToEnd())
            guard current == offset else { return current }
            try handle.write(contentsOf: data)
            return current + data.count
        } catch {
            return size(clientRecordingId)
        }
    }

    /// 완료된 파일의 SHA-256 만 기록한다. 오디오 전체를 다시 쓰지 않는다.
    public func setSha256(_ clientRecordingId: String, sha256: String) {
        let base = baseName(clientRecordingId)
        try? Data(sha256.utf8).write(to: shaURL(base), options: .atomic)
    }

    /// `offset` 부터 `length` 바이트만 읽는다. 업로드 청크 전송에 쓴다.
    public func read(_ clientRecordingId: String, offset: Int, length: Int) -> Data {
        guard offset >= 0, length > 0 else { return Data() }
        guard let handle = try? FileHandle(forReadingFrom: partURL(baseName(clientRecordingId))) else {
            return Data()
        }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: UInt64(offset))
            return try handle.read(upToCount: length) ?? Data()
        } catch {
            return Data()
        }
    }

    /// 수신이 시작된 시각(파일 생성 시각). 기기에 RTC 가 없으므로 녹음 시작 시각을
    /// 근사하는 데 쓴다. 생성 시각은 첫 DATA 프레임을 받은 때에 가깝다.
    public func createdAt(_ clientRecordingId: String) -> Date? {
        let path = partURL(baseName(clientRecordingId)).path
        guard let attributes = try? fileManager.attributesOfItem(atPath: path) else {
            return nil
        }
        return (attributes[.creationDate] as? Date) ?? (attributes[.modificationDate] as? Date)
    }

    public func list() -> [BleFileMeta] {
        let files = (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.compactMap { url -> BleFileMeta? in
            guard url.pathExtension == "part" else { return nil }
            let base = url.deletingPathExtension().lastPathComponent
            guard
                let id = try? String(contentsOf: idURL(base), encoding: .utf8),
                let sha = try? String(contentsOf: shaURL(base), encoding: .utf8),
                let size = (try? fileManager.attributesOfItem(atPath: url.path))?[.size] as? Int
            else {
                return nil
            }
            return BleFileMeta(clientRecordingId: id, byteSize: size, sha256: sha)
        }
    }

    private func baseName(_ clientRecordingId: String) -> String {
        SHA256.hash(data: Data(clientRecordingId.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func partURL(_ base: String) -> URL { directory.appending(path: "\(base).part") }
    private func idURL(_ base: String) -> URL { directory.appending(path: "\(base).id") }
    private func shaURL(_ base: String) -> URL { directory.appending(path: "\(base).sha256") }
}
