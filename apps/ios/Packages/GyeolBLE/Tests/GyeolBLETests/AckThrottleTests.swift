import XCTest
@testable import GyeolBLE

final class AckThrottleTests: XCTestCase {
    func testBatchesUntilThreshold() {
        var throttle = AckThrottle(thresholdBytes: 100)

        XCTAssertFalse(throttle.shouldSend(clientRecordingId: "rec:1", receivedBytes: 20, isLast: false))
        XCTAssertFalse(throttle.shouldSend(clientRecordingId: "rec:1", receivedBytes: 60, isLast: false))
        XCTAssertFalse(throttle.shouldSend(clientRecordingId: "rec:1", receivedBytes: 99, isLast: false))
        XCTAssertTrue(throttle.shouldSend(clientRecordingId: "rec:1", receivedBytes: 100, isLast: false))
    }

    func testResetsWhenFileChanges() {
        var throttle = AckThrottle(thresholdBytes: 100)

        XCTAssertTrue(throttle.shouldSend(clientRecordingId: "rec:1", receivedBytes: 100, isLast: false))
        XCTAssertEqual(throttle.receivedBytes, 100)

        // 두 번째 파일은 이전 파일의 100 바이트와 비교하면 안 된다.
        XCTAssertFalse(throttle.shouldSend(clientRecordingId: "rec:2", receivedBytes: 20, isLast: false))
        XCTAssertEqual(throttle.receivedBytes, 20)
        XCTAssertFalse(throttle.shouldSend(clientRecordingId: "rec:2", receivedBytes: 80, isLast: false))
        XCTAssertTrue(throttle.shouldSend(clientRecordingId: "rec:2", receivedBytes: 100, isLast: false))
        XCTAssertEqual(throttle.receivedBytes, 100)
    }

    func testLastFrameAlwaysSends() {
        var throttle = AckThrottle(thresholdBytes: 100)

        XCTAssertTrue(throttle.shouldSend(clientRecordingId: "rec:1", receivedBytes: 10, isLast: true))
        XCTAssertEqual(throttle.receivedBytes, 10)
    }

    func testResetClearsState() {
        var throttle = AckThrottle(thresholdBytes: 100)
        _ = throttle.shouldSend(clientRecordingId: "rec:1", receivedBytes: 100, isLast: false)

        throttle.reset()

        XCTAssertEqual(throttle.receivedBytes, 0)
        XCTAssertNil(throttle.clientRecordingId)
        XCTAssertFalse(throttle.shouldSend(clientRecordingId: "rec:1", receivedBytes: 20, isLast: false))
    }
}
