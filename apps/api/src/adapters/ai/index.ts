import { FakeAiPipeline } from "./fake-pipeline.ts";
import { HttpAiPipeline } from "./http-pipeline.ts";
import type { AiPipeline } from "../../ports/store.ts";

/**
 * `GYEOL_AI` 로 AI 파이프라인을 고른다.
 * 실제 provider 설정이 없으면 조용히 Fake 로 떨어지지 않고 즉시 실패한다(fail-closed).
 */
export function createAiFromEnv(kind = process.env.GYEOL_AI ?? "fake"): AiPipeline {
  if (kind === "fake") return new FakeAiPipeline();
  if (kind === "http") return new HttpAiPipeline();
  throw new Error(`GYEOL_AI 값이 올바르지 않습니다: ${kind} (fake|http)`);
}
