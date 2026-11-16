export interface WavInfo {
  codec: string;
  sampleRateHz: number;
  channels: number;
  durationMs: number;
}

function fourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** WAV 헤더에서 코덱/샘플레이트/채널/길이를 파싱한다 (모바일 WavMetadata와 동일한 규칙). */
export function parseWav(buffer: ArrayBuffer, fileSize: number): WavInfo {
  if (buffer.byteLength < 44) throw new Error("WAV 헤더가 너무 짧습니다.");
  const view = new DataView(buffer);
  if (fourCC(view, 0) !== "RIFF" || fourCC(view, 8) !== "WAVE") {
    throw new Error("WAV(RIFF/WAVE) 형식이 아닙니다.");
  }

  let offset = 12;
  let fmtFound = false;
  let audioFormat = 1;
  let channels = 1;
  let sampleRateHz = 16000;
  let bitsPerSample = 16;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const id = fourCC(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= view.byteLength) {
      fmtFound = true;
      audioFormat = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRateHz = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataSize = size;
    }
    offset = body + size + (size % 2);
  }

  if (!fmtFound) throw new Error("fmt 청크를 찾지 못했습니다.");
  if (dataSize === 0) {
    // 헤더만 읽은 경우 파일 크기에서 대략 추정
    dataSize = Math.max(0, fileSize - 44);
  }
  const bytesPerSample = Math.max(1, (bitsPerSample / 8) * Math.max(1, channels));
  const samples = dataSize / bytesPerSample;
  const durationMs = sampleRateHz > 0 ? Math.round((samples / sampleRateHz) * 1000) : 0;

  let codec = "wav_pcm_s16le";
  if (audioFormat === 0x0001) {
    codec = bitsPerSample === 16 ? "wav_pcm_s16le" : `wav_pcm_${bitsPerSample}`;
  } else if (audioFormat === 0x0011) {
    codec = "wav_ima_adpcm";
  } else {
    codec = `wav_${audioFormat.toString(16)}`;
  }

  return { codec, sampleRateHz, channels, durationMs };
}

