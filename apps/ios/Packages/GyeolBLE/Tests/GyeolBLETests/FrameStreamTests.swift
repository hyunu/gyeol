import XCTest
@testable import GyeolBLE

final class FrameStreamTests: XCTestCase {
    func testReassemblesFragmentedFrames() throws {
        let first = try BleProtocol.encode(BleFrame(type: .hello, seq: 1, payload: Data("hello".utf8)))
        let second = try BleProtocol.encode(BleFrame(type: .listRequest, seq: 2))
        let stream = BleFrameStream()

        var frames: [BleFrame] = []
        for byte in (first + second) {
            frames.append(contentsOf: stream.append(Data([byte])))
        }
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames[0].type, .hello)
        XCTAssertEqual(frames[0].payload, Data("hello".utf8))
        XCTAssertEqual(frames[1].type, .listRequest)
    }

    func testSkipsGarbageAndResyncs() throws {
        let frame = try BleProtocol.encode(BleFrame(type: .helloAck, seq: 3, payload: Data([0x01])))
        let stream = BleFrameStream()

        var frames = stream.append(Data([0x00, 0x47, 0x00, 0x59, 0xff]))
        XCTAssertTrue(frames.isEmpty)

        frames = stream.append(frame)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].seq, 3)
    }

    func testCorruptFrameIsDropped() throws {
        var bytes = try BleProtocol.encode(BleFrame(type: .hello, seq: 4, payload: Data([0x01, 0x02])))
        bytes[bytes.count - 1] ^= 0xff
        let stream = BleFrameStream()

        let frames = stream.append(bytes + (try BleProtocol.encode(BleFrame(type: .listRequest, seq: 5))))
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].type, .listRequest)
    }
}
