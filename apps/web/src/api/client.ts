import type { components } from "./schema.ts";

/** OpenAPI 계약에서 생성한 타입. `npm run api:types` 로 갱신한다. */
export type ConversationSummary = components["schemas"]["conversation-summary"];
export type ConversationDetail = components["schemas"]["conversation-detail"];
export type Person = components["schemas"]["person"];
export type ActionItem = components["schemas"]["action-item"];

export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
  hasNext: boolean;
}

export interface AuthUser {
  id: string;
  displayName: string;
}

export interface AuthSession {
  token: string;
  tokenType: string;
  expiresAt: string;
  user: AuthUser;
}

type AuthMode = "session" | "demo";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api/v1";

/**
 * 로컬 임시 인증(ADR-0003). 실제 인증(D-01)이 확정되면 교체한다.
 * 주소창에 토큰을 남기지 않도록 localStorage 를 쓴다.
 */
const DEMO_USER_ID = "0199aaaa-0000-7000-8000-000000000001";
const AUTH_USER_KEY = "gyeol.authUser";
const AUTH_MODE_KEY = "gyeol.authMode";

export function currentUserId(): string {
  try {
    return localStorage.getItem("gyeol.userId") || DEMO_USER_ID;
  } catch {
    return DEMO_USER_ID;
  }
}

export function storedAuthUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as AuthUser;
    return value.id && value.displayName ? value : null;
  } catch {
    return null;
  }
}

export function currentAuthMode(): AuthMode | null {
  try {
    const stored = localStorage.getItem(AUTH_MODE_KEY);
    if (stored === "session" || stored === "demo") return stored;
  } catch {
    // localStorage 접근 불가 → Apple 설정 유무로 판단한다.
  }
  return import.meta.env.VITE_APPLE_CLIENT_ID ? null : "demo";
}

function storeAuth(user: AuthUser, mode: AuthMode): void {
  try {
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    localStorage.setItem(AUTH_MODE_KEY, mode);
  } catch {
    // 저장 실패는 로그인 자체를 막지 않는다(새로고침 시 다시 로그인).
  }
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(AUTH_USER_KEY);
    localStorage.removeItem(AUTH_MODE_KEY);
  } catch {
    // ignore
  }
}

/** Apple JS 로그인 성공 후 서버 세션(쿠키)을 만든다. */
export async function signInWithApple(
  identityToken: string,
  displayName?: string,
): Promise<AuthUser> {
  const body: Record<string, string> = { identityToken };
  if (displayName?.trim()) body.displayName = displayName.trim();
  const response = await request<{ session: AuthSession }>("/auth/apple", {
    method: "POST",
    body: JSON.stringify(body),
  });
  storeAuth(response.session.user, "session");
  return response.session.user;
}

/** 로컬 개발용 데모 사용자. `GYEOL_ENV=local` 서버에서만 동작한다. */
export function startLocalDemo(): AuthUser {
  const user = { id: currentUserId(), displayName: "로컬 데모" };
  storeAuth(user, "demo");
  return user;
}

export async function signOut(): Promise<void> {
  try {
    await request<void>("/auth/logout", { method: "POST" });
  } finally {
    clearAuth();
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "UNKNOWN") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface Problem {
  title?: string;
  detail?: string;
  code?: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const mode = currentAuthMode();
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(mode === "demo" ? { "x-user-id": currentUserId() } : {}),
    ...(method === "GET" || method === "HEAD" ? {} : { "x-gyeol-csrf": "1" }),
    ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    ...(init.headers as Record<string, string> | undefined),
  };

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "same-origin",
      headers,
    });
  } catch {
    throw new ApiError(0, "서버에 연결하지 못했습니다.");
  }

  if (response.status === 204) return undefined as T;

  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  const body = isJson ? await response.json() : undefined;

  if (!response.ok) {
    const problem = (body ?? {}) as Problem;
    throw new ApiError(
      response.status,
      problem.detail || problem.title || "요청을 처리하지 못했습니다.",
      problem.code,
    );
  }
  return body as T;
}

export async function listConversations(options: {
  q?: string;
  personId?: string;
  signal?: AbortSignal;
}): Promise<Page<ConversationSummary>> {
  const params = new URLSearchParams({ size: "50" });
  if (options.q?.trim()) params.set("q", options.q.trim());
  if (options.personId) params.set("personId", options.personId);
  return request<Page<ConversationSummary>>(`/conversations?${params.toString()}`, {
    signal: options.signal,
  });
}

export async function getConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationDetail> {
  return request<ConversationDetail>(`/conversations/${conversationId}`, { signal });
}

export async function listPersons(signal?: AbortSignal): Promise<Page<Person>> {
  return request<Page<Person>>("/persons?size=200", { signal });
}

export async function updateActionItem(
  actionItemId: string,
  status: ActionItem["status"],
): Promise<ActionItem> {
  return request<ActionItem>(`/action-items/${actionItemId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}
