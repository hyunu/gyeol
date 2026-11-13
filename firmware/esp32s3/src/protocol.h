#pragma once

#include <Arduino.h>
#include <vector>

// docs/12-ble-protocol.md 의 프레임을 그대로 구현한다.
namespace gyeol {

enum FrameType : uint8_t {
  HELLO = 0x01,
  HELLO_ACK = 0x02,
  LIST_REQ = 0x03,
  LIST_RES = 0x04,
  OPEN_REQ = 0x05,
  OPEN_RES = 0x06,
  DATA = 0x07,
  ACK = 0x08,
  COMPLETE_REQ = 0x09,
  COMPLETE_RES = 0x0a,
  ERROR = 0x0b,
};

constexpr uint8_t FLAG_LAST = 0x01;
constexpr size_t HEADER_BYTES = 16;
constexpr size_t MAX_PAYLOAD_BYTES = 512;
constexpr size_t RECOMMENDED_CHUNK_BYTES = 220;

constexpr char SERVICE_UUID[] = "8f2d0001-7b1e-4c3a-9f4d-5a6b7c8d9e01";
constexpr char TX_UUID[] = "8f2d0002-7b1e-4c3a-9f4d-5a6b7c8d9e01";
constexpr char RX_UUID[] = "8f2d0003-7b1e-4c3a-9f4d-5a6b7c8d9e01";

struct Frame {
  uint8_t type = 0;
  uint32_t seq = 0;
  uint8_t flags = 0;
  std::vector<uint8_t> payload;
};

uint32_t crc32(const uint8_t *data, size_t length);
std::vector<uint8_t> encodeFrame(const Frame &frame);
bool decodeFrame(const uint8_t *data, size_t length, Frame &out);

std::vector<uint8_t> jsonEncode(const char *json);
std::vector<uint8_t> dataPayload(uint64_t offset, const uint8_t *data, size_t length);

}  // namespace gyeol
