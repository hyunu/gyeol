import type { IdentificationStatus } from "./types.ts";

export interface IdentificationCandidate {
  personId: string;
  score: number;
}

export interface IdentificationDecision {
  status: IdentificationStatus;
  personId: string | null;
  confidence: number | null;
  reason: string;
}

/**
 * 화자 식별 판정 (M-03).
 *
 * - threshold 이상 + 1위/2위 격차 margin 이상일 때만 `suggested`.
 * - 어떤 경우에도 자동으로 `confirmed` 가 되지 않는다(사용자 확인 필요).
 * - 미달이면 `unknown` — 잘못된 식별보다 미식별을 우선한다.
 */
export function decideIdentification(
  candidates: IdentificationCandidate[],
  threshold: number,
  margin: number,
): IdentificationDecision {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const best = sorted[0];

  if (!best) {
    return { status: "unknown", personId: null, confidence: null, reason: "후보 없음" };
  }
  if (best.score < threshold) {
    return {
      status: "unknown",
      personId: null,
      confidence: best.score,
      reason: `임계값 미달(${best.score.toFixed(3)} < ${threshold.toFixed(3)})`,
    };
  }
  const second = sorted[1];
  if (second && best.score - second.score < margin) {
    return {
      status: "unknown",
      personId: null,
      confidence: best.score,
      reason: `1·2위 격차 부족(${(best.score - second.score).toFixed(3)} < ${margin.toFixed(3)})`,
    };
  }
  return {
    status: "suggested",
    personId: best.personId,
    confidence: best.score,
    reason: "임계값·격차 충족, 사용자 확인 대기",
  };
}
