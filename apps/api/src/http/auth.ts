import type { IncomingMessage } from "node:http";
import { csrfRequired, unauthorized } from "../domain/errors.ts";
import { isUuid } from "../domain/ids.ts";
import type { SessionIdentity } from "../usecases/auth.ts";
import { authenticateSessionToken } from "../usecases/auth.ts";
import type { Deps } from "../usecases/deps.ts";

export const DEMO_USER_ID = "0199aaaa-0000-7000-8000-000000000001";

export const SESSION_COOKIE = "gyeol_session";
export const CSRF_HEADER = "x-gyeol-csrf";

/**
 * 웹 세션 쿠키 (ADR-0010). `HttpOnly` 라 JS 에서 읽을 수 없고,
 * `SameSite=Lax` 로 교차 사이트 변경 요청을 막는다. 운영에서는 `Secure` 를 붙인다.
 */
export function sessionCookie(token: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookie(options: { secure: boolean }): string {
  return sessionCookie("", { secure: options.secure, maxAgeSeconds: 0 });
}

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
  const bearer = bearerToken(req);
  const cookie = bearer ? null : cookieValue(req, SESSION_COOKIE);
  const token = bearer ?? cookie;
  if (token) {
    // 쿠키는 브라우저가 자동 전송하므로, 변경 요청에는 CSRF 커스텀 헤더를 요구한다.
    if (cookie && isMutating(req.method)) assertCsrf(req);
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

function isMutating(method: string | undefined): boolean {
  const value = (method ?? "GET").toUpperCase();
  return value !== "GET" && value !== "HEAD" && value !== "OPTIONS";
}

function assertCsrf(req: IncomingMessage): void {
  const raw = req.headers[CSRF_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value !== "1") throw csrfRequired();
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
