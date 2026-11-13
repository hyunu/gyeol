import type { AiPipeline, ObjectStorage, Store } from "../ports/store.ts";
import type { SpeakerIdThreshold } from "../domain/types.ts";

export interface Clock {
  now(): Date;
}

export interface Deps {
  store: Store;
  storage: ObjectStorage;
  ai: AiPipeline;
  clock: Clock;
  /** 실험값. D-12 확정 전까지 설정으로 취급한다. */
  speakerThreshold: { provider: string; model: string; threshold: number; margin: number };
  upload: { chunkSizeBytes: number; sessionTtlMs: number };
}

export const defaultDeps = (partial: Partial<Deps> & Pick<Deps, "store" | "storage" | "ai">): Deps => ({
  clock: { now: () => new Date() },
  speakerThreshold: { provider: "fake", model: "fake-v1", threshold: 0.8, margin: 0.05 },
  upload: { chunkSizeBytes: 256 * 1024, sessionTtlMs: 24 * 60 * 60 * 1000 },
  ...partial,
});

export function thresholdsOf(deps: Deps): SpeakerIdThreshold[] {
  return [deps.speakerThreshold];
}

export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 200;

export function pagination(pageRaw: unknown, sizeRaw: unknown): { page: number; size: number } {
  const page = Math.max(1, Number(pageRaw ?? 1) || 1);
  const size = Math.min(PAGE_MAX, Math.max(1, Number(sizeRaw ?? PAGE_DEFAULT) || PAGE_DEFAULT));
  return { page, size };
}
