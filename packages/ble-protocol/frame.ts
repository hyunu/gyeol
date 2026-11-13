/**
 * GYEOL BLE 프레임 코덱 (W-20).
 *
 * GATT characteristic 값 하나에 프레임 하나를 담는다. 프레임은 16바이트 헤더와
 * 최대 512바이트 payload 로 구성된다. 권장 payload 는 240바이트(MTU 247)다.
 *
 * 헤더
 *   0..1   magic "GY"
 *   2      version (1)
 *   3      type
 *   4      flags (bit0 = LAST)
 *   5      reserved (0)
 *   6..9   seq uint32 BE
 *   10..11 payloadLength uint16 BE
 *   12..15 crc32 BE over header[0..11] + payload
 */

export const MAGIC = Buffer.from([0x47, 0x59]); // "GY"
export const PROTOCOL_VERSION = 1;
export const HEADER_BYTES = 16;
export const MAX_PAYLOAD_BYTES = 512;
export const MAX_FRAME_BYTES = HEADER_BYTES + MAX_PAYLOAD_BYTES;
export const RECOMMENDED_CHUNK_BYTES = 240;

export const FLAG_LAST = 0x01;

export const FrameType = {
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  LIST_REQ: 0x03,
  LIST_RES: 0x04,
  OPEN_REQ: 0x05,
  OPEN_RES: 0x06,
  DATA: 0x07,
  ACK: 0x08,
  COMPLETE_REQ: 0x09,
  COMPLETE_RES: 0x0a,
  ERROR: 0x0b,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  type: FrameTypeValue;
  seq: number;
  flags: number;
  payload: Buffer;
}

export class FrameError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FrameError";
    this.code = code;
  }
}

export function encodeFrame(frame: Frame): Buffer {
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > 0xffffffff) {
    throw new FrameError("BAD_SEQ", `seq 범위를 벗어났습니다: ${frame.seq}`);
  }
  if (frame.payload.length > MAX_PAYLOAD_BYTES) {
    throw new FrameError(
      "PAYLOAD_TOO_LARGE",
      `payload 가 ${MAX_PAYLOAD_BYTES} 바이트를 초과했습니다: ${frame.payload.length}`,
    );
  }

  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt8(PROTOCOL_VERSION, 2);
  header.writeUInt8(frame.type, 3);
  header.writeUInt8(frame.flags & 0xff, 4);
  header.writeUInt8(0, 5);
  header.writeUInt32BE(frame.seq, 6);
  header.writeUInt16BE(frame.payload.length, 10);
  header.writeUInt32BE(crc32(Buffer.concat([header.subarray(0, 12), frame.payload])), 12);
  return Buffer.concat([header, frame.payload]);
}

export function decodeFrame(bytes: Buffer): Frame {
  if (bytes.length < HEADER_BYTES) {
    throw new FrameError("FRAME_TOO_SHORT", `프레임이 ${HEADER_BYTES}바이트보다 짧습니다.`);
  }
  if (bytes.length > MAX_FRAME_BYTES) {
    throw new FrameError("FRAME_TOO_LARGE", `프레임이 ${MAX_FRAME_BYTES}바이트를 초과했습니다.`);
  }
  if (!bytes.subarray(0, 2).equals(MAGIC)) {
    throw new FrameError("BAD_MAGIC", "magic 이 GY 가 아닙니다.");
  }
  const version = bytes.readUInt8(2);
  if (version !== PROTOCOL_VERSION) {
    throw new FrameError("UNSUPPORTED_VERSION", `지원하지 않는 버전입니다: ${version}`);
  }
  const type = bytes.readUInt8(3);
  if (!isFrameType(type)) {
    throw new FrameError("UNKNOWN_TYPE", `알 수 없는 프레임 타입입니다: ${type}`);
  }
  if (bytes.readUInt8(5) !== 0) {
    throw new FrameError("BAD_RESERVED", "reserved 바이트가 0 이 아닙니다.");
  }

  const seq = bytes.readUInt32BE(6);
  const payloadLength = bytes.readUInt16BE(10);
  if (payloadLength > MAX_PAYLOAD_BYTES) {
    throw new FrameError("PAYLOAD_TOO_LARGE", `payload 길이가 너무 큽니다: ${payloadLength}`);
  }
  if (bytes.length !== HEADER_BYTES + payloadLength) {
    throw new FrameError(
      "LENGTH_MISMATCH",
      `선언된 길이(${payloadLength})와 실제 프레임이 다릅니다.`,
    );
  }

  const payload = bytes.subarray(HEADER_BYTES);
  const expected = crc32(Buffer.concat([bytes.subarray(0, 12), payload]));
  const actual = bytes.readUInt32BE(12);
  if (expected !== actual) {
    throw new FrameError("BAD_CRC", "CRC32 가 일치하지 않습니다.");
  }

  return { type, seq, flags: bytes.readUInt8(4), payload: Buffer.from(payload) };
}

function isFrameType(value: number): value is FrameTypeValue {
  return Object.values(FrameType).includes(value as FrameTypeValue);
}

// ---------------------------------------------------------------- payload helpers

export function jsonPayload(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

export function parseJsonPayload<T>(frame: Frame): T {
  try {
    return JSON.parse(frame.payload.toString("utf8")) as T;
  } catch {
    throw new FrameError("BAD_JSON", `${frame.type} payload 가 JSON 이 아닙니다.`);
  }
}

export function dataPayload(offset: number | bigint, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(offset));
  return Buffer.concat([header, data]);
}

export function parseDataPayload(payload: Buffer): { offset: number; data: Buffer } {
  if (payload.length < 8) throw new FrameError("BAD_DATA", "DATA payload 가 8바이트보다 짧습니다.");
  const offset = Number(payload.readBigUInt64BE(0));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new FrameError("BAD_OFFSET", `오프셋이 안전한 정수가 아닙니다: ${offset}`);
  }
  return { offset, data: payload.subarray(8) };
}

// ------------------------------------------------------------------------ CRC32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
