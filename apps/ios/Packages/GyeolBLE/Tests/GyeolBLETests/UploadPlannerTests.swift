import XCTest
@testable import GyeolBLE

final class UploadPlannerTests: XCTestCase {
    func testNextRange() {
        XCTAssertEqual(
            UploadPlanner.nextRange(offset: 0, totalBytes: 100, chunkSizeBytes: 40),
            0..<40
        )
        XCTAssertEqual(
            UploadPlanner.nextRange(offset: 80, totalBytes: 100, chunkSizeBytes: 40),
            80..<100
        )
        XCTAssertNil(UploadPlanner.nextRange(offset: 100, totalBytes: 100, chunkSizeBytes: 40))
        XCTAssertNil(UploadPlanner.nextRange(offset: 0, totalBytes: 100, chunkSizeBytes: 0))
    }

    func testRecoverOffsetPrefersExpected() {
        XCTAssertEqual(
            UploadPlanner.recoverOffset(fromProblemDetail: "expected=1234 received=999"),
            1234
        )
    }

    func testRecoverOffsetFallsBackToReceived() {
        XCTAssertEqual(UploadPlanner.recoverOffset(fromProblemDetail: "received=512"), 512)
        XCTAssertNil(UploadPlanner.recoverOffset(fromProblemDetail: "no offset here"))
    }

    func testCheckpointRoundTripAndProgress() throws {
        let started = Date(timeIntervalSince1970: 1_700_000_000)
        let checkpoint = UploadCheckpoint(
            clientRecordingId: "rec:1",
            recordingId: "recording-1",
            sessionId: "session-1",
            startedAt: started,
            durationMs: 1500,
            codec: "wav_pcm_s16le",
            sampleRateHz: 16000,
            channels: 1,
            byteSize: 100,
            sha256: String(repeating: "a", count: 64),
            uploadedBytes: 25,
            phase: .uploading
        )

        XCTAssertEqual(checkpoint.endedAt.timeIntervalSince(started), 1.5, accuracy: 0.0001)
        XCTAssertEqual(checkpoint.progress, 0.25, accuracy: 0.0001)

        let decoded = try JSONDecoder().decode(
            UploadCheckpoint.self,
            from: try JSONEncoder().encode(checkpoint)
        )
        XCTAssertEqual(decoded, checkpoint)
    }
}
