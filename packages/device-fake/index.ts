import { createHash } from "node:crypto";
import { uuidv7 } from "../../apps/api/src/domain/ids.ts";
import type {
  CapturedRecording,
  HardwareAdapter,
  WearableStatus,
} from "../hardware-adapter/port.ts";

/**
 * Fake 웨어러블. 실물 XIAO nRF52840 대신 WAV PCM16 을 생성해 microSD 를 흉내낸다.
 *
 * - 폰이 없으면 capture() 로 로컬에 계속 쌓인다(오프라인 동작 검증).
 * - 전송 ACK 전까지 파일을 보관한다.
 */
export class FakeWearable implements HardwareAdapter {
  readonly serialNo: string;
  readonly model = "xiao-nrf52840-sense";
  readonly firmwareVersion = "fake-0.1.0";

  private files = new Map<string, CapturedRecording>();
  private bootId = uuidv7().slice(0, 8);
  private seq = 0;
  private batteryPct = 92;

  constructor(serialNo = "GYL-FAKE-0001") {
    this.serialNo = serialNo;
  }

  async capture(options: { durationMs: number; toneHz?: number }): Promise<CapturedRecording> {
    const startedAt = new Date();
    const bytes = buildWavPcm16Mono(16_000, options.durationMs, options.toneHz ?? 440);
    const recording: CapturedRecording = {
      clientRecordingId: `${this.serialNo}:${this.bootId}:${String(this.seq).padStart(5, "0")}`,
      startedAt,
      endedAt: new Date(startedAt.getTime() + options.durationMs),
      durationMs: options.durationMs,
      codec: "wav_pcm_s16le",
      sampleRateHz: 16_000,
      channels: 1,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    this.seq += 1;
    this.batteryPct = Math.max(1, this.batteryPct - 1);
    this.files.set(recording.clientRecordingId, recording);
    return recording;
  }

  async list(): Promise<CapturedRecording[]> {
    return [...this.files.values()].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }

  async readFile(clientRecordingId: string): Promise<Buffer> {
    const file = this.files.get(clientRecordingId);
    if (!file) throw new Error(`기기에 파일이 없습니다: ${clientRecordingId}`);
    return file.bytes;
  }

  async acknowledgeTransfer(clientRecordingId: string): Promise<void> {
    this.files.delete(clientRecordingId);
  }

  async status(): Promise<WearableStatus> {
    const used = [...this.files.values()].reduce((sum, f) => sum + f.bytes.length, 0);
    return {
      serialNo: this.serialNo,
      model: this.model,
      firmwareVersion: this.firmwareVersion,
      batteryPct: this.batteryPct,
      storageFreeBytes: 8 * 1024 ** 3 - used,
      pendingFiles: this.files.size,
    };
  }
}

/** 16kHz mono 16bit PCM WAV. 테스트 기준 포맷(D-04 미확정). */
export function buildWavPcm16Mono(sampleRate: number, durationMs: number, toneHz: number): Buffer {
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * toneHz * i) / sampleRate) * 8000);
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  return buffer;
}
