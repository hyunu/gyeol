import type { CapturedRecording, HardwareAdapter } from "../hardware-adapter/port.ts";

export type PhoneFileState = "transferring" | "received" | "uploading" | "uploaded" | "server_acked";

export interface PhoneFile {
  file: CapturedRecording;
  /** BLE 로 받은 바이트 수 */
  receivedBytes: number;
  /** 서버에 보낸 바이트 수 */
  uploadedBytes: number;
  state: PhoneFileState;
  recordingId?: string;
  sessionId?: string;
  serverStatus?: string;
  deletable?: boolean;
  deletedLocally?: boolean;
}

interface ServerProblem {
  code?: string;
  detail?: string;
}

class Client {
  private readonly baseUrl: string;
  private readonly userId: string;

  constructor(baseUrl: string, userId: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.userId = userId;
  }

  async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "x-user-id": this.userId,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  async putChunk(path: string, chunk: Buffer): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { "x-user-id": this.userId, "content-type": "application/octet-stream" },
      body: chunk,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }
}

/**
 * Fake iPhone.
 *
 * - BLE 수신(중단/재개)과 HTTP 업로드(중단/재개)를 실제와 같은 순서로 수행한다.
 * - 원본 삭제는 서버가 `deletable` 을 true 로 돌려준 뒤에만 가능하다(M-04).
 */
export class FakePhone {
  private readonly files = new Map<string, PhoneFile>();
  private readonly bleChunkBytes: number;
  private readonly httpChunkBytes: number;

  constructor(options: { bleChunkBytes?: number; httpChunkBytes?: number } = {}) {
    this.bleChunkBytes = options.bleChunkBytes ?? 4096;
    this.httpChunkBytes = options.httpChunkBytes ?? 64 * 1024;
  }

  list(): PhoneFile[] {
    return [...this.files.values()];
  }

  get(clientRecordingId: string): PhoneFile {
    const item = this.files.get(clientRecordingId);
    if (!item) throw new Error(`폰에 파일이 없습니다: ${clientRecordingId}`);
    return item;
  }

  /** BLE 전송. `interruptAtBytes` 로 중단을 흉내내고, 다시 호출하면 이어받는다. */
  async pull(
    wearable: HardwareAdapter,
    options: { interruptAtBytes?: number } = {},
  ): Promise<{ transferredBytes: number; interrupted: boolean }> {
    let transferred = 0;
    const pending = await wearable.list();

    for (const file of pending) {
      let item = this.files.get(file.clientRecordingId);
      if (!item) {
        item = { file, receivedBytes: 0, uploadedBytes: 0, state: "transferring" };
        this.files.set(file.clientRecordingId, item);
      }
      const bytes = await wearable.readFile(file.clientRecordingId);
      item.file = { ...file, bytes };

      while (item.receivedBytes < bytes.length) {
        const length = Math.min(this.bleChunkBytes, bytes.length - item.receivedBytes);
        item.receivedBytes += length;
        transferred += length;
        if (options.interruptAtBytes !== undefined && transferred >= options.interruptAtBytes) {
          return { transferredBytes: transferred, interrupted: true };
        }
      }
      item.state = "received";
      // 폰이 수신을 확인한 파일만 기기에서 지운다.
      await wearable.acknowledgeTransfer(file.clientRecordingId);
    }
    return { transferredBytes: transferred, interrupted: false };
  }

  /** 서버 업로드. 중단 후 다시 호출하면 오프셋부터 이어 보낸다. */
  async upload(
    baseUrl: string,
    userId: string,
    deviceId: string,
    clientRecordingId: string,
    options: { interruptAtBytes?: number } = {},
  ): Promise<{ interrupted: boolean; uploadedBytes: number }> {
    const item = this.get(clientRecordingId);
    const client = new Client(baseUrl, userId);
    const bytes = item.file.bytes;

    if (!item.recordingId) {
      const created = await client.json<{
        recording: { id: string; status: string };
        uploadSession: { id: string; receivedBytes: number; chunkSizeBytes: number };
      }>("POST", "/api/v1/recordings", {
        deviceId,
        clientRecordingId: item.file.clientRecordingId,
        startedAt: item.file.startedAt.toISOString(),
        endedAt: item.file.endedAt.toISOString(),
        durationMs: item.file.durationMs,
        codec: item.file.codec,
        sampleRateHz: item.file.sampleRateHz,
        channels: item.file.channels,
        byteSize: bytes.length,
        sha256: item.file.sha256,
      });
      if (created.status >= 400) {
        throw new Error(`녹음 등록 실패: ${created.status} ${JSON.stringify(created.body)}`);
      }
      item.recordingId = created.body.recording.id;
      item.sessionId = created.body.uploadSession.id;
      item.serverStatus = created.body.recording.status;
      item.uploadedBytes = created.body.uploadSession.receivedBytes;
    }

    let sentThisRun = 0;
    while (item.uploadedBytes < bytes.length) {
      const length = Math.min(this.httpChunkBytes, bytes.length - item.uploadedBytes);
      if (options.interruptAtBytes !== undefined && sentThisRun + length > options.interruptAtBytes) {
        return { interrupted: true, uploadedBytes: item.uploadedBytes };
      }
      const chunk = bytes.subarray(item.uploadedBytes, item.uploadedBytes + length);
      const res = await client.putChunk(
        `/api/v1/recordings/${item.recordingId}/upload-sessions/${item.sessionId}/chunks?offset=${item.uploadedBytes}`,
        chunk,
      );

      if (res.status === 409 && (res.body as ServerProblem).code === "OFFSET_MISMATCH") {
        // 서버가 이미 받은 지점으로 되돌린다(재시작·재연결 대비).
        const detail = (res.body as ServerProblem).detail ?? "";
        const received = Number(/received=(\d+)/.exec(detail)?.[1] ?? NaN);
        if (!Number.isFinite(received)) throw new Error(`오프셋 복구 실패: ${detail}`);
        item.uploadedBytes = received;
        continue;
      }
      if (res.status >= 400) {
        throw new Error(`청크 업로드 실패: ${res.status} ${JSON.stringify(res.body)}`);
      }

      const body = res.body as {
        recording: { status: string; deletable: boolean };
        uploadSession: { receivedBytes: number; status: string };
      };
      item.uploadedBytes = body.uploadSession.receivedBytes;
      item.serverStatus = body.recording.status;
      item.deletable = body.recording.deletable;
      item.state = body.uploadSession.status === "completed" ? "uploaded" : "uploading";
      sentThisRun += length;
    }

    return { interrupted: false, uploadedBytes: item.uploadedBytes };
  }

  /** 서버 검증 결과에 대한 최종 ACK (M-04 조건 5). */
  async acknowledge(baseUrl: string, userId: string, clientRecordingId: string): Promise<PhoneFile> {
    const item = this.get(clientRecordingId);
    if (!item.recordingId) throw new Error("업로드되지 않은 파일은 ACK 할 수 없습니다.");
    if (item.state !== "uploaded") throw new Error(`업로드 완료 상태가 아닙니다: ${item.state}`);

    const client = new Client(baseUrl, userId);
    const res = await client.json<{ recording: { status: string; deletable: boolean } }>(
      "POST",
      `/api/v1/recordings/${item.recordingId}/ack`,
    );
    if (res.status >= 400) throw new Error(`ACK 실패: ${res.status} ${JSON.stringify(res.body)}`);
    item.serverStatus = res.body.recording.status;
    item.deletable = res.body.recording.deletable;
    item.state = "server_acked";
    return item;
  }

  /** 서버 ACK + deletable 확인 후에만 로컬 원본을 삭제한다. */
  deleteLocalAfterAck(clientRecordingId: string): void {
    const item = this.get(clientRecordingId);
    if (item.state !== "server_acked" || !item.deletable) {
      throw new Error("서버 ACK 전에는 로컬 원본을 삭제할 수 없습니다(M-04).");
    }
    item.deletedLocally = true;
    this.files.delete(clientRecordingId);
  }
}
