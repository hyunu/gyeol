import Foundation

/// WAV 파일 헤더에서 서버 `CreateRecordingRequest` 에 필요한 메타데이터를 파생한다.
///
/// BLE `LIST_RES` 는 `clientRecordingId`·`byteSize`·`sha256` 만 전달한다
/// (`docs/12-ble-protocol.md`). 코덱·샘플레이트·채널·길이는 파일 자체가
/// 담고 있으므로 펌웨어 계약을 확장하지 않고 여기서 읽는다.
///
/// `startedAt` 은 기기에 실시간 시계(RTC)가 없어 파일에서 알 수 없다.
/// 수신 시작 시각에서 `durationMs` 를 빼 근사한다.
public struct WavMetadata: Equatable, Sendable {
    public let codec: String
    public let sampleRateHz: Int
    public let channels: Int
    public let bitsPerSample: Int
    public let durationMs: Int
    public let dataBytes: Int

    public init(
        codec: String,
        sampleRateHz: Int,
        channels: Int,
        bitsPerSample: Int,
        durationMs: Int,
        dataBytes: Int
    ) {
        self.codec = codec
        self.sampleRateHz = sampleRateHz
        self.channels = channels
        self.bitsPerSample = bitsPerSample
        self.durationMs = durationMs
        self.dataBytes = dataBytes
    }

    /// RIFF/WAVE `fmt `·`data` 청크를 읽는다. 형식이 맞지 않으면 nil.
    ///
    /// - Parameter fileSize: 전체 파일 크기. 파일 앞부분만 넘길 때 `data` 청크의
    ///   선언 크기를 실제 파일 범위로 제한하는 데 쓴다. 생략하면 `data` 가
    ///   전부 들어 있다고 가정한다.
    public static func parse(_ data: Data, fileSize: Int? = nil) -> WavMetadata? {
        let bytes = [UInt8](data)
        guard
            bytes.count >= 12,
            ascii(bytes, at: 0, length: 4) == "RIFF",
            ascii(bytes, at: 8, length: 4) == "WAVE"
        else {
            return nil
        }

        var format: Format?
        var offset = 12

        while offset + 8 <= bytes.count {
            let id = ascii(bytes, at: offset, length: 4)
            let size = Int(readUInt32LE(bytes, at: offset + 4))
            let body = offset + 8
            let available = bytes.count - body
            guard available >= 0 else { break }
            let length = min(max(0, size), available)

            if id == "fmt " {
                guard length >= 16 else { return nil }
                format = Format(
                    audioFormat: Int(readUInt16LE(bytes, at: body)),
                    channels: Int(readUInt16LE(bytes, at: body + 2)),
                    sampleRateHz: Int(readUInt32LE(bytes, at: body + 4)),
                    byteRate: Int(readUInt32LE(bytes, at: body + 8)),
                    bitsPerSample: Int(readUInt16LE(bytes, at: body + 14))
                )
            } else if id == "data" {
                // `data` 크기가 0/0xFFFFFFFF 면 남은 파일 바이트를 쓴다.
                // 파일 앞부분만 읽은 경우에도 선언 크기를 신뢰하되, 전체 파일
                // 크기를 알면 그 범위를 넘지 않게 자른다.
                let availableInFile = fileSize.map { max(0, $0 - body) }
                let dataBytes: Int
                if size > 0, size != Int(UInt32.max) {
                    dataBytes = min(size, availableInFile ?? size)
                } else {
                    dataBytes = availableInFile ?? available
                }
                if let format {
                    return make(format: format, dataBytes: dataBytes)
                }
            }

            // 잘린 청크 이후는 더 읽을 수 없다.
            if size > available { break }
            offset = body + size + (size & 1)
        }

        return nil
    }

    private struct Format {
        let audioFormat: Int
        let channels: Int
        let sampleRateHz: Int
        let byteRate: Int
        let bitsPerSample: Int
    }

    private static func make(format: Format, dataBytes: Int) -> WavMetadata? {
        guard
            dataBytes > 0,
            format.channels > 0,
            format.sampleRateHz > 0
        else {
            return nil
        }

        let bytesPerSecond = format.byteRate > 0
            ? format.byteRate
            : format.sampleRateHz * format.channels * max(1, format.bitsPerSample / 8)
        guard bytesPerSecond > 0 else { return nil }

        let durationMs = max(1, Int((Double(dataBytes) * 1000.0 / Double(bytesPerSecond)).rounded()))

        return WavMetadata(
            codec: codec(format: format.audioFormat, bitsPerSample: format.bitsPerSample),
            sampleRateHz: format.sampleRateHz,
            channels: format.channels,
            bitsPerSample: format.bitsPerSample,
            durationMs: durationMs,
            dataBytes: dataBytes
        )
    }

    private static func codec(format: Int, bitsPerSample: Int) -> String {
        switch format {
        case 1:
            if bitsPerSample == 8 { return "wav_pcm_u8" }
            if bitsPerSample == 16 { return "wav_pcm_s16le" }
            return "wav_pcm_s\(bitsPerSample)le"
        case 0x11:
            return "wav_ima_adpcm"
        default:
            return "wav_format_\(format)"
        }
    }

    private static func ascii(_ bytes: [UInt8], at offset: Int, length: Int) -> String? {
        guard offset >= 0, offset + length <= bytes.count else { return nil }
        return String(bytes: bytes[offset..<(offset + length)], encoding: .ascii)
    }

    private static func readUInt16LE(_ bytes: [UInt8], at offset: Int) -> UInt16 {
        UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
    }

    private static func readUInt32LE(_ bytes: [UInt8], at offset: Int) -> UInt32 {
        UInt32(bytes[offset])
            | (UInt32(bytes[offset + 1]) << 8)
            | (UInt32(bytes[offset + 2]) << 16)
            | (UInt32(bytes[offset + 3]) << 24)
    }
}
