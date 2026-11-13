/**
 * 웨어러블 하드웨어 포트.
 *
 * 펌웨어(실물)와 Fake Adapter 가 같은 계약을 구현한다.
 * 서버 코드는 이 인터페이스만 알며, 프로토콜/드라이버 세부는 어댑터 내부에 격리한다.
 */
export interface CapturedRecording {
  /** 기기 생성 멱등 키. 예: `<serial>:<bootId>:<seq>` */
  clientRecordingId: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  /**
   * D-04 제안: 기기 저장·전송은 `wav_ima_adpcm` (ADR-0006, 승인 대기).
   * Phase 1 테스트 기준은 계속 `wav_pcm_s16le` 이다.
   */
  codec: string;
  sampleRateHz: number;
  channels: number;
  bytes: Buffer;
  sha256: string;
}

export interface WearableStatus {
  serialNo: string;
  model: string;
  firmwareVersion: string;
  batteryPct: number;
  storageFreeBytes: number;
  pendingFiles: number;
}

export interface HardwareAdapter {
  readonly serialNo: string;
  readonly model: string;

  /** VAD 구간(+전후 버퍼) 녹음. 폰이 없어도 로컬에 저장된다. */
  capture(options: { durationMs: number; toneHz?: number }): Promise<CapturedRecording>;

  /** 아직 전송 완료(ACK)되지 않은 로컬 파일 목록. */
  list(): Promise<CapturedRecording[]>;

  readFile(clientRecordingId: string): Promise<Buffer>;

  /** 폰이 수신을 확인한 파일만 기기에서 삭제한다. */
  acknowledgeTransfer(clientRecordingId: string): Promise<void>;

  status(): Promise<WearableStatus>;
}
