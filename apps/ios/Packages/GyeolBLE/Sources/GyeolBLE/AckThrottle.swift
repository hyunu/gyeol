import Foundation

/// 수신 ACK 를 파일 단위로 묶어 보내는 상태.
///
/// `receivedBytes` 는 파일마다 0부터 다시 시작한다. 파일이 바뀌면 이전 파일의
/// 누적값과 비교하지 않도록 상태를 리셋한다. 그렇지 않으면 두 번째 파일에서
/// `bytes - lastAckSent` 가 음수가 되어 중간 ACK 가 전부 억제되고, 송신측
/// 윈도가 차서 전송이 멈출 수 있다.
public struct AckThrottle {
    /// 현재 파일에서 마지막으로 관찰한 누적 수신 바이트.
    public private(set) var receivedBytes = 0
    /// 현재 파일의 clientRecordingId.
    public private(set) var clientRecordingId: String?

    private var lastAckSent = 0
    private let thresholdBytes: Int

    public init(thresholdBytes: Int = 4 * BleProtocol.recommendedChunkBytes) {
        self.thresholdBytes = max(1, thresholdBytes)
    }

    /// 연결이 끊기거나 새 전송을 시작할 때 호출한다.
    public mutating func reset() {
        receivedBytes = 0
        clientRecordingId = nil
        lastAckSent = 0
    }

    /// 이 ACK 를 실제로 보낼지 결정한다.
    ///
    /// - 마지막 프레임(`isLast`)은 항상 보낸다.
    /// - 그 외에는 파일별 누적 바이트가 임계값 이상 진행됐을 때만 보낸다.
    public mutating func shouldSend(
        clientRecordingId: String,
        receivedBytes bytes: Int,
        isLast: Bool
    ) -> Bool {
        if self.clientRecordingId != clientRecordingId {
            self.clientRecordingId = clientRecordingId
            receivedBytes = 0
            lastAckSent = 0
        }

        receivedBytes = max(receivedBytes, bytes)

        if !isLast && bytes - lastAckSent < thresholdBytes {
            return false
        }
        lastAckSent = max(lastAckSent, bytes)
        return true
    }
}
