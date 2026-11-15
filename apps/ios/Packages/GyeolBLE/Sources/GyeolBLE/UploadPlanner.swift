import Foundation

/// 업로드 상태 머신의 순수 계산 규칙.
///
/// 네트워크·파일 시스템과 분리해 두어 시뮬레이터 없이 검증한다.
public enum UploadPlanner {
    /// 다음에 보낼 청크 범위. 이미 끝났으면 nil.
    public static func nextRange(
        offset: Int,
        totalBytes: Int,
        chunkSizeBytes: Int
    ) -> Range<Int>? {
        guard offset >= 0, totalBytes > 0, chunkSizeBytes > 0, offset < totalBytes else {
            return nil
        }
        let end = min(totalBytes, offset + chunkSizeBytes)
        return offset..<end
    }

    /// 409 `OFFSET_MISMATCH` 의 상세 문자열에서 서버가 기대하는 오프셋을 읽는다.
    ///
    /// 서버는 `expected=<서버가 받은 바이트> received=<클라이언트가 보낸 오프셋>` 형태로
    /// 응답한다(`apps/api/src/domain/errors.ts`). 재개 지점은 `expected` 다.
    /// 혹시 형식이 바뀌어 `expected` 가 없으면 `received` 로 폴백한다.
    public static func recoverOffset(fromProblemDetail detail: String) -> Int? {
        if let value = integer(after: "expected=", in: detail) {
            return value
        }
        return integer(after: "received=", in: detail)
    }

    private static func integer(after marker: String, in text: String) -> Int? {
        guard let range = text.range(of: marker) else { return nil }
        let digits = text[range.upperBound...].prefix { $0.isNumber }
        guard !digits.isEmpty else { return nil }
        return Int(digits)
    }
}

/// 파일 하나의 서버 업로드 진행 상태. 앱 재시작 후 이어 보내기 위해 저장한다.
public enum UploadPhase: String, Codable, Sendable {
    /// 아직 서버에 녹음을 등록하지 않음.
    case ready
    /// 청크를 보내는 중.
    case uploading
    /// 모든 바이트 전송 + 서버 무결성 검증 완료. ACK 전.
    case uploaded
    /// `/ack` 완료. 원본 삭제 조건(5) 충족.
    case acked
    /// `/analyze` 등록 완료.
    case analyzing
    /// 복구할 수 없는 오류(무결성 실패 등).
    case failed
}

public struct UploadCheckpoint: Codable, Equatable, Sendable {
    public var clientRecordingId: String
    public var deviceId: String?
    public var recordingId: String?
    public var sessionId: String?
    public var startedAt: Date
    public var durationMs: Int
    public var codec: String
    public var sampleRateHz: Int
    public var channels: Int
    public var byteSize: Int
    public var sha256: String
    public var chunkSizeBytes: Int
    public var uploadedBytes: Int
    public var phase: UploadPhase
    public var analysisJobId: String?
    public var updatedAt: Date

    public init(
        clientRecordingId: String,
        deviceId: String? = nil,
        recordingId: String? = nil,
        sessionId: String? = nil,
        startedAt: Date,
        durationMs: Int,
        codec: String,
        sampleRateHz: Int,
        channels: Int,
        byteSize: Int,
        sha256: String,
        chunkSizeBytes: Int = 256 * 1024,
        uploadedBytes: Int = 0,
        phase: UploadPhase = .ready,
        analysisJobId: String? = nil,
        updatedAt: Date = Date()
    ) {
        self.clientRecordingId = clientRecordingId
        self.deviceId = deviceId
        self.recordingId = recordingId
        self.sessionId = sessionId
        self.startedAt = startedAt
        self.durationMs = durationMs
        self.codec = codec
        self.sampleRateHz = sampleRateHz
        self.channels = channels
        self.byteSize = byteSize
        self.sha256 = sha256
        self.chunkSizeBytes = chunkSizeBytes
        self.uploadedBytes = uploadedBytes
        self.phase = phase
        self.analysisJobId = analysisJobId
        self.updatedAt = updatedAt
    }

    public var endedAt: Date {
        startedAt.addingTimeInterval(Double(durationMs) / 1000.0)
    }

    public var progress: Double {
        guard byteSize > 0 else { return 0 }
        return min(1, max(0, Double(uploadedBytes) / Double(byteSize)))
    }
}
