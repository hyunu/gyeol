#!/usr/bin/env node
/**
 * 로컬(데모) AI Provider — GYEOL AI HTTP 계약(/v1/analyze, /v1/embed) 구현.
 *
 * 목적: 외부 STT/LLM provider 없이도 검증 웹앱에서 샘플별 텍스트·요약·화자분리
 * 결과가 다르게 표시되도록 한다. demo/audio-samples 의 각 WAV(sha256 기준)에
 * 대해 사전 정의된 분석 결과를 반환하고, 미등록 오디오에는 범용 결과를 생성한다.
 *
 * 실행: node scripts/local-ai-provider.mjs  (기본 8787)
 * 연동: GYEOL_AI=http AI_PROVIDER_URL=http://127.0.0.1:8787 npm start
 */
import http from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.LOCAL_AI_PORT ?? process.env.PORT ?? 8787);
const DIM = 768;

// ---------- embedding (fake-pipeline 과 동일한 트라이그램 해싱, 결정적) ----------
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}
function embed(text, dim = DIM) {
  const v = new Array(dim).fill(0);
  const normalized = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i + 2 < normalized.length; i += 1) v[fnv1a(normalized.slice(i, i + 3)) % dim] += 1;
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

// ---------- universal analysis path (no sample-specific bypass) ----------
// 샘플 포함 모든 오디오는 동일한 범용 경로로 분석한다.
// 백엔드 선택: OPENAI_API_KEY(또는 UNIVERSAL_BACKEND=openai) -> OpenAI 기반,
//             WHISPER_CPP_BIN+WHISPER_CPP_MODEL(또는 자동 탐지) -> whisper.cpp 로컬 STT.
// 어떤 백엔드도 구성되지 않으면 "눈가리고 아웅"식 가짜 전사를 만들지 않고 명확히 실패한다.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function env(name, fallback = "") { return (process.env[name] ?? fallback).trim(); }

function withSeq(arr) { return arr.map((s, i) => ({ ...s, seq: i })); }

function buildAnalysis({ title, summary, language = "ko", speakers, segments, entities = [], actionItems = [], provider, model, stages }) {
  const textForEmbed = `${title} ${summary} ${(segments||[]).map(s=>s.text).join(" ")}`;
  return {
    title, summary, language, status: "ready",
    speakers, segments: withSeq(segments || []), entities, actionItems,
    embedding: { provider, model: `${model}-embed`, dim: DIM, vector: embed(textForEmbed, DIM) },
    pipeline: { provider, model, stages },
  };
}

function ensureConfigured() {
  const hasOpenAi = !!env("OPENAI_API_KEY");
  const whisperBin = env("WHISPER_CPP_BIN") || env("WHISPER_BIN") || "";
  const whisperModel = env("WHISPER_CPP_MODEL") || env("WHISPER_MODEL") || "";
  if (!hasOpenAi && !(whisperBin && whisperModel)) {
    throw new Error(
      "범용 음성 분석 백엔드가 구성되지 않았습니다. " +
      "샘플 포함 모든 오디오는 동일한 실제 분석 경로를 사용해야 하며, 가짜/매핑 전사는 비활성화되어 있습니다. " +
      "다음 중 하나를 설정하세요: " +
      "(A) 외부 API: OPENAI_API_KEY (선택: OPENAI_STT_MODEL, OPENAI_CHAT_MODEL) " +
      "(B) 로컬 STT: WHISPER_CPP_BIN(whisper-cli 경로) + WHISPER_CPP_MODEL(ggml 모델 경로). " +
      "자세한 필요 정보는 서버 로그/문서를 확인하세요."
    );
  }
}

// ---- OpenAI-backed universal analysis (STT + LLM summary/diarization structuring) ----
async function analyzeWithOpenAI(audio, meta) {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY 없음");
  const sttModel = env("OPENAI_STT_MODEL", "whisper-1");
  const chatModel = env("OPENAI_CHAT_MODEL", "gpt-4o-mini");
  const base = env("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, "");

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
  form.append("model", sttModel);
  form.append("response_format", "verbose_json");
  form.append("language", "ko");
  const trRes = await fetch(`${base}/audio/transcriptions`, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form,
  });
  if (!trRes.ok) throw new Error(`OpenAI STT 오류 ${trRes.status}: ${(await trRes.text()).slice(0,400)}`);
  const tr = await trRes.json();
  const rawSegments = Array.isArray(tr.segments) ? tr.segments : [];
  const transcript = String(tr.text || rawSegments.map(s=>s.text).join(" ") || "").trim();
  const durationMs = Number(meta?.recording?.durationMs) || Math.round((Number(tr.duration)||35)*1000);

  // LLM으로 요약/화자분리(구조화)/엔티티 생성 — 동일 경로, 실제 전사 기반
  const prompt = {
    transcript,
    segments: rawSegments.map(s=>({start:s.start,end:s.end,text:s.text})),
    durationMs,
    instructions: "한국어 대화 음성의 전사 결과를 바탕으로 JSON만 반환. keys: title(string), summary(string), speakers([{label,personName,confidence}]), segments([{startMs,endMs,text,speakerLabel,confidence}]), entities([{kind,value,normalizedValue,confidence,segmentSeq}]). 화자는 실제 발화 흐름에 따라 SPEAKER_1.. 로 분리(최소 1명). segments는 전사 구간을 활용해 시간(ms) 포함."
  };
  const chatRes = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: chatModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You structure speech transcripts into JSON. Return strict JSON only." },
        { role: "user", content: JSON.stringify(prompt) },
      ],
      temperature: 0.2,
    }),
  });
  if (!chatRes.ok) throw new Error(`OpenAI 구조화 오류 ${chatRes.status}: ${(await chatRes.text()).slice(0,400)}`);
  const chat = await chatRes.json();
  let parsed = {};
  try { parsed = JSON.parse(chat.choices?.[0]?.message?.content || "{}"); } catch { parsed = {}; }

  const speakers = Array.isArray(parsed.speakers) && parsed.speakers.length ? parsed.speakers : [{ label: "SPEAKER_1", personName: null, confidence: null }];
  let segments = Array.isArray(parsed.segments) && parsed.segments.length ? parsed.segments.map((s,i)=>({
    seq:i, startMs: Number(s.startMs ?? (rawSegments[i]?.start*1000) ?? 0), endMs: Number(s.endMs ?? (rawSegments[i]?.end*1000) ?? durationMs),
    text: String(s.text ?? rawSegments[i]?.text ?? "").trim(), speakerLabel: String(s.speakerLabel || "SPEAKER_1"), confidence: typeof s.confidence==="number"?s.confidence:0.85,
  })) : rawSegments.map((s,i)=>({ seq:i, startMs: Math.round((s.start||0)*1000), endMs: Math.round((s.end||0)*1000), text: String(s.text||"").trim(), speakerLabel: "SPEAKER_1", confidence: 0.85 }));
  if (!segments.length && transcript) segments = [{ seq:0, startMs:0, endMs:durationMs, text: transcript, speakerLabel: "SPEAKER_1", confidence: 0.8 }];
  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  return buildAnalysis({
    title: String(parsed.title || "음성 대화").slice(0,120),
    summary: String(parsed.summary || transcript.slice(0,200) || "전사 요약").slice(0,1000),
    language: String(tr.language || "ko"),
    speakers, segments, entities,
    provider: "openai", model: `${sttModel}+${chatModel}`,
    stages: { stt: "ok", diarization: "ok", identification: "ok", summary: "ok", extraction: "ok", embedding: "ok" },
  });
}

// ---- whisper.cpp-backed local STT (universal) ----
async function analyzeWithWhisperCpp(audio, meta) {
  const bin = env("WHISPER_CPP_BIN") || env("WHISPER_BIN");
  const model = env("WHISPER_CPP_MODEL") || env("WHISPER_MODEL");
  if (!bin || !model) throw new Error("WHISPER_CPP_BIN/WHISPER_CPP_MODEL 미설정");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gyeol-stt-"));
  const wavPath = path.join(tmp, "audio.wav");
  const outBase = path.join(tmp, "out");
  try {
    await writeFile(wavPath, audio);
    const args = ["-m", model, "-f", wavPath, "-of", outBase, "-oj", "-l", env("WHISPER_LANG","ko"), "-nt"];
    await new Promise((resolve, reject) => {
      const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let err = ""; p.stderr.on("data", d=> err += d.toString());
      p.on("error", reject);
      p.on("close", (code)=> code===0 ? resolve() : reject(new Error(`whisper.cpp 종료코드 ${code}: ${err.slice(-400)}`)));
    });
    let json = {};
    try { json = JSON.parse(await readFile(`${outBase}.json`, "utf8")); } catch {}
    const trSegments = Array.isArray(json.transcription) ? json.transcription : [];
    const durationMs = Number(meta?.recording?.durationMs) || (trSegments.length ? Math.round((trSegments[trSegments.length-1].offsets?.to||trSegments[trSegments.length-1].t1||35000)) : 35000);
    const segments = trSegments.map((s,i)=>({
      seq:i,
      startMs: Number(s.offsets?.from ?? s.t0 ?? 0),
      endMs: Number(s.offsets?.to ?? s.t1 ?? durationMs),
      text: String(s.text||"").trim(),
      speakerLabel: "SPEAKER_1", confidence: 0.8,
    })).filter(s=>s.text);
    const transcript = segments.map(s=>s.text).join(" ").trim();
    const title = (transcript.split(/[.!?\n]/)[0] || "음성 대화").slice(0,60) || "음성 대화";
    const summary = transcript.length > 180 ? transcript.slice(0,180) + "…" : (transcript || "전사 결과 없음");
    return buildAnalysis({
      title, summary, language: env("WHISPER_LANG","ko"),
      speakers: [{ label: "SPEAKER_1", personName: null, confidence: null }],
      segments: segments.length ? segments : [{ seq:0,startMs:0,endMs:durationMs,text: transcript || "(전사된 텍스트 없음)", speakerLabel:"SPEAKER_1", confidence:0.5 }],
      entities: [],
      provider: "whisper.cpp", model: path.basename(model),
      stages: { stt: segments.length?"ok":"partial", diarization: "partial", identification: "skipped", summary: "ok", extraction: "skipped", embedding: "ok" },
    });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(()=>{});
  }
}

async function analyzeUniversal(audio, meta) {
  ensureConfigured();
  if (env("OPENAI_API_KEY")) return analyzeWithOpenAI(audio, meta);
  return analyzeWithWhisperCpp(audio, meta);
}


// ---------- multipart parser (minimal, for metadata + audio parts) ----------
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType || "");
  if (!m) throw new Error("boundary missing");
  const boundary = m[1] || m[2];
  const sep = Buffer.from(`--${boundary}`);
  const parts = {};
  let idx = 0;
  while (true) {
    const start = buffer.indexOf(sep, idx);
    if (start === -1) break;
    let headerStart = start + sep.length;
    if (buffer.slice(headerStart, headerStart + 2).toString() === "--") break;
    if (buffer.slice(headerStart, headerStart + 2).toString() === "\r\n") headerStart += 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;
    const headers = buffer.slice(headerStart, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const next = buffer.indexOf(sep, dataStart);
    let dataEnd = next === -1 ? buffer.length : next - 2; // strip \r\n
    if (dataEnd < dataStart) dataEnd = dataStart;
    const nameM = /name="([^"]+)"/i.exec(headers);
    const name = nameM ? nameM[1] : "unknown";
    parts[name] = buffer.slice(dataStart, dataEnd);
    idx = next === -1 ? buffer.length : next;
  }
  return parts;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      const backend = env("OPENAI_API_KEY") ? "openai" : (env("WHISPER_CPP_BIN") && env("WHISPER_CPP_MODEL")) ? "whisper.cpp" : "unconfigured";
      return send(res, 200, { status: "ok", provider: "universal", backend });
    }
    if (req.method === "POST" && url.pathname === "/v1/embed") {
      const body = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(body.toString("utf8") || "{}"); } catch {}
      const dim = Number(payload.dim) || DIM;
      return send(res, 200, { vector: embed(payload.text || "", dim) });
    }
    if (req.method === "POST" && url.pathname === "/v1/analyze") {
      const body = await readBody(req);
      const parts = parseMultipart(body, req.headers["content-type"] || "");
      let meta = {};
      try { meta = JSON.parse((parts.metadata || Buffer.alloc(0)).toString("utf8") || "{}"); } catch {}
      const audio = parts.audio || Buffer.alloc(0);
      // 모든 오디오(샘플 포함)를 동일한 범용 분석 경로로 처리한다. 샘플별 매핑 없음.
      const result = await analyzeUniversal(audio, meta);
      return send(res, 200, result);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const backend = env("OPENAI_API_KEY") ? "openai" : (env("WHISPER_CPP_BIN") && env("WHISPER_CPP_MODEL")) ? "whisper.cpp" : "unconfigured";
  console.log(`universal-ai-provider listening on http://127.0.0.1:${PORT} (backend=${backend})`);
});
