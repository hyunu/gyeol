import Foundation

/// BLE notification 은 MTU 단위로 쪼개진다. 바이트 스트림에서 완전한 프레임만 꺼낸다.
/// 잘못된 프레임을 만나면 magic("GY")을 찾아 재동기화한다.
public final class BleFrameStream {
    private var buffer = Data()
    private static let magic: [UInt8] = [0x47, 0x59]

    public init() {}

    public func append(_ data: Data) -> [BleFrame] {
        buffer.append(data)
        var frames: [BleFrame] = []

        while true {
            let bytes = [UInt8](buffer)
            guard let start = firstMagic(in: bytes, from: 0) else {
                if buffer.count < 2 { break }
                buffer.removeAll()
                break
            }
            if start > 0 {
                buffer.removeFirst(start)
                continue
            }
            guard bytes.count >= BleProtocol.headerBytes else { break }

            let length = (Int(bytes[10]) << 8) | Int(bytes[11])
            if length > BleProtocol.maxPayloadBytes {
                buffer.removeFirst(1)
                continue
            }
            let total = BleProtocol.headerBytes + length
            if bytes.count < total {
                // 길이 필드가 깨져 더 큰 프레임을 기다리는 상태일 수 있다.
                // 뒤에 다른 magic 이 있으면 그쪽으로 이동해 재동기화한다.
                if let next = firstMagic(in: bytes, from: 1) {
                    buffer.removeFirst(next)
                    continue
                }
                break
            }

            let candidate = Data(bytes[0..<total])
            do {
                frames.append(try BleProtocol.decode(candidate))
                buffer.removeFirst(total)
            } catch {
                buffer.removeFirst(1)
            }
        }
        return frames
    }

    private func firstMagic(in bytes: [UInt8], from offset: Int) -> Int? {
        guard bytes.count >= 2 else { return nil }
        var index = offset
        while index + 1 < bytes.count {
            if bytes[index] == Self.magic[0] && bytes[index + 1] == Self.magic[1] {
                return index
            }
            index += 1
        }
        return nil
    }
}
