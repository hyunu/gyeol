import CryptoKit
import Foundation

/// 수신 파일 메타데이터 (LIST_RES).
public struct BleFileMeta: Codable, Sendable, Equatable {
    public let clientRecordingId: String
    public let byteSize: Int
    public let sha256: String

    public init(clientRecordingId: String, byteSize: Int, sha256: String) {
        self.clientRecordingId = clientRecordingId
        self.byteSize = byteSize
        self.sha256 = sha256
    }
}

public protocol TransferStore: AnyObject {
    func get(_ clientRecordingId: String) -> (data: Data, sha256: String?)?
    func put(_ clientRecordingId: String, data: Data, sha256: String?)
    func list() -> [BleFileMeta]
}

public final class MemoryTransferStore: TransferStore {
    private var files: [String: (data: Data, sha256: String?)] = [:]

    public init() {}

    public func get(_ clientRecordingId: String) -> (data: Data, sha256: String?)? {
        files[clientRecordingId]
    }

    public func put(_ clientRecordingId: String, data: Data, sha256: String?) {
        files[clientRecordingId] = (data, sha256)
    }

    public func list() -> [BleFileMeta] {
        files.compactMap { key, value in
            guard let sha = value.sha256 else { return nil }
            return BleFileMeta(clientRecordingId: key, byteSize: value.data.count, sha256: sha)
        }
    }
}

/// 폰(수신) 측 전송 상태 기계. `docs/12-ble-protocol.md` §4 를 따른다.
public final class BleTransferReceiver {
    private struct HelloAck: Encodable {
        let protocolVersion: Int
        let chunkSizeBytes: Int
        let maxFrameBytes: Int
    }
    private struct OpenRequest: Decodable { let clientRecordingId: String }
    private struct OpenResponse: Encodable {
        let clientRecordingId: String
        let startOffset: Int
        let chunkSizeBytes: Int
    }
    private struct Ack: Encodable {
        let clientRecordingId: String
        let receivedBytes: Int
    }
    private struct CompleteRequest: Decodable {
        let clientRecordingId: String
        let byteSize: Int
        let sha256: String
    }
    private struct CompleteResponse: Encodable {
        let clientRecordingId: String
        let status: String
        let receivedBytes: Int
    }
    private struct ErrorPayload: Encodable {
        let code: String
        let detail: String
    }

    private let store: TransferStore
    private let chunkSizeBytes: Int
    private var currentId: String?
    private var seq: UInt32 = 0
    private var completed: Set<String> = []

    public init(store: TransferStore, chunkSizeBytes: Int = BleProtocol.recommendedChunkBytes) {
        self.store = store
        self.chunkSizeBytes = chunkSizeBytes
    }

    public func handle(_ frame: BleFrame) -> [BleFrame] {
        switch frame.type {
        case .hello:
            return [reply(.helloAck, HelloAck(
                protocolVersion: 1,
                chunkSizeBytes: chunkSizeBytes,
                maxFrameBytes: BleProtocol.maxFrameBytes
            ))]
        case .listRequest:
            return [reply(.listResponse, ["files": store.list()])]
        case .openRequest:
            let request = (try? BleProtocol.parseJSON(OpenRequest.self, from: frame.payload))
            guard let request else {
                return [error("BAD_JSON", "OPEN_REQ 를 해석할 수 없습니다.")]
            }
            currentId = request.clientRecordingId
            let offset = store.get(request.clientRecordingId)?.data.count ?? 0
            return [reply(.openResponse, OpenResponse(
                clientRecordingId: request.clientRecordingId,
                startOffset: offset,
                chunkSizeBytes: chunkSizeBytes
            ))]
        case .data:
            return onData(frame)
        case .completeRequest:
            return onComplete(frame)
        default:
            return [error("UNEXPECTED_TYPE", "수신기가 처리하지 않는 타입: \(frame.type)")]
        }
    }

    private func onData(_ frame: BleFrame) -> [BleFrame] {
        guard let currentId else {
            return [error("NO_OPEN_FILE", "OPEN_REQ 없이 DATA")]
        }
        guard let (offset, chunk) = try? BleProtocol.parseDataPayload(frame.payload) else {
            return [error("BAD_DATA", "DATA payload 형식 오류")]
        }
        let existing = store.get(currentId)?.data ?? Data()
        if offset < UInt64(existing.count) {
            return [ack(currentId, existing.count)]
        }
        if offset > UInt64(existing.count) {
            return [ack(currentId, existing.count)]
        }
        let next = existing + chunk
        store.put(currentId, data: next, sha256: store.get(currentId)?.sha256)
        return [ack(currentId, next.count)]
    }

    private func onComplete(_ frame: BleFrame) -> [BleFrame] {
        guard let request = try? BleProtocol.parseJSON(CompleteRequest.self, from: frame.payload) else {
            return [error("BAD_JSON", "COMPLETE_REQ 를 해석할 수 없습니다.")]
        }
        let stored = store.get(request.clientRecordingId)?.data ?? Data()
        let received = stored.count

        if completed.contains(request.clientRecordingId) {
            return [reply(.completeResponse, CompleteResponse(
                clientRecordingId: request.clientRecordingId,
                status: "duplicate",
                receivedBytes: received
            ))]
        }
        guard received == request.byteSize else {
            return [reply(.completeResponse, CompleteResponse(
                clientRecordingId: request.clientRecordingId,
                status: "mismatch",
                receivedBytes: received
            ))]
        }
        let digest = SHA256.hash(data: stored).map { String(format: "%02x", $0) }.joined()
        guard digest == request.sha256 else {
            return [reply(.completeResponse, CompleteResponse(
                clientRecordingId: request.clientRecordingId,
                status: "mismatch",
                receivedBytes: received
            ))]
        }

        store.put(request.clientRecordingId, data: stored, sha256: digest)
        completed.insert(request.clientRecordingId)
        currentId = nil
        return [reply(.completeResponse, CompleteResponse(
            clientRecordingId: request.clientRecordingId,
            status: "ok",
            receivedBytes: received
        ))]
    }

    private func ack(_ clientRecordingId: String, _ receivedBytes: Int) -> BleFrame {
        reply(.ack, Ack(clientRecordingId: clientRecordingId, receivedBytes: receivedBytes))
    }

    private func error(_ code: String, _ detail: String) -> BleFrame {
        reply(.error, ErrorPayload(code: code, detail: detail))
    }

    private func reply<T: Encodable>(_ type: BleFrameType, _ body: T) -> BleFrame {
        seq += 1
        let payload = (try? BleProtocol.jsonPayload(body)) ?? Data()
        return BleFrame(type: type, seq: seq, payload: payload)
    }
}
