#include "protocol.h"

#include <cstring>

namespace gyeol {
namespace {

uint32_t table[256];
bool tableReady = false;

void ensureTable() {
  if (tableReady) return;
  for (uint32_t index = 0; index < 256; ++index) {
    uint32_t value = index;
    for (int bit = 0; bit < 8; ++bit) {
      value = (value & 1) ? (0xedb88320u ^ (value >> 1)) : (value >> 1);
    }
    table[index] = value;
  }
  tableReady = true;
}

void writeU16(uint8_t *out, uint16_t value) {
  out[0] = static_cast<uint8_t>(value >> 8);
  out[1] = static_cast<uint8_t>(value);
}

void writeU32(uint8_t *out, uint32_t value) {
  out[0] = static_cast<uint8_t>(value >> 24);
  out[1] = static_cast<uint8_t>(value >> 16);
  out[2] = static_cast<uint8_t>(value >> 8);
  out[3] = static_cast<uint8_t>(value);
}

uint16_t readU16(const uint8_t *in) {
  return static_cast<uint16_t>((static_cast<uint16_t>(in[0]) << 8) | in[1]);
}

uint32_t readU32(const uint8_t *in) {
  return (static_cast<uint32_t>(in[0]) << 24) | (static_cast<uint32_t>(in[1]) << 16) |
         (static_cast<uint32_t>(in[2]) << 8) | static_cast<uint32_t>(in[3]);
}

}  // namespace

uint32_t crc32(const uint8_t *data, size_t length) {
  ensureTable();
  uint32_t crc = 0xffffffffu;
  for (size_t i = 0; i < length; ++i) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
  }
  return crc ^ 0xffffffffu;
}

std::vector<uint8_t> encodeFrame(const Frame &frame) {
  std::vector<uint8_t> out(HEADER_BYTES + frame.payload.size());
  out[0] = 0x47;
  out[1] = 0x59;
  out[2] = 1;
  out[3] = frame.type;
  out[4] = frame.flags;
  out[5] = 0;
  writeU32(&out[6], frame.seq);
  writeU16(&out[10], static_cast<uint16_t>(frame.payload.size()));
  uint32_t crc = crc32(out.data(), 12);
  if (!frame.payload.empty()) {
    memcpy(out.data() + HEADER_BYTES, frame.payload.data(), frame.payload.size());
    // CRC 는 헤더 0..11 + payload 전체를 덮는다.
    std::vector<uint8_t> temp(12 + frame.payload.size());
    memcpy(temp.data(), out.data(), 12);
    memcpy(temp.data() + 12, frame.payload.data(), frame.payload.size());
    crc = crc32(temp.data(), temp.size());
  }
  writeU32(&out[12], crc);
  return out;
}

bool decodeFrame(const uint8_t *data, size_t length, Frame &out) {
  if (length < HEADER_BYTES || length > HEADER_BYTES + MAX_PAYLOAD_BYTES) return false;
  if (data[0] != 0x47 || data[1] != 0x59) return false;
  if (data[2] != 1) return false;
  if (data[5] != 0) return false;
  const uint16_t payloadLength = readU16(&data[10]);
  if (payloadLength > MAX_PAYLOAD_BYTES) return false;
  if (length != HEADER_BYTES + payloadLength) return false;

  std::vector<uint8_t> temp(12 + payloadLength);
  memcpy(temp.data(), data, 12);
  if (payloadLength > 0) memcpy(temp.data() + 12, data + HEADER_BYTES, payloadLength);
  const uint32_t expected = crc32(temp.data(), temp.size());
  if (expected != readU32(&data[12])) return false;

  out.type = data[3];
  out.flags = data[4];
  out.seq = readU32(&data[6]);
  out.payload.assign(data + HEADER_BYTES, data + HEADER_BYTES + payloadLength);
  return true;
}

std::vector<uint8_t> jsonEncode(const char *json) {
  return std::vector<uint8_t>(json, json + strlen(json));
}

std::vector<uint8_t> dataPayload(uint64_t offset, const uint8_t *data, size_t length) {
  std::vector<uint8_t> payload(8 + length);
  for (int i = 0; i < 8; ++i) {
    payload[i] = static_cast<uint8_t>(offset >> ((7 - i) * 8));
  }
  if (length > 0) memcpy(payload.data() + 8, data, length);
  return payload;
}

}  // namespace gyeol
