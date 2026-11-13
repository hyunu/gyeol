import { createHash } from "node:crypto";
import {
  FLAG_LAST,
  FrameType,
  RECOMMENDED_CHUNK_BYTES,
  dataPayload,
  encodeFrame,
  jsonPayload,
  parseDataPayload,
  parseJsonPayload,
  type Frame,
} from "./frame.ts";

/**
 * 기기→폰 파일 전송 상태 기계 (W-20).
 *
 * 결정적 시뮬레이션을 위해 타이머를 직접 쓰지 않는다. 전송 루프가 큐가 비면
 * `onTimeout()` 을 호출해 재전송을 유도한다. 실제 BLE 에서는 같은 함수를
 * ACK 타임아웃에 연결한다.
 */

export interface FileMeta {
  clientRecordingId: string;
  byteSize: number;
  sha256: string;
}

export interface TransferStore {
  get(clientRecordingId: string): { data: Buffer; sha256: string | null } | undefined;
  put(clientRecordingId: string, data: Buffer, sha256: string | null): void;
  delete(clientRecordingId: string): void;
  list(): FileMeta[];
}

export class MemoryTransferStore implements TransferStore {
  private readonly files = new Map<string, { data: Buffer; sha256: string | null }>();

  get(clientRecordingId: string) {
    return this.files.get(clientRecordingId);
  }

  put(clientRecordingId: string, data: Buffer, sha256: string | null): void {
    this.files.set(clientRecordingId, { data, sha256 });
  }

  delete(clientRecordingId: string): void {
    this.files.delete(clientRecordingId);
  }

  list(): FileMeta[] {
    return [...this.files.entries()]
      .filter(([, value]) => value.sha256 !== null)
      .map(([clientRecordingId, value]) => ({
        clientRecordingId,
        byteSize: value.data.length,
        sha256: value.sha256 as string,
      }));
  }
}

export interface SenderOptions {
  chunkSizeBytes?: number;
  windowFrames?: number;
  maxRetries?: number;
  hello?: Record<string, unknown>;
}

type SenderState = "idle" | "hello" | "open" | "data" | "complete" | "done" | "failed";

interface InFlight {
  offset: number;
  bytes: number;
  frame: Frame;
}

export class TransferSender {
  readonly file: { clientRecordingId: string; data: Buffer; sha256: string };
  private readonly chunkSizeBytes: number;
  private readonly windowFrames: number;
  private readonly maxRetries: number;
  private readonly hello: Record<string, unknown>;
  private readonly sha256: string;

  private state: SenderState = "idle";
  private seq = 0;
  private acked = 0;
  private nextOffset = 0;
  private inFlight: InFlight[] = [];
  private retries = 0;
  private completeFrame: Frame | null = null;
  private lastControlFrame: Frame | null = null;
  private failure: string | null = null;

  constructor(
    file: { clientRecordingId: string; data: Buffer; sha256?: string },
    options: SenderOptions = {},
  ) {
    this.file = {
      clientRecordingId: file.clientRecordingId,
      data: file.data,
      sha256: file.sha256 ?? createHash("sha256").update(file.data).digest("hex"),
    };
    this.sha256 = this.file.sha256;
    this.chunkSizeBytes = options.chunkSizeBytes ?? RECOMMENDED_CHUNK_BYTES;
    this.windowFrames = options.windowFrames ?? 4;
    this.maxRetries = options.maxRetries ?? 5;
    this.hello = options.hello ?? { serialNo: "simulated", protocolVersion: 1 };
  }

  get done(): boolean {
    return this.state === "done";
  }

  get failed(): boolean {
    return this.state === "failed";
  }

  get error(): string | null {
    return this.failure;
  }

  start(): Frame[] {
    if (this.state !== "idle") return [];
    this.state = "hello";
    const frame = this.frame(FrameType.HELLO, jsonPayload(this.hello));
    this.lastControlFrame = frame;
    return [frame];
  }

  handle(frame: Frame): Frame[] {
    if (this.state === "done" || this.state === "failed") return [];

    if (frame.type === FrameType.ERROR) {
      const error = parseJsonPayload<{ code?: string; detail?: string }>(frame);
      this.fail(`${error.code ?? "ERROR"}: ${error.detail ?? "상대방 오류"}`);
      return [];
    }

    switch (frame.type) {
      case FrameType.HELLO_ACK:
        if (this.state !== "hello") return [];
        this.state = "open";
        return [this.control(FrameType.OPEN_REQ, { clientRecordingId: this.file.clientRecordingId })];

      case FrameType.OPEN_RES: {
        if (this.state !== "open") return [];
        const response = parseJsonPayload<{ clientRecordingId: string; startOffset: number }>(frame);
        if (response.clientRecordingId !== this.file.clientRecordingId) {
          this.fail(`다른 파일의 OPEN_RES: ${response.clientRecordingId}`);
          return [];
        }
        const start = Number(response.startOffset ?? 0);
        if (!Number.isSafeInteger(start) || start < 0 || start > this.file.data.length) {
          this.fail(`잘못된 startOffset: ${response.startOffset}`);
          return [];
        }
        this.state = "data";
        this.acked = start;
        this.nextOffset = start;
        this.inFlight = [];
        return this.pump();
      }

      case FrameType.ACK: {
        if (this.state !== "data" && this.state !== "complete") return [];
        const ack = parseJsonPayload<{ receivedBytes: number; clientRecordingId?: string }>(frame);
        const received = Number(ack.receivedBytes);
        if (!Number.isSafeInteger(received) || received < 0 || received > this.file.data.length) {
          this.fail(`잘못된 ACK offset: ${ack.receivedBytes}`);
          return [];
        }
        if (received < this.acked) return [];
        this.acked = received;
        this.inFlight = [];
        this.nextOffset = received;
        this.retries = 0;

        const out = this.state === "data" ? this.pump() : [];
        if (this.acked >= this.file.data.length && !this.completeFrame) {
          this.state = "complete";
          this.completeFrame = this.frame(
            FrameType.COMPLETE_REQ,
            jsonPayload({
              clientRecordingId: this.file.clientRecordingId,
              byteSize: this.file.data.length,
              sha256: this.sha256,
            }),
          );
          out.push(this.completeFrame);
        }
        return out;
      }

      case FrameType.COMPLETE_RES: {
        if (this.state !== "complete") return [];
        const result = parseJsonPayload<{ status: string; receivedBytes?: number }>(frame);
        if (result.status === "ok" || result.status === "duplicate") {
          this.state = "done";
          return [];
        }
        this.fail(`전송 완료 거부: ${result.status} (received=${result.receivedBytes ?? "?"})`);
        return [];
      }

      default:
        return [];
    }
  }

  /** ACK 타임아웃. 마지막으로 확인된 오프셋부터 다시 보낸다. */
  onTimeout(): Frame[] {
    if (this.state === "done" || this.state === "failed") return [];
    this.retries += 1;
    if (this.retries > this.maxRetries) {
      this.fail(`재전송 한도(${this.maxRetries})를 초과했습니다.`);
      return [];
    }

    if (this.state === "data") {
      this.inFlight = [];
      this.nextOffset = this.acked;
      return this.pump();
    }
    if (this.state === "complete" && this.completeFrame) {
      return [this.completeFrame];
    }
    if (this.state === "open" && this.lastControlFrame) {
      return [this.lastControlFrame];
    }
    if (this.state === "hello") {
      return [this.frame(FrameType.HELLO, jsonPayload(this.hello))];
    }
    return [];
  }

  private pump(): Frame[] {
    const frames: Frame[] = [];
    while (this.inFlight.length < this.windowFrames && this.nextOffset < this.file.data.length) {
      const end = Math.min(this.nextOffset + this.chunkSizeBytes, this.file.data.length);
      const data = this.file.data.subarray(this.nextOffset, end);
      const frame = this.frame(
        FrameType.DATA,
        dataPayload(this.nextOffset, data),
        end >= this.file.data.length ? FLAG_LAST : 0,
      );
      this.inFlight.push({ offset: this.nextOffset, bytes: data.length, frame });
      this.nextOffset = end;
      frames.push(frame);
    }
    return frames;
  }

  private control(type: Frame["type"], body: unknown): Frame {
    const frame = this.frame(type, jsonPayload(body));
    this.lastControlFrame = frame;
    return frame;
  }

  private frame(type: Frame["type"], payload: Buffer, flags = 0): Frame {
    this.seq += 1;
    return { type, seq: this.seq, flags, payload };
  }

  private fail(message: string): void {
    this.state = "failed";
    this.failure = message;
  }
}

export interface ReceiverOptions {
  chunkSizeBytes?: number;
}

export class TransferReceiver {
  private readonly store: TransferStore;
  private readonly chunkSizeBytes: number;
  private readonly completed = new Set<string>();
  private seq = 0;
  private currentId: string | null = null;

  constructor(store: TransferStore, options: ReceiverOptions = {}) {
    this.store = store;
    this.chunkSizeBytes = options.chunkSizeBytes ?? RECOMMENDED_CHUNK_BYTES;
  }

  handle(frame: Frame): Frame[] {
    switch (frame.type) {
      case FrameType.HELLO:
        return [
          this.reply(FrameType.HELLO_ACK, {
            protocolVersion: 1,
            chunkSizeBytes: this.chunkSizeBytes,
            maxFrameBytes: 528,
          }),
        ];

      case FrameType.LIST_REQ:
        return [this.reply(FrameType.LIST_RES, { files: this.store.list() })];

      case FrameType.OPEN_REQ: {
        const request = parseJsonPayload<{ clientRecordingId: string }>(frame);
        this.currentId = request.clientRecordingId;
        const existing = this.store.get(request.clientRecordingId);
        return [
          this.reply(FrameType.OPEN_RES, {
            clientRecordingId: request.clientRecordingId,
            startOffset: existing?.data.length ?? 0,
            chunkSizeBytes: this.chunkSizeBytes,
          }),
        ];
      }

      case FrameType.DATA:
        return this.onData(frame);

      case FrameType.COMPLETE_REQ:
        return this.onComplete(frame);

      default:
        return [
          this.reply(FrameType.ERROR, {
            code: "UNEXPECTED_TYPE",
            detail: `수신기가 처리하지 않는 타입: ${frame.type}`,
          }),
        ];
    }
  }

  private onData(frame: Frame): Frame[] {
    const { offset, data } = parseDataPayload(frame.payload);
    const id = this.currentId;
    if (!id) {
      return [this.reply(FrameType.ERROR, { code: "NO_OPEN_FILE", detail: "OPEN_REQ 없이 DATA" })];
    }

    const existing = this.store.get(id)?.data ?? Buffer.alloc(0);
    if (offset < existing.length) {
      // 중복 프레임: 이미 받은 바이트는 버리고 현재 오프셋을 다시 알린다.
      return [this.ack(id, existing.length)];
    }
    if (offset > existing.length) {
      // 갭: 받지 못한 구간을 다시 요청한다.
      return [this.ack(id, existing.length)];
    }

    const next = Buffer.concat([existing, data]);
    this.store.put(id, next, this.store.get(id)?.sha256 ?? null);
    return [this.ack(id, next.length)];
  }

  private onComplete(frame: Frame): Frame[] {
    const request = parseJsonPayload<{
      clientRecordingId: string;
      byteSize: number;
      sha256: string;
    }>(frame);
    const stored = this.store.get(request.clientRecordingId)?.data ?? Buffer.alloc(0);
    const receivedBytes = stored.length;

    if (this.completed.has(request.clientRecordingId)) {
      return [
        this.reply(FrameType.COMPLETE_RES, {
          clientRecordingId: request.clientRecordingId,
          status: "duplicate",
          receivedBytes,
        }),
      ];
    }

    if (receivedBytes !== request.byteSize) {
      return [
        this.reply(FrameType.COMPLETE_RES, {
          clientRecordingId: request.clientRecordingId,
          status: "mismatch",
          receivedBytes,
        }),
      ];
    }

    const digest = createHash("sha256").update(stored).digest("hex");
    if (digest !== request.sha256) {
      return [
        this.reply(FrameType.COMPLETE_RES, {
          clientRecordingId: request.clientRecordingId,
          status: "mismatch",
          receivedBytes,
        }),
      ];
    }

    this.store.put(request.clientRecordingId, stored, digest);
    this.completed.add(request.clientRecordingId);
    this.currentId = null;
    return [
      this.reply(FrameType.COMPLETE_RES, {
        clientRecordingId: request.clientRecordingId,
        status: "ok",
        receivedBytes,
      }),
    ];
  }

  private ack(clientRecordingId: string, receivedBytes: number): Frame {
    return this.reply(FrameType.ACK, { clientRecordingId, receivedBytes });
  }

  private reply(type: Frame["type"], body: unknown): Frame {
    this.seq += 1;
    return { type, seq: this.seq, flags: 0, payload: jsonPayload(body) };
  }

}

/**
 * 결정적 전송 시뮬레이터.
 *
 * `dropFrame` 으로 프레임을 잃어버리게 하고, 큐가 비면 onTimeout 으로 재전송한다.
 * `maxFrames` 로 중간에 끊어 재개(resume) 시나리오를 만들 수 있다.
 */
export interface SimulatorOptions {
  maxFrames?: number;
  dropFrame?: (frame: Frame, index: number) => boolean;
  maxSteps?: number;
}

export interface SimulatorResult {
  processed: number;
  interrupted: boolean;
  dropped: number;
  timeouts: number;
}

export function runTransfer(
  sender: TransferSender,
  receiver: TransferReceiver,
  options: SimulatorOptions = {},
): SimulatorResult {
  const maxSteps = options.maxSteps ?? 100_000;
  let queue = sender.start();
  let processed = 0;
  let dropped = 0;
  let timeouts = 0;

  while (!sender.done && !sender.failed) {
    if (options.maxFrames !== undefined && processed >= options.maxFrames) {
      return { processed, interrupted: true, dropped, timeouts };
    }
    if (queue.length === 0) {
      queue = sender.onTimeout();
      timeouts += 1;
      if (queue.length === 0) break;
    }

    const frame = queue.shift() as Frame;
    const index = processed;
    processed += 1;
    if (options.dropFrame?.(frame, index)) {
      dropped += 1;
      continue;
    }

    const responses = receiver.handle(frame);
    for (const response of responses) {
      if (options.dropFrame?.(response, processed)) {
        dropped += 1;
        continue;
      }
      queue.push(...sender.handle(response));
    }

    if (processed > maxSteps) throw new Error("전송 시뮬레이션이 너무 오래 걸립니다.");
  }

  return { processed, interrupted: false, dropped, timeouts };
}

export { encodeFrame, FLAG_LAST };
