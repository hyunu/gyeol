import XCTest
@testable import GyeolBLE

final class WavMetadataTests: XCTestCase {
    private func wav(
        format: UInt16,
        channels: UInt16,
        sampleRate: UInt32,
        byteRate: UInt32,
        bitsPerSample: UInt16,
        dataBytes: Int
    ) -> Data {
        var data = Data()
        data.append(contentsOf: Array("RIFF".utf8))
        data.appendLE(UInt32(36 + dataBytes))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        data.appendLE(UInt32(16))
        data.appendLE(format)
        data.appendLE(channels)
        data.appendLE(sampleRate)
        data.appendLE(byteRate)
        data.appendLE(UInt16(channels * bitsPerSample / 8))
        data.appendLE(bitsPerSample)
        data.append(contentsOf: Array("data".utf8))
        data.appendLE(UInt32(dataBytes))
        data.append(Data(repeating: 0, count: dataBytes))
        return data
    }

    func testPcmDurationAndCodec() throws {
        let metadata = try XCTUnwrap(WavMetadata.parse(wav(
            format: 1,
            channels: 1,
            sampleRate: 16000,
            byteRate: 32000,
            bitsPerSample: 16,
            dataBytes: 32000
        )))

        XCTAssertEqual(metadata.codec, "wav_pcm_s16le")
        XCTAssertEqual(metadata.sampleRateHz, 16000)
        XCTAssertEqual(metadata.channels, 1)
        XCTAssertEqual(metadata.bitsPerSample, 16)
        XCTAssertEqual(metadata.durationMs, 1000)
        XCTAssertEqual(metadata.dataBytes, 32000)
    }

    func testImaAdpcmCodec() throws {
        let metadata = try XCTUnwrap(WavMetadata.parse(wav(
            format: 0x11,
            channels: 1,
            sampleRate: 16000,
            byteRate: 8000,
            bitsPerSample: 4,
            dataBytes: 16000
        )))

        XCTAssertEqual(metadata.codec, "wav_ima_adpcm")
        XCTAssertEqual(metadata.durationMs, 2000)
    }

    func testHeaderOnlyParseUsesFullFileSize() throws {
        let full = wav(
            format: 1,
            channels: 1,
            sampleRate: 16000,
            byteRate: 32000,
            bitsPerSample: 16,
            dataBytes: 32000
        )
        // 업로드 준비 단계는 헤더만 읽는다. 선언된 data 크기가 버퍼보다 커도
        // 전체 파일 크기를 알면 duration 을 정확히 계산해야 한다.
        let headerOnly = Data(full.prefix(44))
        let metadata = try XCTUnwrap(WavMetadata.parse(headerOnly, fileSize: full.count))

        XCTAssertEqual(metadata.dataBytes, 32000)
        XCTAssertEqual(metadata.durationMs, 1000)
    }

    func testDeclaredDataSizeIsCappedByFileSize() throws {
        let full = wav(
            format: 1,
            channels: 1,
            sampleRate: 16000,
            byteRate: 32000,
            bitsPerSample: 16,
            dataBytes: 32000
        )
        let metadata = try XCTUnwrap(WavMetadata.parse(Data(full.prefix(44)), fileSize: 44 + 16000))

        XCTAssertEqual(metadata.dataBytes, 16000)
        XCTAssertEqual(metadata.durationMs, 500)
    }

    func testInvalidHeaderReturnsNil() {
        XCTAssertNil(WavMetadata.parse(Data("not a wav".utf8)))
        XCTAssertNil(WavMetadata.parse(wav(
            format: 1,
            channels: 1,
            sampleRate: 16000,
            byteRate: 32000,
            bitsPerSample: 16,
            dataBytes: 0
        )))
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var littleEndian = value.littleEndian
        append(Data(bytes: &littleEndian, count: MemoryLayout<T>.size))
    }
}
