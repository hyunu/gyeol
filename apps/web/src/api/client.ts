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

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api/v1";

/**
 * 로컬 임시 인증(ADR-0003). 실제 인증(D-01)이 확정되면 교체한다.
 * 주소창에 토큰을 남기지 않도록 localStorage 를 쓴다.
 */
const DEMO_USER_ID = "0199aaaa-0000-7000-8000-000000000001";

export function currentUserId(): string {
  try {
    return localStorage.getItem("gyeol.userId") || DEMO_USER_ID;
  } catch {
    return DEMO_USER_ID;
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
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "x-user-id": currentUserId(),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
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
