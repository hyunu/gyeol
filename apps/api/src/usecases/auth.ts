import { createHash, randomBytes } from "node:crypto";
import { authNotConfigured, unauthorized } from "../domain/errors.ts";
import { uuidv7 } from "../domain/ids.ts";
import type { Session, User } from "../domain/types.ts";
import type { Deps } from "./deps.ts";

/**
 * 세션 인증 (ADR-0010).
 *
 * 토큰 원문은 응답에 한 번만 나가고 서버에는 SHA-256 해시만 저장한다.
 * 30일 절대 만료이며 갱신하지 않는다. 폐기(revoked_at)는 즉시 효력이 있다.
 */

export interface IssuedSession {
  token: string;
  session: Session;
  user: User;
}

export interface SessionIdentity {
  userId: string;
  sessionId: string | null;
  /** 헤더/쿠키 세션인지, 로컬 개발용 X-User-Id 인지. */
  via: "session" | "local-header";
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function signInWithApple(
  deps: Deps,
  input: {
    identityToken: string;
    nonce?: string;
    displayName?: string;
    userAgent?: string | null;
  },
): Promise<IssuedSession> {
  if (!deps.identity) throw authNotConfigured();

  const identity = await deps.identity.verify(input.identityToken, input.nonce);
  const displayName = normalizeDisplayName(input.displayName, identity.email);
  const now = deps.clock.now();

  const user = await deps.store.upsertUserByAuthSubject({
    id: uuidv7(now.getTime()),
    authSubject: identity.subject,
    displayName,
  });

  const token = randomBytes(32).toString("base64url");
  const session = await deps.store.createSession({
    id: uuidv7(now.getTime()),
    userId: user.id,
    tokenHash: hashSessionToken(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + deps.auth.sessionTtlMs),
    lastUsedAt: null,
    revokedAt: null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
  });

  return { token, session, user };
}

export async function authenticateSessionToken(
  deps: Deps,
  token: string,
): Promise<Session> {
  if (token.length < 20 || token.length > 200) {
    throw unauthorized("세션 토큰 형식이 올바르지 않습니다.");
  }
  const session = await deps.store.findSessionByTokenHash(hashSessionToken(token));
  const now = deps.clock.now();

  if (!session) throw unauthorized("세션이 유효하지 않습니다.");
  if (session.revokedAt) throw unauthorized("세션이 폐기되었습니다.");
  if (session.expiresAt.getTime() <= now.getTime()) {
    throw unauthorized("세션이 만료되었습니다.");
  }

  // 매 요청 쓰기를 피하려고 5분에 한 번만 갱신한다.
  const staleAfter = 5 * 60 * 1000;
  if (!session.lastUsedAt || now.getTime() - session.lastUsedAt.getTime() > staleAfter) {
    await deps.store.touchSession(session.id, now);
  }
  return session;
}

export async function signOut(deps: Deps, sessionId: string | null): Promise<void> {
  if (sessionId) await deps.store.revokeSession(sessionId, deps.clock.now());
}

export async function signOutAll(deps: Deps, userId: string): Promise<number> {
  return deps.store.revokeUserSessions(userId, deps.clock.now());
}

function normalizeDisplayName(raw: string | undefined, email: string | null): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length >= 1 && trimmed.length <= 80) return trimmed;
  if (email) {
    const local = email.split("@")[0]?.trim();
    if (local && local.length <= 80) return local;
  }
  return "사용자";
}
