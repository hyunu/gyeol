// GYEOL 웨어러블 펌웨어 — ESP32-S3 개발 보드 변형
//
// 스펙 대상은 XIAO nRF52840 Sense 이며 아직 HW-PENDING 이다. 연결된 ESP32-S3 로
// BLE 프로토콜(docs/12-ble-protocol.md), microSD 저장, PDM 녹음을 먼저 검증한다.
// 프로토콜·파일 형식은 MCU 독립적이므로 nRF52840 포팅 시에도 그대로 쓴다.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <FS.h>
#include <LittleFS.h>
#include <SD.h>
#include <SPI.h>
#include <driver/i2s.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <mbedtls/sha256.h>

#include "protocol.h"

namespace {

constexpr int PIN_PDM_CLK = 42;
constexpr int PIN_PDM_DATA = 41;
constexpr int PIN_SD_CS = 21;
constexpr int PIN_SD_SCK = 7;
constexpr int PIN_SD_MISO = 8;
constexpr int PIN_SD_MOSI = 9;

constexpr uint32_t SAMPLE_RATE = 16000;
constexpr uint32_t RECORD_SECONDS = 5;
constexpr size_t CHUNK_BYTES = gyeol::RECOMMENDED_CHUNK_BYTES;
constexpr int WINDOW_FRAMES = 8;
constexpr const char *FIRMWARE_VERSION = "0.1.0-esp32s3";

BLECharacteristic *txCharacteristic = nullptr;
BLECharacteristic *rxCharacteristic = nullptr;
QueueHandle_t rxQueue = nullptr;
bool connected = false;
bool helloPending = false;
uint32_t txSeq = 0;

fs::FS *storage = nullptr;
size_t storageFreeBytes();

struct CurrentFile {
  bool valid = false;
  String id;
  String path;
  size_t size = 0;
  String sha256;
  size_t acked = 0;
  size_t nextOffset = 0;
  bool completeSent = false;
} currentFile;
uint32_t lastTxAt = 0;
int retryCount = 0;
bool transferActive = false;

// ------------------------------------------------------------------ WAV / SD

void writeU32LE(File &file, uint32_t value) {
  uint8_t bytes[4] = {
      static_cast<uint8_t>(value), static_cast<uint8_t>(value >> 8),
      static_cast<uint8_t>(value >> 16), static_cast<uint8_t>(value >> 24)};
  file.write(bytes, 4);
}

void writeU16LE(File &file, uint16_t value) {
  uint8_t bytes[2] = {static_cast<uint8_t>(value), static_cast<uint8_t>(value >> 8)};
  file.write(bytes, 2);
}

void writeWavHeader(File &file, uint32_t dataBytes) {
  file.seek(0);
  file.write(reinterpret_cast<const uint8_t *>("RIFF"), 4);
  writeU32LE(file, 36 + dataBytes);
  file.write(reinterpret_cast<const uint8_t *>("WAVE"), 4);
  file.write(reinterpret_cast<const uint8_t *>("fmt "), 4);
  writeU32LE(file, 16);
  writeU16LE(file, 1);  // PCM
  writeU16LE(file, 1);  // mono
  writeU32LE(file, SAMPLE_RATE);
  writeU32LE(file, SAMPLE_RATE * 2);
  writeU16LE(file, 2);
  writeU16LE(file, 16);
  file.write(reinterpret_cast<const uint8_t *>("data"), 4);
  writeU32LE(file, dataBytes);
}

String sha256File(const String &path) {
  if (storage == nullptr) return "";
  File file = storage->open(path, FILE_READ);
  if (!file) return "";

  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  mbedtls_sha256_starts(&context, 0);

  uint8_t buffer[4096];
  while (file.available()) {
    const size_t read = file.read(buffer, sizeof(buffer));
    if (read > 0) mbedtls_sha256_update(&context, buffer, read);
  }
  file.close();

  uint8_t digest[32];
  mbedtls_sha256_finish(&context, digest);
  mbedtls_sha256_free(&context);

  char hex[65];
  for (int i = 0; i < 32; ++i) snprintf(hex + i * 2, 3, "%02x", digest[i]);
  return String(hex);
}

bool initStorage() {
  SPI.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, PIN_SD_CS);
  const uint32_t rates[] = {8000000, 4000000, 1000000};
  bool mounted = false;
  for (uint32_t rate : rates) {
    Serial.printf("[storage] SD 시도 %u Hz\n", static_cast<unsigned>(rate));
    if (SD.begin(PIN_SD_CS, SPI, rate)) {
      mounted = true;
      storage = &SD;
      Serial.printf("[storage] SD mounted, card=%llu MB at %u Hz\n",
                    SD.cardSize() / (1024ULL * 1024ULL), static_cast<unsigned>(rate));
      break;
    }
    SD.end();
    delay(100);
  }

  if (!mounted) {
    Serial.println("[storage] SD 없음 → LittleFS 사용");
    if (!LittleFS.begin(true)) {
      Serial.println("[storage] LittleFS mount failed");
      return false;
    }
    storage = &LittleFS;
  }
  storage->mkdir("/recordings");
  return true;
}

bool initPdm() {
  i2s_config_t config = {};
  config.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM);
  config.sample_rate = SAMPLE_RATE;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  config.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 4;
  config.dma_buf_len = 256;
  config.use_apll = false;
  config.tx_desc_auto_clear = false;
  config.fixed_mclk = 0;

  if (i2s_driver_install(I2S_NUM_0, &config, 0, nullptr) != ESP_OK) {
    Serial.println("[pdm] driver install failed");
    return false;
  }
  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
  pins.bck_io_num = I2S_PIN_NO_CHANGE;
  pins.ws_io_num = PIN_PDM_CLK;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = PIN_PDM_DATA;
  if (i2s_set_pin(I2S_NUM_0, &pins) != ESP_OK) {
    Serial.println("[pdm] pin config failed");
    i2s_driver_uninstall(I2S_NUM_0);
    return false;
  }
  return true;
}

void stopPdm() { i2s_driver_uninstall(I2S_NUM_0); }

struct FrameStats {
  double mean = 0;
  double rms = 0;
  double peak = 0;
};

// DC 오프셋을 제거한 RMS/피크. PDM 마이크는 DC 성분이 커서 평균 절댓값만으로는
// 음성/톤을 구분하기 어렵다. VAD 는 peak 를 주 신호로 쓴다.
FrameStats frameStats(const uint8_t *bytes, size_t length) {
  const int16_t *samples = reinterpret_cast<const int16_t *>(bytes);
  const size_t count = length / 2;
  FrameStats stats;
  if (count == 0) return stats;

  double sum = 0;
  for (size_t i = 0; i < count; ++i) sum += samples[i];
  stats.mean = sum / count;

  double sumSq = 0;
  for (size_t i = 0; i < count; ++i) {
    const double value = samples[i] - stats.mean;
    sumSq += value * value;
    if (fabs(value) > stats.peak) stats.peak = fabs(value);
  }
  stats.rms = sqrt(sumSq / count);
  return stats;
}

// 에너지 기반 VAD: 0.5초 프리롤, 3프레임 연속 임계 초과 시 시작, 2초 무음 시 종료.
bool recordVadClip(const String &path, int maxSeconds) {
  constexpr int FRAME_SAMPLES = 320;  // 20ms
  constexpr int FRAME_BYTES = FRAME_SAMPLES * 2;
  constexpr int PREROLL_FRAMES = 25;
  constexpr int SILENCE_MS = 2000;
  constexpr size_t MIN_BYTES = 32000;   // 1초
  constexpr size_t MAX_BYTES = 600000;  // LittleFS 보호

  if (!initPdm()) return false;
  if (storageFreeBytes() < 700000) {
    Serial.println("[vad] 저장 공간 부족");
    stopPdm();
    return false;
  }
  File file = storage->open(path, FILE_WRITE);
  if (!file) {
    stopPdm();
    return false;
  }
  writeWavHeader(file, 0);

  uint8_t buffer[FRAME_BYTES];
  size_t got = 0;

  // 0.5초 캘리브레이션. 시작 과도음을 피하려고 뒤쪽 10프레임만 사용한다.
  double peaks[PREROLL_FRAMES];
  int calibrated = 0;
  for (int i = 0; i < PREROLL_FRAMES; ++i) {
    if (i2s_read(I2S_NUM_0, buffer, FRAME_BYTES, &got, pdMS_TO_TICKS(500)) != ESP_OK) break;
    if (got == 0) continue;
    peaks[calibrated % PREROLL_FRAMES] = frameStats(buffer, got).peak;
    calibrated += 1;
  }
  // 시작 과도음/톤이 캘리브레이션에 섞여도 임계값이 과대해지지 않도록 최솟값을 쓴다.
  double noisePeak = 1e9;
  const int noiseSamples = min(calibrated, 10);
  for (int i = 0; i < noiseSamples; ++i) noisePeak = min(noisePeak, peaks[(calibrated - 1 - i) % PREROLL_FRAMES]);
  if (noiseSamples == 0) noisePeak = 0;
  const double threshold = max(80.0, noisePeak * 3.0);
  Serial.printf("[vad] noisePeak=%.0f threshold=%.0f\n", noisePeak, threshold);

  std::vector<std::vector<int16_t>> preroll;
  bool recording = false;
  int speechRun = 0;
  int silenceMs = 0;
  size_t written = 0;
  double maxEnergy = 0;
  uint32_t lastVadLog = 0;
  const uint32_t startedAt = millis();

  while (static_cast<int>(millis() - startedAt) < maxSeconds * 1000) {
    if (i2s_read(I2S_NUM_0, buffer, FRAME_BYTES, &got, pdMS_TO_TICKS(500)) != ESP_OK) break;
    if (got == 0) continue;
    const FrameStats stats = frameStats(buffer, got);
    if (stats.peak > maxEnergy) maxEnergy = stats.peak;
    if (millis() - lastVadLog > 1000) {
      Serial.printf("[vad] peak=%.0f maxPeak=%.0f rms=%.0f recording=%d\n", stats.peak, maxEnergy,
                    stats.rms, recording ? 1 : 0);
      lastVadLog = millis();
    }

    if (!recording) {
      std::vector<int16_t> frame(reinterpret_cast<int16_t *>(buffer),
                                 reinterpret_cast<int16_t *>(buffer) + got / 2);
      preroll.push_back(frame);
      if (preroll.size() > PREROLL_FRAMES) preroll.erase(preroll.begin());
      if (stats.peak > threshold) speechRun += 1;
      else speechRun = 0;
      if (speechRun >= 3) {
        recording = true;
        speechRun = 0;
        for (const auto &saved : preroll) {
          file.write(reinterpret_cast<const uint8_t *>(saved.data()), saved.size() * 2);
          written += saved.size() * 2;
        }
        preroll.clear();
        Serial.println("[vad] speech start");
      }
    } else {
      file.write(buffer, got);
      written += got;
      if (stats.peak < threshold) silenceMs += 20;
      else silenceMs = 0;
      if (silenceMs >= SILENCE_MS) {
        Serial.println("[vad] silence stop");
        break;
      }
      if (written >= MAX_BYTES) {
        Serial.println("[vad] max size");
        break;
      }
    }
  }

  stopPdm();
  if (written < MIN_BYTES) {
    file.close();
    storage->remove(path);
    Serial.printf("[vad] too short (%u bytes)\n", static_cast<unsigned>(written));
    return false;
  }
  writeWavHeader(file, written);
  file.close();
  Serial.printf("[vad] recorded %u bytes\n", static_cast<unsigned>(written));
  return true;
}

// PDM 이 없거나 실패하면 전송 검증용 사인파를 만든다.
void writeTestWav(const String &path) {
  if (storage == nullptr) return;
  File file = storage->open(path, FILE_WRITE);
  if (!file) return;
  const size_t samples = SAMPLE_RATE * RECORD_SECONDS;
  writeWavHeader(file, samples * 2);
  for (size_t i = 0; i < samples; ++i) {
    const float phase = 2.0f * PI * 440.0f * static_cast<float>(i) / SAMPLE_RATE;
    const int16_t value = static_cast<int16_t>(sinf(phase) * 8000);
    file.write(reinterpret_cast<const uint8_t *>(&value), 2);
  }
  file.close();
  Serial.println("[test] wrote fallback sine wav");
}

String firstRecording() {
  File dir = storage->open("/recordings");
  if (!dir) return "";
  File entry = dir.openNextFile();
  while (entry) {
    String name = entry.name();
    if (!entry.isDirectory() && name.endsWith(".wav")) {
      String path = name.startsWith("/") ? name : String("/recordings/") + name;
      entry.close();
      dir.close();
      return path;
    }
    entry.close();
    entry = dir.openNextFile();
  }
  dir.close();
  return "";
}

String sidecarPath(const String &wavPath, const char *extension) {
  return wavPath.substring(0, wavPath.length() - 4) + extension;
}

String readSidecar(const String &wavPath, const char *extension) {
  File file = storage->open(sidecarPath(wavPath, extension), FILE_READ);
  if (!file) return "";
  String value = file.readString();
  file.close();
  value.trim();
  return value;
}

void writeSidecar(const String &wavPath, const char *extension, const String &value) {
  File file = storage->open(sidecarPath(wavPath, extension), FILE_WRITE);
  if (!file) return;
  file.print(value);
  file.close();
}

void selectCurrentFile(const String &path) {
  currentFile.valid = false;
  if (path.isEmpty() || storage == nullptr) return;
  File file = storage->open(path, FILE_READ);
  if (!file) return;
  currentFile.path = path;
  currentFile.size = file.size();
  file.close();

  String id = readSidecar(path, ".id");
  if (id.isEmpty()) id = path;
  String sha = readSidecar(path, ".sha256");
  if (sha.isEmpty()) {
    sha = sha256File(path);
    writeSidecar(path, ".sha256", sha);
  }
  currentFile.id = id;
  currentFile.sha256 = sha;
  currentFile.acked = 0;
  currentFile.valid = currentFile.size > 0;
  Serial.printf("[file] %s (%u bytes) %s\n", currentFile.id.c_str(),
                static_cast<unsigned>(currentFile.size), currentFile.sha256.c_str());
}

// ------------------------------------------------------------------ BLE send

void sendFrame(uint8_t type, const std::vector<uint8_t> &payload, uint8_t flags = 0) {
  if (!connected || txCharacteristic == nullptr) return;
  gyeol::Frame frame;
  frame.type = type;
  frame.seq = ++txSeq;
  frame.flags = flags;
  frame.payload = payload;
  std::vector<uint8_t> bytes = gyeol::encodeFrame(frame);
  txCharacteristic->setValue(bytes.data(), bytes.size());
  txCharacteristic->notify();
  delay(8);
}

String helloJson() {
  String json = "{\"serialNo\":\"";
  json += String(static_cast<uint32_t>(ESP.getEfuseMac()), HEX);
  json += "\",\"model\":\"esp32s3-dev\",\"firmwareVersion\":\"";
  json += FIRMWARE_VERSION;
  json += "\",\"pendingFiles\":";
  json += currentFile.valid ? "1" : "0";
  json += "}";
  return json;
}

String listJson() {
  String json = "{\"files\":[";
  if (currentFile.valid) {
    json += "{\"clientRecordingId\":\"";
    json += currentFile.id;
    json += "\",\"byteSize\":";
    json += currentFile.size;
    json += ",\"sha256\":\"";
    json += currentFile.sha256;
    json += "\"}";
  }
  json += "]}";
  return json;
}

void pump() {
  if (!currentFile.valid) return;
  const size_t windowBytes = static_cast<size_t>(WINDOW_FRAMES) * CHUNK_BYTES;
  if (currentFile.nextOffset < currentFile.acked) currentFile.nextOffset = currentFile.acked;
  if (currentFile.nextOffset > currentFile.size) return;

  File file = storage->open(currentFile.path, FILE_READ);
  if (!file) return;
  file.seek(currentFile.nextOffset);

  uint8_t buffer[CHUNK_BYTES];
  while (currentFile.nextOffset < currentFile.size &&
         currentFile.nextOffset - currentFile.acked < windowBytes) {
    const size_t want = min(CHUNK_BYTES, currentFile.size - currentFile.nextOffset);
    const size_t read = file.read(buffer, want);
    if (read == 0) break;
    const bool last = currentFile.nextOffset + read >= currentFile.size;
    sendFrame(gyeol::DATA, gyeol::dataPayload(currentFile.nextOffset, buffer, read),
              last ? gyeol::FLAG_LAST : 0);
    currentFile.nextOffset += read;
  }
  file.close();
  lastTxAt = millis();
}

void sendCompleteRequest() {
  String json = "{\"clientRecordingId\":\"";
  json += currentFile.id;
  json += "\",\"byteSize\":";
  json += currentFile.size;
  json += ",\"sha256\":\"";
  json += currentFile.sha256;
  json += "\"}";
  sendFrame(gyeol::COMPLETE_REQ, gyeol::jsonEncode(json.c_str()));
}

void handleFrame(const gyeol::Frame &frame) {
  switch (frame.type) {
    case gyeol::HELLO_ACK:
      Serial.println("[ble] hello_ack");
      helloPending = false;
      if (currentFile.valid) {
        String json = "{\"clientRecordingId\":\"";
        json += currentFile.id;
        json += "\"}";
        sendFrame(gyeol::OPEN_REQ, gyeol::jsonEncode(json.c_str()));
      }
      break;

    case gyeol::LIST_REQ:
      sendFrame(gyeol::LIST_RES, gyeol::jsonEncode(listJson().c_str()));
      break;

    case gyeol::OPEN_RES: {
      JsonDocument doc;
      if (deserializeJson(doc, frame.payload.data(), frame.payload.size()) != DeserializationError::Ok) {
        return;
      }
      const size_t startOffset = doc["startOffset"] | 0;
      Serial.printf("[ble] open_res start=%u\n", static_cast<unsigned>(startOffset));
      currentFile.acked = startOffset;
      currentFile.nextOffset = startOffset;
      currentFile.completeSent = false;
      transferActive = true;
      pump();
      break;
    }

    case gyeol::ACK: {
      JsonDocument doc;
      if (deserializeJson(doc, frame.payload.data(), frame.payload.size()) != DeserializationError::Ok) {
        return;
      }
      const size_t received = doc["receivedBytes"] | 0;
      if (received > currentFile.acked) {
        currentFile.acked = received;
        retryCount = 0;
        lastTxAt = millis();
      }
      if (currentFile.acked >= currentFile.size) {
        if (!currentFile.completeSent) {
          currentFile.completeSent = true;
          transferActive = false;
          sendCompleteRequest();
        }
      } else {
        pump();
      }
      break;
    }

    case gyeol::COMPLETE_RES: {
      JsonDocument doc;
      if (deserializeJson(doc, frame.payload.data(), frame.payload.size()) != DeserializationError::Ok) {
        return;
      }
      const char *status = doc["status"] | "?";
      transferActive = false;
      Serial.printf("[ble] complete_res status=%s\n", status);
      break;
    }

    case gyeol::ERROR: {
      String detail;
      for (uint8_t byte : frame.payload) detail += static_cast<char>(byte);
      Serial.printf("[ble] error %s\n", detail.c_str());
      break;
    }

    default:
      break;
  }
}

// ------------------------------------------------------------------ BLE callbacks

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    connected = true;
    helloPending = true;
    transferActive = false;
    currentFile.acked = 0;
    currentFile.nextOffset = 0;
    currentFile.completeSent = false;
    lastTxAt = 0;
    retryCount = 0;
    Serial.println("[ble] connected");
  }

  void onDisconnect(BLEServer *server) override {
    connected = false;
    transferActive = false;
    helloPending = false;
    Serial.println("[ble] disconnected");
    BLEDevice::startAdvertising();
  }
};

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    const std::string value = characteristic->getValue();
    if (value.empty() || rxQueue == nullptr) return;
    auto *item = new std::vector<uint8_t>(value.begin(), value.end());
    if (xQueueSend(rxQueue, &item, 0) != pdTRUE) {
      Serial.println("[ble] rx queue full");
      delete item;
    }
  }
};

void startBle() {
  const String name = "GYEOL-" + String(static_cast<uint32_t>(ESP.getEfuseMac()), HEX);
  BLEDevice::init(name.c_str());
  BLEDevice::setMTU(247);

  rxQueue = xQueueCreate(8, sizeof(std::vector<uint8_t> *));
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService *service = server->createService(gyeol::SERVICE_UUID);
  txCharacteristic = service->createCharacteristic(gyeol::TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  txCharacteristic->addDescriptor(new BLE2902());
  rxCharacteristic = service->createCharacteristic(
      gyeol::RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rxCharacteristic->setCallbacks(new RxCallbacks());
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(gyeol::SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("[ble] advertising as %s\n", name.c_str());
}




size_t storageFreeBytes() {
  if (storage == nullptr) return 0;
  if (storage == &LittleFS) {
    const size_t total = LittleFS.totalBytes();
    const size_t used = LittleFS.usedBytes();
    return total > used ? total - used : 0;
  }
  if (storage == &SD) return SD.cardSize();
  return 0;
}

void clearRecordings() {
  if (storage == nullptr) return;
  if (storage == &LittleFS) {
    Serial.println("[storage] LittleFS format");
    LittleFS.end();
    LittleFS.format();
    LittleFS.begin(true);
    storage = &LittleFS;
  } else {
    File dir = storage->open("/recordings");
    if (dir) {
      File entry = dir.openNextFile();
      while (entry) {
        String path = entry.name();
        if (!entry.isDirectory()) {
          entry.close();
          storage->remove(path.startsWith("/") ? path : String("/recordings/") + path);
        } else {
          entry.close();
        }
        entry = dir.openNextFile();
      }
      dir.close();
    }
  }
  storage->mkdir("/recordings");
  currentFile.valid = false;
  Serial.printf("[storage] cleared, free=%u bytes\n", static_cast<unsigned>(storageFreeBytes()));
}

void hardwareCheck() {
  const char *kind = storage == &SD ? "SD" : storage == &LittleFS ? "LittleFS" : "none";
  Serial.printf("[hw] storage=%s free=%u bytes\n", kind, static_cast<unsigned>(storageFreeBytes()));
  if (storage == &SD) {
    Serial.printf("[hw] card=%llu MB\n", SD.cardSize() / (1024ULL * 1024ULL));
  }
  if (!initPdm()) {
    Serial.println("[hw] PDM init failed");
    return;
  }
  uint8_t buffer[640];
  size_t got = 0;
  double sum = 0;
  double peak = 0;
  int frames = 0;
  const uint32_t started = millis();
  while (millis() - started < 2000) {
    if (i2s_read(I2S_NUM_0, buffer, sizeof(buffer), &got, pdMS_TO_TICKS(200)) != ESP_OK) break;
    if (got == 0) continue;
    const FrameStats stats = frameStats(buffer, got);
    sum += stats.rms;
    if (stats.peak > peak) peak = stats.peak;
    frames += 1;
  }
  stopPdm();
  Serial.printf("[hw] PDM frames=%d meanRms=%.0f peak=%.0f\n", frames,
                frames > 0 ? sum / frames : 0, peak);
}


bool recordFixed(const String &path, int seconds) {
  if (!initPdm()) return false;
  if (storageFreeBytes() < 700000) {
    Serial.println("[fixed] 저장 공간 부족");
    stopPdm();
    return false;
  }
  File file = storage->open(path, FILE_WRITE);
  if (!file) {
    stopPdm();
    return false;
  }
  writeWavHeader(file, 0);
  uint8_t buffer[512];
  size_t got = 0;
  size_t written = 0;
  const uint32_t started = millis();
  while (millis() - started < static_cast<uint32_t>(seconds) * 1000) {
    if (i2s_read(I2S_NUM_0, buffer, sizeof(buffer), &got, pdMS_TO_TICKS(500)) != ESP_OK) break;
    if (got == 0) continue;
    file.write(buffer, got);
    written += got;
  }
  stopPdm();
  if (written == 0) {
    file.close();
    storage->remove(path);
    return false;
  }
  writeWavHeader(file, written);
  file.close();
  Serial.printf("[fixed] recorded %u bytes\n", static_cast<unsigned>(written));
  return true;
}

void recordNow() {
  if (storage == nullptr) return;
  const String path = "/recordings/rec_" + String(static_cast<uint32_t>(millis())) + ".wav";
  bool ok = recordVadClip(path, 20);
  if (!ok) {
    writeTestWav(path);
    ok = true;
  }
  if (!ok) return;
  const String id =
      "GYL-ESP32S3-" + String(static_cast<uint32_t>(ESP.getEfuseMac()), HEX) + ":" + String(millis());
  writeSidecar(path, ".id", id);
  writeSidecar(path, ".sha256", sha256File(path));
  selectCurrentFile(path);
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println(String("\n[gyeol] boot ") + FIRMWARE_VERSION);

  if (!initStorage()) {
    Serial.println("[gyeol] 저장소가 없어 BLE 만 동작합니다.");
  } else {
    String path = firstRecording();
    if (path.isEmpty()) {
      recordNow();
    } else {
      selectCurrentFile(path);
    }
  }

  startBle();
}

void loop() {
  if (Serial.available()) {
    const int command = Serial.read();
    if (command == 'r' && !connected) {
      Serial.println("[vad] manual record requested");
      recordNow();
    } else if (command == 'h') {
      hardwareCheck();
    } else if (command == 'c' && !connected) {
      clearRecordings();
    } else if (command == 'f' && !connected) {
      Serial.println("[fixed] manual fixed record requested");
      const String path = "/recordings/fixed_" + String(static_cast<uint32_t>(millis())) + ".wav";
      if (recordFixed(path, 5)) {
        const String id = "GYL-ESP32S3-" + String(static_cast<uint32_t>(ESP.getEfuseMac()), HEX) +
                          ":fixed:" + String(millis());
        writeSidecar(path, ".id", id);
        writeSidecar(path, ".sha256", sha256File(path));
        selectCurrentFile(path);
      }
    }
  }

  if (rxQueue != nullptr) {
    std::vector<uint8_t> *item = nullptr;
    while (xQueueReceive(rxQueue, &item, 0) == pdTRUE) {
      if (item != nullptr) {
        gyeol::Frame frame;
        if (gyeol::decodeFrame(item->data(), item->size(), frame)) {
          handleFrame(frame);
        } else {
          Serial.println("[ble] bad frame");
        }
        delete item;
      }
    }
  }

  if (connected && helloPending && txCharacteristic != nullptr) {
    // CCCD 구독 전에 보낸 HELLO 는 유실될 수 있다. ACK 받을 때까지 재전송한다.
    static uint32_t helloAt = 0;
    if (helloAt == 0 || millis() - helloAt > 1000) {
      sendFrame(gyeol::HELLO, gyeol::jsonEncode(helloJson().c_str()));
      helloAt = millis();
    }
  }
  if (connected && transferActive && currentFile.valid && currentFile.acked < currentFile.size &&
      lastTxAt != 0 && millis() - lastTxAt > 1200) {
    if (retryCount >= 6) {
      Serial.println("[ble] retry limit reached");
      retryCount = 0;
    } else {
      retryCount += 1;
      Serial.printf("[ble] ack timeout, retry %d from %u\n", retryCount,
                    static_cast<unsigned>(currentFile.acked));
      currentFile.nextOffset = currentFile.acked;
      pump();
    }
  }

  static uint32_t lastLog = 0;
  if (millis() - lastLog > 3000) {
    Serial.printf("[status] connected=%d file=%s size=%u acked=%u\n", connected ? 1 : 0,
                  currentFile.valid ? currentFile.id.c_str() : "-",
                  static_cast<unsigned>(currentFile.size),
                  static_cast<unsigned>(currentFile.acked));
    lastLog = millis();
  }
  delay(50);
}
