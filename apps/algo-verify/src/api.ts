const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
const DEV_USER = "0199aaaa-0000-7000-8000-000000000001";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-User-Id", DEV_USER);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    // caller sets when needed
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "HTTP_ERROR", err.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export interface Device { id: string; serialNo: string; model: string }
export interface Recording { id: string; status: string }
export interface UploadSession { id: string; status: string; receivedBytes: number; chunkSizeBytes: number }
export interface AnalysisJob { id: string; status: string; conversationId: string | null; lastError: string | null }

export interface TranscriptSegment {
  id: string; seq: number; startMs: number; endMs: number; text: string;
  speakerClusterId: string | null; confidence: number | null;
}
export interface SpeakerCluster {
  id: string; label: string; personId: string | null; displayName: string | null;
  identificationStatus: string; confidence: number | null;
}
export interface ConversationDetail {
  id: string; title: string | null; summary: string | null; status: string;
  speakers: SpeakerCluster[];
  segments: TranscriptSegment[];
  entities: Array<{ id: string; kind: string; value: string; confidence: number | null }>;
  actionItems: Array<{ id: string; title: string; status: string }>;
  recordingIds: string[];
}

export async function ensureDevice(): Promise<Device> {
  const list = await request<{ items: Device[] }>("/api/v1/devices");
  const serial = "VERIFY-DEMO-001";
  const found = list.items?.find((d) => d.serialNo === serial);
  if (found) return found;
  const created = await request<Device>("/api/v1/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serialNo: serial, model: "algo-verify", firmwareVersion: "demo" }),
  });
  return created;
}

export async function createRecording(params: {
  deviceId: string;
  clientRecordingId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  codec: string;
  sampleRateHz: number;
  channels: number;
  byteSize: number;
  sha256: string;
}): Promise<{ recording: Recording; uploadSession: UploadSession }> {
  return request("/api/v1/recordings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

export async function putChunk(recordingId: string, sessionId: string, offset: number, chunk: Uint8Array): Promise<{ recording: Recording; uploadSession: UploadSession }> {
  const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
  return request(`/api/v1/recordings/${recordingId}/upload-sessions/${sessionId}/chunks?offset=${offset}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: ab,
  });
}

export async function ack(recordingId: string): Promise<{ recording: Recording }> {
  return request(`/api/v1/recordings/${recordingId}/ack`, { method: "POST" });
}

export async function analyze(recordingId: string): Promise<AnalysisJob> {
  return request(`/api/v1/recordings/${recordingId}/analyze`, { method: "POST" });
}

export async function getJob(jobId: string): Promise<AnalysisJob> {
  return request(`/api/v1/analysis-jobs/${jobId}`);
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  return request(`/api/v1/conversations/${id}`);
}
