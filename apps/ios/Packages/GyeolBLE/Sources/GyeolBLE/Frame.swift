import Foundation

/// GYEOL BLE 프레임 (docs/12-ble-protocol.md, W-20).
public enum BleFrameType: UInt8, Sendable {
    case hello = 0x01
    case helloAck = 0x02
    case listRequest = 0x03
    case listResponse = 0x04
    case openRequest = 0x05
    case openResponse = 0x06
    case data = 0x07
    case ack = 0x08
    case completeRequest = 0x09
    case completeResponse = 0x0a
    case error = 0x0b
}

public struct BleFrame: Sendable, Equatable {
    public let type: BleFrameType
    public let seq: UInt32
    public let flags: UInt8
    public let payload: Data

    public init(type: BleFrameType, seq: UInt32, flags: UInt8 = 0, payload: Data = Data()) {
        self.type = type
        self.seq = seq
        self.flags = flags
        self.payload = payload
    }

    public var isLast: Bool { flags & 0x01 != 0 }
}

public struct BleFrameError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "\(code): \(message)" }
}

public enum BleProtocol {
    public static let magic = Data([0x47, 0x59]) // "GY"
    public static let version: UInt8 = 1
    public static let headerBytes = 16
    public static let maxPayloadBytes = 512
    public static let maxFrameBytes = headerBytes + maxPayloadBytes
    public static let recommendedChunkBytes = 220
    public static let serviceUUID = "8f2d0001-7b1e-4c3a-9f4d-5a6b7c8d9e01"
    public static let txUUID = "8f2d0002-7b1e-4c3a-9f4d-5a6b7c8d9e01"
    public static let rxUUID = "8f2d0003-7b1e-4c3a-9f4d-5a6b7c8d9e01"

    public static func encode(_ frame: BleFrame) throws -> Data {
        guard frame.payload.count <= maxPayloadBytes else {
            throw BleFrameError("PAYLOAD_TOO_LARGE", "payload 가 \(maxPayloadBytes)바이트를 초과했습니다.")
        }
        var header = Data(capacity: headerBytes)
        header.append(magic)
        header.append(version)
        header.append(frame.type.rawValue)
        header.append(frame.flags)
        header.append(0)
        header.append(contentsOf: withUnsafeBytes(of: frame.seq.bigEndian, Array.init))
        header.append(contentsOf: withUnsafeBytes(of: UInt16(frame.payload.count).bigEndian, Array.init))
        let crc = crc32(header + frame.payload)
        header.append(contentsOf: withUnsafeBytes(of: crc.bigEndian, Array.init))
        return header + frame.payload
    }

    public static func decode(_ bytes: Data) throws -> BleFrame {
        guard bytes.count >= headerBytes else {
            throw BleFrameError("FRAME_TOO_SHORT", "프레임이 \(headerBytes)바이트보다 짧습니다.")
        }
        guard bytes.count <= maxFrameBytes else {
            throw BleFrameError("FRAME_TOO_LARGE", "프레임이 \(maxFrameBytes)바이트를 초과했습니다.")
        }
        guard bytes.prefix(2) == magic else {
            throw BleFrameError("BAD_MAGIC", "magic 이 GY 가 아닙니다.")
        }
        guard bytes[2] == version else {
            throw BleFrameError("UNSUPPORTED_VERSION", "지원하지 않는 버전입니다: \(bytes[2])")
        }
        guard let type = BleFrameType(rawValue: bytes[3]) else {
            throw BleFrameError("UNKNOWN_TYPE", "알 수 없는 프레임 타입입니다: \(bytes[3])")
        }
        guard bytes[5] == 0 else {
            throw BleFrameError("BAD_RESERVED", "reserved 바이트가 0 이 아닙니다.")
        }
        let seq = bytes.readUInt32BE(at: 6)
        let payloadLength = Int(bytes.readUInt16BE(at: 10))
        guard payloadLength <= maxPayloadBytes else {
            throw BleFrameError("PAYLOAD_TOO_LARGE", "payload 길이가 너무 큽니다: \(payloadLength)")
        }
        guard bytes.count == headerBytes + payloadLength else {
            throw BleFrameError("LENGTH_MISMATCH", "선언된 길이와 실제 프레임이 다릅니다.")
        }
        let payload = bytes.subdata(in: headerBytes..<bytes.count)
        let expected = crc32(bytes.prefix(12) + payload)
        let actual = bytes.readUInt32BE(at: 12)
        guard expected == actual else {
            throw BleFrameError("BAD_CRC", "CRC32 가 일치하지 않습니다.")
        }
        return BleFrame(type: type, seq: seq, flags: bytes[4], payload: payload)
    }

    // ---------------------------------------------------------------- payload

    public static func jsonPayload<T: Encodable>(_ value: T) throws -> Data {
        try JSONEncoder().encode(value)
    }

    public static func parseJSON<T: Decodable>(_ type: T.Type, from payload: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: payload)
        } catch {
            throw BleFrameError("BAD_JSON", "payload 를 디코딩할 수 없습니다: \(error)")
        }
    }

    public static func dataPayload(offset: UInt64, data: Data) -> Data {
        var payload = Data(capacity: 8 + data.count)
        payload.append(contentsOf: withUnsafeBytes(of: offset.bigEndian, Array.init))
        payload.append(data)
        return payload
    }

    public static func parseDataPayload(_ payload: Data) throws -> (offset: UInt64, data: Data) {
        guard payload.count >= 8 else {
            throw BleFrameError("BAD_DATA", "DATA payload 가 8바이트보다 짧습니다.")
        }
        let offset = payload.readUInt64BE(at: 0)
        return (offset, payload.subdata(in: 8..<payload.count))
    }

    // ------------------------------------------------------------------- crc

    public static func crc32(_ bytes: Data) -> UInt32 {
        var crc: UInt32 = 0xffff_ffff
        for byte in bytes {
            crc = crcTable[Int((crc ^ UInt32(byte)) & 0xff)] ^ (crc >> 8)
        }
        return crc ^ 0xffff_ffff
    }

    private static let crcTable: [UInt32] = (0..<256).map { index in
        var value = UInt32(index)
        for _ in 0..<8 {
            value = value & 1 != 0 ? 0xedb8_8320 ^ (value >> 1) : value >> 1
        }
        return value
    }
}

private extension Data {
    func readUInt16BE(at offset: Int) -> UInt16 {
        (UInt16(self[offset]) << 8) | UInt16(self[offset + 1])
    }

    func readUInt32BE(at offset: Int) -> UInt32 {
        (UInt32(self[offset]) << 24)
            | (UInt32(self[offset + 1]) << 16)
            | (UInt32(self[offset + 2]) << 8)
            | UInt32(self[offset + 3])
    }

    func readUInt64BE(at offset: Int) -> UInt64 {
        (UInt64(readUInt32BE(at: offset)) << 32) | UInt64(readUInt32BE(at: offset + 4))
    }
}
