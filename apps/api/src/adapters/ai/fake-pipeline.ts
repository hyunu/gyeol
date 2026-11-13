import type { AiPipeline, ObjectStorage } from "../../ports/store.ts";
import type { AnalysisResult, Recording } from "../../domain/types.ts";

/**
 * Fake AI Pipeline.
 *
 * 실제 STT/화자분리를 대체해 "서버 → 도메인 → 저장 → API" 전 구간을 하드웨어·외부 AI 없이
 * 검증하기 위한 어댑터다. 결과는 입력(sha256, 시작 시각)에 대해 결정적이다.
 *
 * 교체 지점: `AiPipeline` 포트. 실제 provider 는 같은 포트를 구현한다.
 */
export class FakeAiPipeline implements AiPipeline {
  private readonly dim: number;

  constructor(dim = 768) {
    this.dim = dim;
  }

  async analyze(input: { recording: Recording }): Promise<AnalysisResult> {
    const r = input.recording;
    const duration = Math.max(3000, r.durationMs);
    const third = Math.floor(duration / 3);

    const segments = [
      { seq: 0, startMs: 0, endMs: third, text: "이번 주말에 북한산 갈래?", speakerLabel: "SPEAKER_1", confidence: 0.96 },
      { seq: 1, startMs: third, endMs: third * 2, text: "좋아, 토요일 여덟 시에 출발하자.", speakerLabel: "SPEAKER_2", confidence: 0.91 },
      { seq: 2, startMs: third * 2, endMs: duration, text: "준비물은 내가 챙길게.", speakerLabel: "SPEAKER_1", confidence: 0.89 },
    ];

    const summary =
      "주말 북한산 등산을 계획했다. 토요일 여덟 시에 출발하고, 준비물은 한 사람이 챙기기로 했다.";
    const title = "북한산 등산 계획";

    return {
      title,
      summary,
      language: "ko",
      status: "ready",
      speakers: [
        // 0.93 은 실험 임계값(0.80)을 넘으므로 suggested, 자동 confirmed 는 아니다.
        { label: "SPEAKER_1", personName: "김민수", confidence: 0.93 },
        // 식별 불가 → persons 행을 만들지 않는다.
        { label: "SPEAKER_2", personName: null, confidence: null },
      ],
      segments,
      entities: [
        { kind: "place", value: "북한산", normalizedValue: "북한산", confidence: 0.88, segmentSeq: 0 },
        { kind: "appointment", value: "토요일 여덟 시", normalizedValue: "sat 08:00", confidence: 0.72, segmentSeq: 1 },
        { kind: "task", value: "준비물 챙기기", normalizedValue: null, confidence: 0.65, segmentSeq: 2 },
      ],
      actionItems: [
        {
          title: "토요일 8시 출발 준비",
          dueAt: new Date(r.startedAt.getTime() + 24 * 60 * 60 * 1000),
          confidence: 0.7,
          entityIndex: 1,
        },
      ],
      embedding: {
        provider: "fake",
        model: "fake-embed-v1",
        dim: this.dim,
        vector: embed(`${title} ${summary}`, this.dim),
      },
      pipeline: {
        provider: "fake",
        model: "fake-v1",
        stages: {
          stt: "ok",
          diarization: "ok",
          identification: "ok",
          summary: "ok",
          extraction: "ok",
          embedding: "ok",
        },
        inputBytes: r.byteSize,
      },
    };
  }

  async embedQuery(text: string): Promise<number[]> {
    return embed(text, this.dim);
  }
}

/** 문자 트라이그램 해싱 임베딩. 유사 문자열이 유사 벡터가 되도록 한다(테스트용). */
export function embed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i + 2 < normalized.length; i += 1) {
    v[fnv1a(normalized.slice(i, i + 3)) % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
