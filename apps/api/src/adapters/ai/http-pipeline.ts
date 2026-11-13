import type { AiPipeline } from "../../ports/store.ts";
import type { AnalysisResult, Recording } from "../../domain/types.ts";

/**
 * HTTP AI provider 어댑터 (W-18 계약).
 *
 * 실제 vendor 는 정하지 않고, GYEOL 쪽 provider 서비스가 지켜야 할 계약만 고정한다.
 * 계약: docs/13-ai-provider-contract.md
 *
 * - POST {AI_PROVIDER_URL}/v1/analyze   (multipart: metadata JSON + audio)
 * - POST {AI_PROVIDER_URL}/v1/embed     (JSON: {text})
 *
 * 실패(타임아웃·5xx·잘못된 응답)는 모두 예외로 올린다. 분석 작업 큐가 재시도/실패를
 * 결정한다(ADR-0007). provider 응답을 부분적으로 신뢰하지 않는다(fail-closed).
 */

export interface HttpAiPipelineOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  provider?: string;
  model?: string;
  dim?: number;
}

export class AiProviderError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(code: string, message: string, status: number | null = null, retryable = true) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class HttpAiPipeline implements AiPipeline {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly provider: string;
  private readonly model: string;
  private readonly dim: number;

  constructor(options: HttpAiPipelineOptions = {}) {
    const baseUrl = options.baseUrl ?? process.env.AI_PROVIDER_URL;
    if (!baseUrl) {
      throw new Error("AI_PROVIDER_URL 이 필요합니다. (GYEOL_AI=http)");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = options.token ?? process.env.AI_PROVIDER_TOKEN ?? null;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.AI_PROVIDER_TIMEOUT_MS ?? 120_000);
    this.provider = options.provider ?? process.env.AI_PROVIDER_NAME ?? "http";
    this.model = options.model ?? process.env.AI_PROVIDER_MODEL ?? "unknown";
    this.dim = options.dim ?? Number(process.env.AI_EMBEDDING_DIM ?? 768);
  }

  async analyze(input: { recording: Recording; audio: Buffer }): Promise<AnalysisResult> {
    const metadata = {
      recording: {
        id: input.recording.id,
        clientRecordingId: input.recording.clientRecordingId,
        startedAt: input.recording.startedAt.toISOString(),
        endedAt: input.recording.endedAt.toISOString(),
        durationMs: input.recording.durationMs,
        codec: input.recording.codec,
        codecParams: input.recording.codecParams,
        sampleRateHz: input.recording.sampleRateHz,
        channels: input.recording.channels,
        byteSize: input.recording.byteSize,
        sha256: input.recording.sha256,
      },
      expected: { textEmbeddingDim: this.dim, language: "ko" },
    };

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("audio", new Blob([input.audio], { type: "application/octet-stream" }), "audio.bin");

    const body = await this.request("/v1/analyze", { method: "POST", body: form });
    return parseAnalysisResult(body, this.dim);
  }

  async embedQuery(text: string): Promise<number[]> {
    const body = await this.request("/v1/embed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, dim: this.dim }),
    });
    const parsed = asObject(body, "embed 응답이 객체가 아닙니다.");
    const vector = parsed.vector;
    if (!Array.isArray(vector) || vector.length !== this.dim) {
      throw invalidResponse(`embedding 차원이 ${this.dim} 이 아닙니다.`);
    }
    return vector.map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw invalidResponse("embedding 값이 숫자가 아닙니다.");
      }
      return value;
    });
  }

  private async request(pathName: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathName}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...init.headers,
        },
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AiProviderError("AI_TIMEOUT", `AI provider 응답 시간 초과 (${this.timeoutMs}ms)`);
      }
      throw new AiProviderError(
        "AI_UNREACHABLE",
        `AI provider 에 연결하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      throw new AiProviderError(
        "AI_PROVIDER_ERROR",
        `AI provider 오류 ${response.status}: ${text.slice(0, 500)}`,
        response.status,
        retryable,
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw invalidResponse("AI provider 응답이 JSON 이 아닙니다.");
    }
  }
}

// ------------------------------------------------------------------ validation

function parseAnalysisResult(value: unknown, dim: number): AnalysisResult {
  const root = asObject(value, "분석 응답이 객체가 아닙니다.");
  const embedding = asObject(root.embedding, "embedding 이 없습니다.");
  if (!Array.isArray(embedding.vector) || embedding.vector.length !== dim) {
    throw invalidResponse(`분석 embedding 차원이 ${dim} 이 아닙니다.`);
  }
  if (!Array.isArray(root.speakers) || !Array.isArray(root.segments)) {
    throw invalidResponse("speakers/segments 가 배열이 아닙니다.");
  }
  if (!Array.isArray(root.entities) || !Array.isArray(root.actionItems)) {
    throw invalidResponse("entities/actionItems 가 배열이 아닙니다.");
  }
  if (typeof root.title !== "string" || typeof root.summary !== "string") {
    throw invalidResponse("title/summary 가 문자열이 아닙니다.");
  }
  if (root.status !== "ready" && root.status !== "partial") {
    throw invalidResponse(`status 값이 올바르지 않습니다: ${String(root.status)}`);
  }

  return {
    title: root.title,
    summary: root.summary,
    language: typeof root.language === "string" ? root.language : "ko",
    status: root.status,
    speakers: root.speakers.map((speaker, index) =>
      asObject(speaker, `speakers[${index}] 가 객체가 아닙니다.`) as never,
    ),
    segments: root.segments.map((segment, index) =>
      asObject(segment, `segments[${index}] 가 객체가 아닙니다.`),
    ) as never,
    entities: root.entities.map((entity, index) =>
      asObject(entity, `entities[${index}] 가 객체가 아닙니다.`),
    ) as never,
    actionItems: root.actionItems.map((item, index) => {
      const action = asObject(item, `actionItems[${index}] 가 객체가 아닙니다.`);
      if (typeof action.title !== "string") {
        throw invalidResponse(`actionItems[${index}].title 이 없습니다.`);
      }
      const dueAt =
        typeof action.dueAt === "string"
          ? new Date(action.dueAt)
          : action.dueAt === null || action.dueAt === undefined
            ? null
            : null;
      if (dueAt && Number.isNaN(dueAt.getTime())) {
        throw invalidResponse(`actionItems[${index}].dueAt 이 날짜가 아닙니다.`);
      }
      return {
        title: action.title,
        dueAt,
        confidence: numberOrNull(action.confidence),
        entityIndex: numberOrNull(action.entityIndex),
      };
    }),
    embedding: {
      provider: typeof embedding.provider === "string" ? embedding.provider : "http",
      model: typeof embedding.model === "string" ? embedding.model : "unknown",
      dim,
      vector: embedding.vector.map((value) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw invalidResponse("embedding 값이 숫자가 아닙니다.");
        }
        return value;
      }),
    },
    pipeline: asObject(root.pipeline ?? {}, "pipeline 이 객체가 아닙니다."),
  };
}

function asObject(value: unknown, message: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(message);
  }
  return value as Record<string, any>;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function invalidResponse(message: string): AiProviderError {
  return new AiProviderError("AI_INVALID_RESPONSE", `AI provider 응답 형식 오류: ${message}`, 502, false);
}
