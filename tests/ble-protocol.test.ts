import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FLAG_LAST,
  FrameError,
  FrameType,
  MAX_PAYLOAD_BYTES,
  MemoryTransferStore,
  TransferReceiver,
  TransferSender,
  decodeFrame,
  encodeFrame,
  jsonPayload,
  parseJsonPayload,
  runTransfer,
} from "../packages/ble-protocol/index.ts";
import type { Frame } from "../packages/ble-protocol/index.ts";

const DATA_1000 = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));

function file(id = "rec:1", data = DATA_1000) {
  return {
    clientRecordingId: id,
    data,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function session(options: { chunkSizeBytes?: number; windowFrames?: number } = {}) {
  const store = new MemoryTransferStore();
  const sender = new TransferSender(file(), {
    chunkSizeBytes: options.chunkSizeBytes ?? 100,
    windowFrames: options.windowFrames ?? 4,
  });
  const receiver = new TransferReceiver(store, {
    chunkSizeBytes: options.chunkSizeBytes ?? 100,
  });
  return { store, sender, receiver };
}

test("프레임 인코딩·디코딩 왕복과 CRC/길이/버전 검증", () => {
  const frame: Frame = {
    type: FrameType.HELLO,
    seq: 7,
    flags: FLAG_LAST,
    payload: jsonPayload({ serialNo: "GYL-1", protocolVersion: 1 }),
  };
  const encoded = encodeFrame(frame);
  const decoded = decodeFrame(encoded);
  assert.equal(decoded.type, FrameType.HELLO);
  assert.equal(decoded.seq, 7);
  assert.equal(decoded.flags, FLAG_LAST);
  assert.deepEqual(parseJsonPayload(decoded), { serialNo: "GYL-1", protocolVersion: 1 });

  const badCrc = Buffer.from(encoded);
  badCrc[badCrc.length - 1] ^= 0xff;
  assert.throws(() => decodeFrame(badCrc), (err: any) => err instanceof FrameError && err.code === "BAD_CRC");

  const badMagic = Buffer.from(encoded);
  badMagic[0] = 0x00;
  assert.throws(() => decodeFrame(badMagic), (err: any) => err.code === "BAD_MAGIC");

  const badVersion = Buffer.from(encoded);
  badVersion[2] = 9;
  // CRC 는 헤더를 포함하므로 버전을 바꾸면 CRC 검사 전에 버전에서 실패한다.
  assert.throws(() => decodeFrame(badVersion), (err: any) => err.code === "UNSUPPORTED_VERSION");

  const badLength = Buffer.from(encoded);
  badLength.writeUInt16BE(badLength.readUInt16BE(10) + 1, 10);
  assert.throws(() => decodeFrame(badLength), (err: any) => err.code === "LENGTH_MISMATCH");

  assert.throws(
    () => encodeFrame({ ...frame, payload: Buffer.alloc(MAX_PAYLOAD_BYTES + 1) }),
    (err: any) => err.code === "PAYLOAD_TOO_LARGE",
  );
});

test("정상 전송: 오프셋·SHA-256 이 일치하고 완료된다", () => {
  const { store, sender, receiver } = session();
  const result = runTransfer(sender, receiver);

  assert.equal(sender.done, true, sender.error ?? "");
  assert.equal(sender.failed, false);
  assert.equal(result.interrupted, false);
  assert.equal(result.timeouts, 0);

  const saved = store.get(sender.file.clientRecordingId);
  assert.ok(saved);
  assert.deepEqual(saved?.data, DATA_1000);
  assert.equal(saved?.sha256, sender.file.sha256);
});

test("DATA 프레임 하나가 유실되어도 ACK 갭으로 재전송되어 완료된다", () => {
  const { store, sender, receiver } = session();
  let dropped = false;
  const result = runTransfer(sender, receiver, {
    dropFrame: (frame) => {
      if (!dropped && frame.type === FrameType.DATA) {
        dropped = true;
        return true;
      }
      return false;
    },
  });

  assert.equal(dropped, true);
  assert.equal(sender.done, true, sender.error ?? "");
  assert.equal(result.dropped, 1);
  assert.deepEqual(store.get(sender.file.clientRecordingId)?.data, DATA_1000);
});

test("ACK 이 유실되면 타임아웃 후 다시 보낸다", () => {
  const { store, sender, receiver } = session();
  let droppedAck = false;
  const result = runTransfer(sender, receiver, {
    dropFrame: (frame) => {
      if (!droppedAck && frame.type === FrameType.HELLO_ACK) {
        droppedAck = true;
        return true;
      }
      return false;
    },
  });

  assert.equal(droppedAck, true);
  assert.ok(result.timeouts >= 1, "타임아웃 재전송이 발생해야 한다");
  assert.equal(sender.done, true, sender.error ?? "");
  assert.deepEqual(store.get(sender.file.clientRecordingId)?.data, DATA_1000);
});

test("중간에 끊겨도 수신한 오프셋부터 재개한다", () => {
  const { store, sender, receiver } = session({ chunkSizeBytes: 64, windowFrames: 2 });
  const interrupted = runTransfer(sender, receiver, { maxFrames: 10 });
  assert.equal(interrupted.interrupted, true);

  const partial = store.get(sender.file.clientRecordingId)?.data.length ?? 0;
  assert.ok(partial > 0, "일부 바이트는 도착해야 한다");
  assert.ok(partial < DATA_1000.length, "전부 도착하면 재개 시나리오가 아니다");

  // 폰 앱 재시작: 같은 store(부분 파일)를 새 receiver 가 사용한다.
  const resumedSender = new TransferSender(file(), { chunkSizeBytes: 64, windowFrames: 2 });
  const resumedReceiver = new TransferReceiver(store, { chunkSizeBytes: 64 });
  const result = runTransfer(resumedSender, resumedReceiver);

  assert.equal(result.interrupted, false);
  assert.equal(resumedSender.done, true, resumedSender.error ?? "");
  assert.deepEqual(store.get(resumedSender.file.clientRecordingId)?.data, DATA_1000);
  assert.equal(store.get(resumedSender.file.clientRecordingId)?.sha256, resumedSender.file.sha256);
});

test("중복 DATA 는 저장하지 않고 현재 오프셋만 다시 알린다", () => {
  const store = new MemoryTransferStore();
  const receiver = new TransferReceiver(store, { chunkSizeBytes: 8 });
  receiver.handle({ type: FrameType.HELLO, seq: 1, flags: 0, payload: Buffer.alloc(0) });
  receiver.handle({
    type: FrameType.OPEN_REQ,
    seq: 2,
    flags: 0,
    payload: jsonPayload({ clientRecordingId: "rec:dup" }),
  });

  const dataFrame: Frame = {
    type: FrameType.DATA,
    seq: 3,
    flags: 0,
    payload: (() => {
      const header = Buffer.alloc(8);
      header.writeBigUInt64BE(0n);
      return Buffer.concat([header, Buffer.from("abcdefgh")]);
    })(),
  };
  const first = receiver.handle(dataFrame);
  const second = receiver.handle({ ...dataFrame, seq: 4 });
  assert.equal(JSON.parse(first[0].payload.toString()).receivedBytes, 8);
  assert.equal(JSON.parse(second[0].payload.toString()).receivedBytes, 8);
  assert.equal(store.get("rec:dup")?.data.length, 8);
});

test("갭(DATA 순서 건너뜀)은 저장하지 않고 재전송을 유도한다", () => {
  const store = new MemoryTransferStore();
  const receiver = new TransferReceiver(store);
  receiver.handle({
    type: FrameType.OPEN_REQ,
    seq: 1,
    flags: 0,
    payload: jsonPayload({ clientRecordingId: "rec:gap" }),
  });

  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(8n);
  const response = receiver.handle({
    type: FrameType.DATA,
    seq: 2,
    flags: 0,
    payload: Buffer.concat([header, Buffer.from("ijklmnop")]),
  });

  assert.equal(JSON.parse(response[0].payload.toString()).receivedBytes, 0);
  assert.equal(store.get("rec:gap")?.data.length ?? 0, 0);
});

test("완료 시 SHA-256 이 다르면 mismatch 로 거부한다", () => {
  const bad = file();
  const sender = new TransferSender({ ...bad, sha256: "0".repeat(64) }, { chunkSizeBytes: 100 });
  const receiver = new TransferReceiver(new MemoryTransferStore());
  runTransfer(sender, receiver);

  assert.equal(sender.done, false);
  assert.equal(sender.failed, true);
  assert.match(sender.error ?? "", /mismatch/);
});

test("완료된 파일은 LIST_RES 에 메타데이터로 나온다", () => {
  const { store, sender, receiver } = session();
  runTransfer(sender, receiver);

  const [response] = receiver.handle({
    type: FrameType.LIST_REQ,
    seq: 1,
    flags: 0,
    payload: Buffer.alloc(0),
  });
  const body = JSON.parse(response.payload.toString()) as {
    files: Array<{ clientRecordingId: string; byteSize: number; sha256: string }>;
  };
  assert.equal(body.files.length, 1);
  assert.equal(body.files[0].clientRecordingId, sender.file.clientRecordingId);
  assert.equal(body.files[0].byteSize, DATA_1000.length);
  assert.equal(body.files[0].sha256, sender.file.sha256);
  assert.ok(store.get(sender.file.clientRecordingId)?.sha256);
});
