import CryptoKit
import Foundation
import GyeolBLE

/// 부분 파일을 Documents/recordings 에 유지한다. 앱이 재시작돼도 이어받기가 가능하다.
final class DiskTransferStore: TransferStore {
    private let directory: URL
    private let fileManager = FileManager.default

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        directory = documents.appending(path: "recordings", directoryHint: .isDirectory)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func get(_ clientRecordingId: String) -> (data: Data, sha256: String?)? {
        let base = baseName(clientRecordingId)
        guard let data = try? Data(contentsOf: partURL(base)) else { return nil }
        let sha = try? String(contentsOf: shaURL(base), encoding: .utf8)
        return (data, sha)
    }

    func put(_ clientRecordingId: String, data: Data, sha256: String?) {
        let base = baseName(clientRecordingId)
        try? Data(clientRecordingId.utf8).write(to: idURL(base), options: .atomic)
        try? data.write(to: partURL(base), options: .atomic)
        if let sha256 {
            try? Data(sha256.utf8).write(to: shaURL(base), options: .atomic)
        }
    }

    func list() -> [BleFileMeta] {
        let files = (try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.compactMap { url -> BleFileMeta? in
            guard url.pathExtension == "part" else { return nil }
            let base = url.deletingPathExtension().lastPathComponent
            guard
                let id = try? String(contentsOf: idURL(base), encoding: .utf8),
                let sha = try? String(contentsOf: shaURL(base), encoding: .utf8),
                let size = (try? fileManager.attributesOfItem(atPath: url.path))?[.size] as? Int
            else { return nil }
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
