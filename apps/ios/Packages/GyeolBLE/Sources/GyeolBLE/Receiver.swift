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

/// 기기가 `HELLO` 로 알려 주는 신원 정보. 서버 기기 등록에 쓴다.
public struct BleHello: Codable, Sendable, Equatable {
    public let serialNo: String
    public let model: String?
    public let firmwareVersion: String?
    public let pendingFiles: Int?

    public init(serialNo: String, model: String? = nil, firmwareVersion: String? = nil, pendingFiles: Int? = nil) {
        self.serialNo = serialNo
        self.model = model
        self.firmwareVersion = firmwareVersion
        self.pendingFiles = pendingFiles
    }
}

public protocol TransferStore: AnyObject {
    func get(_ clientRecordingId: String) -> (data: Data, sha256: String?)?
    func put(_ clientRecordingId: String, data: Data, sha256: String?)
    /// 현재까지 저장된 바이트 수. 전체 파일을 읽지 않아야 한다.
    func size(_ clientRecordingId: String) -> Int
    /// `offset` 위치에 청크를 append 하고 새 크기를 돌려준다.
    func append(_ clientRecordingId: String, offset: Int, data: Data) -> Int
    /// `offset` 부터 `length` 바이트만 읽는다. 업로드 청크 전송에 쓴다.
    func read(_ clientRecordingId: String, offset: Int, length: Int) -> Data
    /// 완료된 파일의 SHA-256 을 기록한다.
    func setSha256(_ clientRecordingId: String, sha256: String)
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

    public func size(_ clientRecordingId: String) -> Int {
        files[clientRecordingId]?.data.count ?? 0
    }

    public func append(_ clientRecordingId: String, offset: Int, data: Data) -> Int {
        var entry = files[clientRecordingId] ?? (Data(), nil)
        guard entry.data.count == offset else { return entry.data.count }
        entry.data.append(data)
        files[clientRecordingId] = entry
        return entry.data.count
    }

    public func read(_ clientRecordingId: String, offset: Int, length: Int) -> Data {
        guard let entry = files[clientRecordingId], offset >= 0, length > 0, offset < entry.data.count else {
            return Data()
        }
        let end = min(entry.data.count, offset + length)
        return entry.data.subdata(in: offset..<end)
    }

    public func setSha256(_ clientRecordingId: String, sha256: String) {
        var entry = files[clientRecordingId] ?? (Data(), nil)
        entry.sha256 = sha256
        files[clientRecordingId] = entry
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
    /// 마지막으로 받은 `HELLO` 정보. 기기 등록에 쓴다.
    public private(set) var hello: BleHello?

    public init(store: TransferStore, chunkSizeBytes: Int = BleProtocol.recommendedChunkBytes) {
        self.store = store
        self.chunkSizeBytes = chunkSizeBytes
    }

    /// 연결이 끊겼을 때 호출한다. 다음 연결은 `OPEN_REQ` 부터 다시 시작해야 한다.
    /// (그렇지 않으면 재연결 후 OPEN 없이 온 DATA 를 이전 파일에 붙일 수 있다.)
    public func resetConnection() {
        currentId = nil
        seq = 0
        hello = nil
    }

    public func handle(_ frame: BleFrame) -> [BleFrame] {
        switch frame.type {
        case .hello:
            if let hello = try? BleProtocol.parseJSON(BleHello.self, from: frame.payload) {
                self.hello = hello
            }
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
            let offset = store.size(request.clientRecordingId)
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
        let existingCount = store.size(currentId)
        if offset < UInt64(existingCount) {
            return [ack(currentId, existingCount)]
        }
        if offset > UInt64(existingCount) {
            return [ack(currentId, existingCount)]
        }
        guard offset <= UInt64(Int.max) else {
            return [error("BAD_DATA", "offset 이 너무 큽니다.")]
        }
        let next = store.append(currentId, offset: Int(offset), data: chunk)
        return [ack(currentId, next)]
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

        store.setSha256(request.clientRecordingId, sha256: digest)
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
