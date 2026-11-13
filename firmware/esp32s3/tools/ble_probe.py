#!/usr/bin/env python3
"""GYEOL BLE 전송 프로브 (개발용).

기기(ESP32-S3 펌웨어)가 광고하는 GATT 서비스에 붙어 파일 하나를 받고
크기·SHA-256 을 검증한다. `docs/12-ble-protocol.md` 의 폰(수신) 역할을 한다.

준비:
    ~/.platformio/penv/bin/pip install bleak
실행:
    ~/.platformio/penv/bin/python firmware/esp32s3/tools/ble_probe.py \
        --output /tmp/gyeol-bledemo.wav
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import struct
import sys
import time
import zlib

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "8f2d0001-7b1e-4c3a-9f4d-5a6b7c8d9e01"
TX_UUID = "8f2d0002-7b1e-4c3a-9f4d-5a6b7c8d9e01"
RX_UUID = "8f2d0003-7b1e-4c3a-9f4d-5a6b7c8d9e01"

HELLO = 0x01
HELLO_ACK = 0x02
LIST_REQ = 0x03
LIST_RES = 0x04
OPEN_REQ = 0x05
OPEN_RES = 0x06
DATA = 0x07
ACK = 0x08
COMPLETE_REQ = 0x09
COMPLETE_RES = 0x0A
ERROR = 0x0B

MAGIC = b"GY"
VERSION = 1
HEADER = 16
CHUNK = 220


def encode(frame_type: int, seq: int, payload: bytes = b"", flags: int = 0) -> bytes:
    header = MAGIC + bytes([VERSION, frame_type, flags, 0]) + struct.pack(">IH", seq, len(payload))
    crc = zlib.crc32(header + payload) & 0xFFFFFFFF
    return header + struct.pack(">I", crc) + payload


def decode(data: bytes) -> tuple[int, int, int, bytes]:
    if len(data) < HEADER or data[:2] != MAGIC or data[2] != VERSION:
        raise ValueError("bad frame header")
    frame_type = data[3]
    seq = struct.unpack(">I", data[6:10])[0]
    length = struct.unpack(">H", data[10:12])[0]
    if len(data) != HEADER + length:
        raise ValueError("length mismatch")
    expected = zlib.crc32(data[:12] + data[HEADER:]) & 0xFFFFFFFF
    actual = struct.unpack(">I", data[12:16])[0]
    if expected != actual:
        raise ValueError("bad crc")
    return frame_type, seq, data[4], data[HEADER:]


class Probe:
    def __init__(self, client: BleakClient, output: str, partial_path: str, stop_after: int | None) -> None:
        self.client = client
        self.output = output
        self.partial_path = partial_path
        self.stop_after = stop_after
        self.seq = 0
        self.file_id: str | None = None
        self.data = bytearray()
        self.done = asyncio.Event()
        self.result: dict | None = None
        self.error: str | None = None
        self.buffer = bytearray()
        self.last_ack = 0
        self.stopped_early = False

    async def send(self, frame_type: int, body: dict | None = None, flags: int = 0) -> None:
        self.seq += 1
        payload = b"" if body is None else json.dumps(body).encode()
        await self.client.write_gatt_char(RX_UUID, encode(frame_type, self.seq, payload, flags), response=True)

    async def on_notify(self, _characteristic, data: bytearray) -> None:
        # BLE notification 은 MTU 단위로 쪼개진다. complete frame 만 꺼내 처리한다.
        self.buffer.extend(data)
        while True:
            if not self.buffer.startswith(MAGIC):
                index = self.buffer.find(MAGIC)
                if index < 0:
                    self.buffer.clear()
                    return
                del self.buffer[:index]
            if len(self.buffer) < HEADER:
                return
            length = struct.unpack(">H", self.buffer[10:12])[0]
            if len(self.buffer) < HEADER + length:
                break
            frame_bytes = bytes(self.buffer[: HEADER + length])
            del self.buffer[: HEADER + length]
            try:
                frame_type, _seq, flags, payload = decode(frame_bytes)
            except ValueError as exc:
                print(f"[probe] 프레임 오류: {exc} len={len(frame_bytes)} head={frame_bytes[:16].hex()}")
                print(f"[probe] expected={zlib.crc32(frame_bytes[:12]+frame_bytes[16:]) & 0xFFFFFFFF:08x} actual={struct.unpack('>I', frame_bytes[12:16])[0]:08x}")
                self.buffer.clear()
                return
            await self.handle_frame(frame_type, payload, flags)

    async def handle_frame(self, frame_type: int, payload: bytes, flags: int = 0) -> None:

        if frame_type == HELLO:
            body = json.loads(payload)
            print(f"[probe] hello {body.get('serialNo')} fw={body.get('firmwareVersion')}")
            await self.send(HELLO_ACK, {"protocolVersion": 1, "chunkSizeBytes": CHUNK, "maxFrameBytes": 528})

        elif frame_type == LIST_RES:
            print(f"[probe] files {json.loads(payload).get('files')}")

        elif frame_type == OPEN_REQ:
            body = json.loads(payload)
            self.file_id = body["clientRecordingId"]
            print(f"[probe] open {self.file_id}")
            await self.send(OPEN_RES, {
                "clientRecordingId": self.file_id,
                "startOffset": len(self.data),
                "chunkSizeBytes": CHUNK,
            })

        elif frame_type == DATA:
            offset = struct.unpack(">Q", payload[:8])[0]
            chunk = payload[8:]
            if offset == len(self.data):
                self.data.extend(chunk)
            # 매 프레임 ACK 하면 BLE 왕복이 병목이다. 4프레임마다 한 번만 보낸다.
            if flags & 0x01 or len(self.data) - self.last_ack >= 8 * CHUNK:
                self.last_ack = len(self.data)
                await self.send(ACK, {"clientRecordingId": self.file_id, "receivedBytes": len(self.data)})
            if self.stop_after is not None and len(self.data) >= self.stop_after:
                with open(self.partial_path, "wb") as handle:
                    handle.write(self.data)
                print(f"[probe] stopped early at {len(self.data)} bytes → {self.partial_path}")
                self.stopped_early = True
                self.result = {"size": len(self.data), "sha256": "", "status": "partial"}
                self.done.set()

        elif frame_type == COMPLETE_REQ:
            body = json.loads(payload)
            digest = hashlib.sha256(self.data).hexdigest()
            ok = len(self.data) == body["byteSize"] and digest == body["sha256"]
            status = "ok" if ok else "mismatch"
            print(f"[probe] complete size={len(self.data)}/{body['byteSize']} sha_match={digest == body['sha256']}")
            await self.send(COMPLETE_RES, {
                "clientRecordingId": body["clientRecordingId"],
                "status": status,
                "receivedBytes": len(self.data),
            })
            self.result = {"size": len(self.data), "sha256": digest, "status": status}
            self.done.set()

        elif frame_type == ERROR:
            self.error = payload.decode(errors="replace")
            print(f"[probe] device error: {self.error}")
            self.done.set()

    async def run(self) -> bool:
        await self.client.start_notify(TX_UUID, self.on_notify)
        try:
            await asyncio.wait_for(self.done.wait(), timeout=90)
        except asyncio.TimeoutError:
            print("[probe] 시간 초과")
            return False

        if self.stopped_early:
            return True
        if self.error or not self.result or self.result["status"] != "ok":
            return False

        with open(self.output, "wb") as handle:
            handle.write(self.data)
        try:
            import os
            os.remove(self.partial_path)
        except OSError:
            pass
        print(f"[probe] saved {self.output} ({len(self.data)} bytes)")
        print(f"[probe] sha256 {self.result['sha256']}")
        return True


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="/tmp/gyeol-ble.wav")
    parser.add_argument("--name", default="GYEOL")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--partial", default=None, help="이어받기용 부분 파일 경로")
    parser.add_argument("--stop-after", type=int, default=None, help="N바이트 후 중단(재개 테스트)")
    args = parser.parse_args()

    print("[probe] scanning…")
    device = await BleakScanner.find_device_by_filter(
        lambda d, ad: (ad.local_name or "").startswith(args.name),
        timeout=args.timeout,
    )
    if device is None:
        print("[probe] 기기를 찾지 못했습니다. 펌웨어가 광고 중인지 확인하세요.")
        return 1

    partial_path = args.partial or (args.output + ".part")
    initial = b""
    try:
        with open(partial_path, "rb") as handle:
            initial = handle.read()
        print(f"[probe] resuming from {len(initial)} bytes ({partial_path})")
    except OSError:
        pass

    print(f"[probe] connecting {device.name} ({device.address})")
    started = time.time()
    async with BleakClient(device) as client:
        probe = Probe(client, args.output, partial_path, args.stop_after)
        probe.data.extend(initial)
        ok = await probe.run()
        print(f"[probe] done in {time.time() - started:.1f}s ok={ok}")
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
