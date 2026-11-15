import XCTest
@testable import GyeolBLE

final class FileTransferStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appending(path: "gyeol-store-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testAppendUsesOffsetAndPersistsMetadata() {
        let store = FileTransferStore(directory: directory)

        XCTAssertEqual(store.size("rec:1"), 0)
        XCTAssertEqual(store.append("rec:1", offset: 0, data: Data("abc".utf8)), 3)
        XCTAssertEqual(store.size("rec:1"), 3)

        // 오프셋이 다르면 쓰지 않고 현재 크기를 돌려준다.
        XCTAssertEqual(store.append("rec:1", offset: 1, data: Data("X".utf8)), 3)
        XCTAssertEqual(store.get("rec:1")?.data, Data("abc".utf8))

        XCTAssertEqual(store.append("rec:1", offset: 3, data: Data("def".utf8)), 6)
        XCTAssertEqual(store.get("rec:1")?.data, Data("abcdef".utf8))

        store.setSha256("rec:1", sha256: "deadbeef")
        let files = store.list()
        XCTAssertEqual(files.count, 1)
        XCTAssertEqual(files[0].clientRecordingId, "rec:1")
        XCTAssertEqual(files[0].byteSize, 6)
        XCTAssertEqual(files[0].sha256, "deadbeef")
    }

    func testResumeFromNewInstance() {
        let first = FileTransferStore(directory: directory)
        _ = first.append("rec:resume", offset: 0, data: Data("abc".utf8))

        let second = FileTransferStore(directory: directory)
        XCTAssertEqual(second.size("rec:resume"), 3)
        XCTAssertEqual(second.append("rec:resume", offset: 3, data: Data("def".utf8)), 6)
        XCTAssertEqual(second.get("rec:resume")?.data, Data("abcdef".utf8))
    }

    func testRangeReadWithoutLoadingWholeFile() {
        let store = FileTransferStore(directory: directory)
        _ = store.append("rec:range", offset: 0, data: Data("abcdef".utf8))

        XCTAssertEqual(store.read("rec:range", offset: 2, length: 3), Data("cde".utf8))
        XCTAssertEqual(store.read("rec:range", offset: 5, length: 10), Data("f".utf8))
        XCTAssertEqual(store.read("rec:range", offset: 6, length: 1), Data())
        XCTAssertNotNil(store.createdAt("rec:range"))
    }
}
