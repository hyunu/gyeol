import CryptoKit
import XCTest
@testable import GyeolBLE

final class ReceiverTests: XCTestCase {
    private func json(_ frame: BleFrame) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: frame.payload) as? [String: Any])
    }

    private struct CompleteRequest: Encodable {
        let clientRecordingId: String
        let byteSize: Int
        let sha256: String
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func dataFrame(seq: UInt32, offset: UInt64, text: String, last: Bool = false) -> BleFrame {
        BleFrame(
            type: .data,
            seq: seq,
            flags: last ? 1 : 0,
            payload: BleProtocol.dataPayload(offset: offset, data: Data(text.utf8))
        )
    }

    func testReceiveAppendAndComplete() throws {
        let store = MemoryTransferStore()
        let receiver = BleTransferReceiver(store: store)

        let hello = receiver.handle(BleFrame(type: .hello, seq: 1))
        XCTAssertEqual(hello.first?.type, .helloAck)

        let open = receiver.handle(BleFrame(
            type: .openRequest,
            seq: 2,
            payload: try BleProtocol.jsonPayload(["clientRecordingId": "rec:1"])
        ))
        XCTAssertEqual(try json(XCTUnwrap(open.first))["startOffset"] as? Int, 0)

        let ack1 = receiver.handle(dataFrame(seq: 3, offset: 0, text: "abc"))
        XCTAssertEqual(try json(XCTUnwrap(ack1.first))["receivedBytes"] as? Int, 3)

        let ack2 = receiver.handle(dataFrame(seq: 4, offset: 3, text: "def", last: true))
        XCTAssertEqual(try json(XCTUnwrap(ack2.first))["receivedBytes"] as? Int, 6)

        let complete = receiver.handle(BleFrame(
            type: .completeRequest,
            seq: 5,
            payload: try BleProtocol.jsonPayload(CompleteRequest(
                clientRecordingId: "rec:1",
                byteSize: 6,
                sha256: sha256(Data("abcdef".utf8))
            ))
        ))
        XCTAssertEqual(try json(XCTUnwrap(complete.first))["status"] as? String, "ok")
        XCTAssertEqual(store.get("rec:1")?.data, Data("abcdef".utf8))

        let list = receiver.handle(BleFrame(type: .listRequest, seq: 6))
        let files = try XCTUnwrap(try json(XCTUnwrap(list.first))["files"] as? [[String: Any]])
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(files[0]["clientRecordingId"] as? String, "rec:1")
    }

    func testDuplicateAndGapDoNotAdvanceOffset() throws {
        let store = MemoryTransferStore()
        let receiver = BleTransferReceiver(store: store)
        _ = receiver.handle(BleFrame(
            type: .openRequest,
            seq: 1,
            payload: try BleProtocol.jsonPayload(["clientRecordingId": "rec:gap"])
        ))

        let gap = receiver.handle(dataFrame(seq: 2, offset: 4, text: "efgh"))
        XCTAssertEqual(try json(XCTUnwrap(gap.first))["receivedBytes"] as? Int, 0)
        XCTAssertEqual(store.get("rec:gap")?.data.count ?? 0, 0)

        _ = receiver.handle(dataFrame(seq: 3, offset: 0, text: "abcd"))
        let duplicate = receiver.handle(dataFrame(seq: 4, offset: 0, text: "abcd"))
        XCTAssertEqual(try json(XCTUnwrap(duplicate.first))["receivedBytes"] as? Int, 4)
        XCTAssertEqual(store.get("rec:gap")?.data, Data("abcd".utf8))
    }

    func testResumeFromPartialFile() throws {
        let store = MemoryTransferStore()
        store.put("rec:resume", data: Data("abc".utf8), sha256: nil)
        let receiver = BleTransferReceiver(store: store)

        let open = receiver.handle(BleFrame(
            type: .openRequest,
            seq: 1,
            payload: try BleProtocol.jsonPayload(["clientRecordingId": "rec:resume"])
        ))
        XCTAssertEqual(try json(XCTUnwrap(open.first))["startOffset"] as? Int, 3)

        _ = receiver.handle(dataFrame(seq: 2, offset: 3, text: "def", last: true))
        let complete = receiver.handle(BleFrame(
            type: .completeRequest,
            seq: 3,
            payload: try BleProtocol.jsonPayload(CompleteRequest(
                clientRecordingId: "rec:resume",
                byteSize: 6,
                sha256: sha256(Data("abcdef".utf8))
            ))
        ))
        XCTAssertEqual(try json(XCTUnwrap(complete.first))["status"] as? String, "ok")
        XCTAssertEqual(store.get("rec:resume")?.data, Data("abcdef".utf8))
    }

    func testHashMismatchIsRejected() throws {
        let store = MemoryTransferStore()
        let receiver = BleTransferReceiver(store: store)
        _ = receiver.handle(BleFrame(
            type: .openRequest,
            seq: 1,
            payload: try BleProtocol.jsonPayload(["clientRecordingId": "rec:bad"])
        ))
        _ = receiver.handle(dataFrame(seq: 2, offset: 0, text: "abcdef"))

        let complete = receiver.handle(BleFrame(
            type: .completeRequest,
            seq: 3,
            payload: try BleProtocol.jsonPayload(CompleteRequest(
                clientRecordingId: "rec:bad",
                byteSize: 6,
                sha256: String(repeating: "0", count: 64)
            ))
        ))
        XCTAssertEqual(try json(XCTUnwrap(complete.first))["status"] as? String, "mismatch")
        XCTAssertNil(store.get("rec:bad")?.sha256)
    }

    func testDataWithoutOpenIsRejected() throws {
        let receiver = BleTransferReceiver(store: MemoryTransferStore())
        let response = receiver.handle(dataFrame(seq: 1, offset: 0, text: "x"))
        XCTAssertEqual(response.first?.type, .error)
        XCTAssertEqual(try json(XCTUnwrap(response.first))["code"] as? String, "NO_OPEN_FILE")
    }
}
