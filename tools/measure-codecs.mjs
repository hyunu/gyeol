#!/usr/bin/env node
/**
 * D-04 코덱 비교 측정 (W-11).
 *
 * 16 kHz mono 60초 기준으로 WAV PCM / IMA ADPCM / Opus 비트레이트를 실제 파일로 측정한다.
 * ffmpeg 가 필요하다(개발 도구 전용, CI 에서는 실행하지 않는다).
 *
 * 사용: npm run codec:measure
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const DURATION_S = 60;
const SAMPLE_RATE = 16_000;
const SD_CAPACITY_BYTES = 8 * 1000 ** 3;

const dir = await mkdtemp(path.join(tmpdir(), "gyeol-codec-"));

try {
  const base = path.join(dir, "base.wav");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=220:duration=${DURATION_S}:sample_rate=${SAMPLE_RATE}`,
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=duration=${DURATION_S}:color=pink:amplitude=0.02:sample_rate=${SAMPLE_RATE}`,
    "-filter_complex",
    "[0:a][1:a]amix=inputs=2,volume=2[a]",
    "-map",
    "[a]",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    base,
  ]);

  const targets = [
    { label: "WAV PCM s16le", codec: "wav_pcm_s16le", args: ["-c:a", "pcm_s16le"], ext: "wav" },
    { label: "WAV IMA ADPCM", codec: "wav_ima_adpcm", args: ["-c:a", "adpcm_ima_wav"], ext: "wav" },
    { label: "Opus 12 kbps", codec: "opus_ogg_12k", args: ["-c:a", "libopus", "-b:a", "12k"], ext: "ogg" },
    { label: "Opus 16 kbps", codec: "opus_ogg_16k", args: ["-c:a", "libopus", "-b:a", "16k"], ext: "ogg" },
    { label: "Opus 24 kbps", codec: "opus_ogg_24k", args: ["-c:a", "libopus", "-b:a", "24k"], ext: "ogg" },
    { label: "Opus 32 kbps", codec: "opus_ogg_32k", args: ["-c:a", "libopus", "-b:a", "32k"], ext: "ogg" },
  ];

  const rows = [];
  for (const [index, target] of targets.entries()) {
    const file = path.join(dir, `out-${index}.${target.ext}`);
    if (index === 0) {
      await run("cp", [base, file]);
    } else {
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", base, ...target.args, file]);
    }
    const { size } = await stat(file);
    const bytesPerSecond = size / DURATION_S;
    rows.push({
      label: target.label,
      codec: target.codec,
      bytes: size,
      kbps: (bytesPerSecond * 8) / 1000,
      mbPerHour: (bytesPerSecond * 3600) / 1_000_000,
      hoursIn8GB: SD_CAPACITY_BYTES / (bytesPerSecond * 3600),
      file: path.basename(file),
    });
  }

  console.log(`# D-04 코덱 측정 (${SAMPLE_RATE} Hz mono, ${DURATION_S}s)\n`);
  console.log("| 코덱 | codec 값 | 파일 크기 | kbps | MB/시간 | 8GB 저장 가능 |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    console.log(
      `| ${row.label} | \`${row.codec}\` | ${(row.bytes / 1024).toFixed(1)} KiB | ${row.kbps.toFixed(1)} | ${row.mbPerHour.toFixed(1)} | ${Math.floor(row.hoursIn8GB)}시간 |`,
    );
  }

  const files = (await readdir(dir)).filter((f) => f.startsWith("out-"));
  console.log(`\n산출물: ${dir} (${files.length} files)`);
} finally {
  if (!process.argv.includes("--keep")) {
    await rm(dir, { recursive: true, force: true });
  }
}
