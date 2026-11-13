import XCTest
@testable import GyeolBLE

final class FrameTests: XCTestCase {
    private struct Hello: Encodable {
        let serialNo: String
        let protocolVersion: Int
    }

    func testRoundTrip() throws {
        let payload = try BleProtocol.jsonPayload(Hello(serialNo: "GYL-1", protocolVersion: 1))
        let frame = BleFrame(type: .hello, seq: 7, flags: 1, payload: payload)
        let decoded = try BleProtocol.decode(try BleProtocol.encode(frame))

        XCTAssertEqual(decoded.type, .hello)
        XCTAssertEqual(decoded.seq, 7)
        XCTAssertTrue(decoded.isLast)
        XCTAssertEqual(decoded.payload, payload)
    }

    func testCorruptCrcIsRejected() throws {
        let frame = BleFrame(type: .hello, seq: 1, payload: Data([0x01, 0x02]))
        var bytes = try BleProtocol.encode(frame)
        bytes[bytes.count - 1] ^= 0xff

        XCTAssertThrowsError(try BleProtocol.decode(bytes)) { error in
            XCTAssertEqual((error as? BleFrameError)?.code, "BAD_CRC")
        }
    }

    func testBadMagicAndVersion() throws {
        let frame = BleFrame(type: .hello, seq: 1)
        var magic = try BleProtocol.encode(frame)
        magic[0] = 0x00
        XCTAssertThrowsError(try BleProtocol.decode(magic)) { error in
            XCTAssertEqual((error as? BleFrameError)?.code, "BAD_MAGIC")
        }

        var version = try BleProtocol.encode(frame)
        version[2] = 9
        XCTAssertThrowsError(try BleProtocol.decode(version)) { error in
            XCTAssertEqual((error as? BleFrameError)?.code, "UNSUPPORTED_VERSION")
        }
    }

    func testLengthMismatchAndTooLarge() throws {
        let frame = BleFrame(type: .hello, seq: 1, payload: Data([0x01]))
        var bytes = try BleProtocol.encode(frame)
        bytes[11] = 2
        XCTAssertThrowsError(try BleProtocol.decode(bytes)) { error in
            XCTAssertEqual((error as? BleFrameError)?.code, "LENGTH_MISMATCH")
        }

        let huge = BleFrame(type: .hello, seq: 1, payload: Data(repeating: 0, count: BleProtocol.maxPayloadBytes + 1))
        XCTAssertThrowsError(try BleProtocol.encode(huge)) { error in
            XCTAssertEqual((error as? BleFrameError)?.code, "PAYLOAD_TOO_LARGE")
        }
    }

    func testDataPayloadRoundTrip() throws {
        let payload = BleProtocol.dataPayload(offset: 42, data: Data("hello".utf8))
        let parsed = try BleProtocol.parseDataPayload(payload)
        XCTAssertEqual(parsed.offset, 42)
        XCTAssertEqual(parsed.data, Data("hello".utf8))
    }
}
