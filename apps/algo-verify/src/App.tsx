import { useMemo, useState } from "react";
import samples from "./samples.json";
import { parseWav } from "./wav";
import { sha256Hex } from "./sha256";
import * as api from "./api";

type Phase =
  | "idle"
  | "fetching"
  | "hashing"
  | "device"
  | "recording"
  | "uploading"
  | "acking"
  | "analyzing"
  | "polling"
  | "loading"
  | "done"
  | "error";

interface Sample {
  file: string;
  segment: string;
  title: string;
  source: string;
}

interface RunState {
  phase: Phase;
  message: string;
  progress?: number; // 0..1
  detail?: api.ConversationDetail | null;
  job?: api.AnalysisJob | null;
  error?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function App() {
  const [selected, setSelected] = useState<Sample | null>(null);
  const [run, setRun] = useState<RunState>({ phase: "idle", message: "샘플을 선택하세요." });
  const [busy, setBusy] = useState(false);

  const list = samples as Sample[];

  async function runAnalysis(sample: Sample) {
    if (busy) return;
    setBusy(true);
    setRun({ phase: "fetching", message: "샘플 오디오를 불러오는 중…", progress: 0 });
    try {
      const res = await fetch(`/samples/${encodeURIComponent(sample.file)}`);
      if (!res.ok) throw new Error(`샘플을 불러오지 못했습니다 (${res.status})`);
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      setRun({ phase: "hashing", message: "WAV 메타데이터 파싱 및 SHA-256 계산 중…" });
      const info = parseWav(buffer, buffer.byteLength);
      const sha256 = await sha256Hex(buffer);
      const now = new Date();
      const durationMs = info.durationMs || Math.round((buffer.byteLength / (info.sampleRateHz * info.channels * 2)) * 1000);
      const startedAt = new Date(now.getTime() - durationMs);
      const clientRecordingId = `verify:${sample.file}:${Date.now()}`;

      setRun({ phase: "device", message: "검증용 기기 확인/등록 중…" });
      const device = await api.ensureDevice();

      setRun({ phase: "recording", message: "녹음·업로드 세션 생성 중…" });
      const created = await api.createRecording({
        deviceId: device.id,
        clientRecordingId,
        startedAt: startedAt.toISOString(),
        endedAt: now.toISOString(),
        durationMs,
        codec: info.codec,
        sampleRateHz: info.sampleRateHz,
        channels: info.channels,
        byteSize: bytes.byteLength,
        sha256,
      });

      let recordingId = created.recording.id;
      let sessionId = created.uploadSession.id;
      let offset = created.uploadSession.receivedBytes || 0;
      const chunkSize = Math.max(1, Math.min(256 * 1024, created.uploadSession.chunkSizeBytes || 256 * 1024));

      setRun({ phase: "uploading", message: "오디오 청크 업로드 중…", progress: offset / bytes.byteLength });
      while (offset < bytes.byteLength) {
        const end = Math.min(bytes.byteLength, offset + chunkSize);
        const chunk = bytes.slice(offset, end);
        const prog = await api.putChunk(recordingId, sessionId, offset, chunk);
        offset = prog.uploadSession.receivedBytes;
        if (prog.recording.status === "integrity_failed" || prog.uploadSession.status === "aborted") {
          throw new Error("무결성 검증 실패(integrity_failed) — WAV/해시/크기를 확인하세요.");
        }
        if (prog.recording.status === "stored" || prog.uploadSession.status === "completed") {
          offset = bytes.byteLength;
        }
        setRun((s) => ({ ...s, phase: "uploading", message: `오디오 업로드 중… ${Math.round((offset / bytes.byteLength) * 100)}%`, progress: offset / bytes.byteLength }));
      }

      setRun({ phase: "acking", message: "클라이언트 ACK 전송 중…", progress: 1 });
      await api.ack(recordingId);

      setRun({ phase: "analyzing", message: "분석 작업 등록(/analyze) 중…" });
      const job = await api.analyze(recordingId);

      setRun({ phase: "polling", message: "분석 결과 대기 중(텍스트 추출·요약·화자분리)…", job });
      let finalJob = job;
      for (let i = 0; i < 90; i++) {
        finalJob = await api.getJob(job.id);
        if (finalJob.status === "succeeded") break;
        if (finalJob.status === "failed") {
          throw new Error(finalJob.lastError || "분석 작업이 실패했습니다.");
        }
        setRun({ phase: "polling", message: `분석 중… (${i + 1}s, 상태: ${finalJob.status})`, job: finalJob });
        await sleep(1000);
      }
      if (finalJob.status !== "succeeded" || !finalJob.conversationId) {
        throw new Error(finalJob.lastError || "분석이 시간 내 완료되지 않았습니다.");
      }

      setRun({ phase: "loading", message: "대화 상세(텍스트·요약·화자분리) 불러오는 중…", job: finalJob });
      const detail = await api.getConversation(finalJob.conversationId);
      setRun({ phase: "done", message: "완료", detail, job: finalJob, progress: 1 });
    } catch (e: any) {
      const msg = e instanceof api.ApiError ? `${e.message} (${e.code}, ${e.status})` : (e?.message || String(e));
      setRun((s) => ({ ...s, phase: "error", error: msg, message: "실패" }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>GYEOL 알고리즘 검증</h1>
          <p className="sub">모바일/서버 음성 분석 파이프라인 검증 — 샘플 선택 → 텍스트 추출 → 요약 · 화자분리 결과 확인</p>
        </div>
        <div className="badge">병렬 웹앱 · 데모 샘플 {list.length}개</div>
      </header>

      <main className="layout">
        <section className="panel samples">
          <h2>1. 샘플 선택</h2>
          <p className="hint"><code>demo/audio-samples</code> (YouTube 구간, 16kHz mono WAV)</p>
          <ul className="sample-list">
            {list.map((s) => (
              <li key={s.file} className={selected?.file === s.file ? "active" : ""}>
                <button type="button" onClick={() => setSelected(s)} disabled={busy}>
                  <span className="sample-name">{s.file}</span>
                  <span className="sample-title">{s.title}</span>
                  <span className="sample-meta">{s.segment} · <a href={s.source} target="_blank" rel="noreferrer" onClick={(e)=>e.stopPropagation()}>출처</a></span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel run">
          <h2>2. 분석 실행</h2>
          {!selected ? (
            <p className="hint">왼쪽에서 샘플을 선택하세요.</p>
          ) : (
            <>
              <div className="selected-box">
                <div><strong>{selected.file}</strong></div>
                <div className="muted">{selected.title}</div>
              </div>
              <button className="primary" type="button" onClick={() => runAnalysis(selected)} disabled={busy}>
                {busy ? "실행 중…" : "텍스트 추출 · 요약 · 화자분리 실행"}
              </button>
              <p className="hint">기존 API 흐름(녹음 생성→업로드→ACK→/analyze→작업 폴링→대화 조회)으로 실제 파이프라인을 검증합니다.</p>
            </>
          )}

          <div className={`status status-${run.phase}`}>
            <div className="status-phase">{labelOf(run.phase)}</div>
            <div className="status-msg">{run.error || run.message}</div>
            {typeof run.progress === "number" && run.phase !== "done" && run.phase !== "error" && (
              <div className="bar"><div style={{ width: `${Math.round(run.progress * 100)}%` }} /></div>
            )}
          </div>

          {run.detail && <ResultView detail={run.detail} />}
        </section>
      </main>
    </div>
  );
}

function labelOf(p: Phase): string {
  const map: Record<Phase, string> = {
    idle: "대기", fetching: "불러오기", hashing: "파싱/해시", device: "기기", recording: "녹음 생성",
    uploading: "업로드", acking: "ACK", analyzing: "분석 등록", polling: "분석 대기", loading: "결과 조회",
    done: "완료", error: "오류",
  };
  return map[p];
}

function ResultView({ detail }: { detail: api.ConversationDetail }) {
  const bySpeaker = useMemo(() => {
    const map = new Map<string | null, api.TranscriptSegment[]>();
    for (const seg of [...detail.segments].sort((a,b)=>a.seq-b.seq)) {
      const k = seg.speakerClusterId;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(seg);
    }
    return map;
  }, [detail]);

  const speakerName = (id: string | null) => {
    if (!id) return "미지정 화자";
    const s = detail.speakers.find((x) => x.id === id);
    if (!s) return id;
    const who = s.displayName || s.personId || "미확인 인물";
    return `${s.label} (${who}, ${s.identificationStatus}${s.confidence != null ? ` ${(s.confidence*100).toFixed(0)}%` : ""})`;
  };

  const fullText = [...detail.segments].sort((a,b)=>a.seq-b.seq).map((s)=>s.text).join("\n");

  return (
    <div className="results">
      <section className="card">
        <h3>요약</h3>
        <div className="kv"><span>제목</span><span>{detail.title || "(없음)"}</span></div>
        <div className="kv"><span>상태</span><span>{detail.status}</span></div>
        <p className="summary">{detail.summary || "(요약 없음)"}</p>
      </section>

      <section className="card">
        <h3>추출 텍스트 (전체)</h3>
        <pre className="transcript">{fullText || "(세그먼트 없음)"}</pre>
      </section>

      <section className="card">
        <h3>화자 분리 결과</h3>
        <table className="table">
          <thead><tr><th>라벨</th><th>인물</th><th>식별 상태</th><th>신뢰도</th></tr></thead>
          <tbody>
            {detail.speakers.map((s) => (
              <tr key={s.id}>
                <td>{s.label}</td>
                <td>{s.displayName || s.personId || <em>미확인</em>}</td>
                <td><span className={`pill pill-${s.identificationStatus}`}>{s.identificationStatus}</span></td>
                <td>{s.confidence != null ? `${(s.confidence*100).toFixed(1)}%` : "-"}</td>
              </tr>
            ))}
            {detail.speakers.length === 0 && <tr><td colSpan={4} className="muted">화자 없음</td></tr>}
          </tbody>
        </table>

        <h4>화자별 세그먼트</h4>
        {Array.from(bySpeaker.entries()).map(([sid, segs]) => (
          <div key={sid ?? "none"} className="speaker-block">
            <div className="speaker-head">{speakerName(sid)} <span className="muted">({segs.length}개)</span></div>
            <ul>
              {segs.map((seg) => (
                <li key={seg.id}><span className="time">[{fmt(seg.startMs)}–{fmt(seg.endMs)}]</span> {seg.text}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>엔티티 / 할 일 (참고)</h3>
        <div className="cols">
          <div>
            <h4>엔티티</h4>
            <ul>{detail.entities.map(e=> <li key={e.id}><code>{e.kind}</code> {e.value}</li>)}{detail.entities.length===0&&<li className="muted">없음</li>}</ul>
          </div>
          <div>
            <h4>할 일</h4>
            <ul>{detail.actionItems.map(a=> <li key={a.id}>{a.title} <span className="muted">({a.status})</span></li>)}{detail.actionItems.length===0&&<li className="muted">없음</li>}</ul>
          </div>
        </div>
      </section>

      <details className="card">
        <summary>원본 응답(JSON)</summary>
        <pre className="transcript">{JSON.stringify(detail, null, 2)}</pre>
      </details>
    </div>
  );
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2,"0")}`;
}
