import type { IncomingMessage } from "node:http";
import { unauthorized } from "../domain/errors.ts";
import { isUuid } from "../domain/ids.ts";
import type { SessionIdentity } from "../usecases/auth.ts";
import { authenticateSessionToken } from "../usecases/auth.ts";
import type { Deps } from "../usecases/deps.ts";

export const DEMO_USER_ID = "0199aaaa-0000-7000-8000-000000000001";

export const SESSION_COOKIE = "gyeol_session";

/**
 * 인증 해석 (ADR-0010 + ADR-0003).
 *
 * 1. `Authorization: Bearer <token>` 또는 `gyeol_session` 쿠키
 * 2. 로컬 개발에 한해 `X-User-Id`
 *
 * 토큰이 있는데 유효하지 않으면 로컬 헤더로 되돌아가지 않는다(fail-closed).
 */
export async function resolveAuth(
  req: IncomingMessage,
  env: string,
  deps: Deps,
): Promise<SessionIdentity> {
  const token = bearerToken(req) ?? cookieValue(req, SESSION_COOKIE);
  if (token) {
    const session = await authenticateSessionToken(deps, token);
    return { userId: session.userId, sessionId: session.id, via: "session" };
  }

  if (env !== "local") {
    throw unauthorized("이 환경에서는 X-User-Id 임시 인증이 비활성화되어 있습니다.");
  }

  const raw = req.headers["x-user-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw unauthorized("인증 토큰 또는 X-User-Id 헤더가 필요합니다. (X-User-Id 는 로컬 전용)");
  if (!isUuid(value)) throw unauthorized("X-User-Id 는 UUID 형식이어야 합니다.");
  return { userId: value, sessionId: null, via: "local-header" };
}

function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match) throw unauthorized("Authorization 헤더 형식이 올바르지 않습니다.");
  return match[1];
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
