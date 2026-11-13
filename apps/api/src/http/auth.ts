import type { IncomingMessage } from "node:http";
import { unauthorized } from "../domain/errors.ts";
import { isUuid } from "../domain/ids.ts";

export const DEMO_USER_ID = "0199aaaa-0000-7000-8000-000000000001";

/**
 * 임시 사용자 식별 (ADR-0003).
 * `X-User-Id` 는 로컬 환경에서만 허용한다. 그 외 환경은 fail-closed.
 */
export function resolveUserId(req: IncomingMessage, env: string): string {
  if (env !== "local") {
    throw unauthorized("이 환경에서는 X-User-Id 임시 인증이 비활성화되어 있습니다.");
  }
  const raw = req.headers["x-user-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw unauthorized("X-User-Id 헤더가 필요합니다. (로컬 개발 전용)");
  if (!isUuid(value)) throw unauthorized("X-User-Id 는 UUID 형식이어야 합니다.");
  return value;
}
