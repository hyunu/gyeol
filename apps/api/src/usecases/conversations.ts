import { conflict, notFound, validationFailed } from "../domain/errors.ts";
import { canTransitionActionItem } from "../domain/device.ts";
import type { ActionItemStatus, ConversationDetail } from "../domain/types.ts";
import type { ConversationListItem, Paged } from "../ports/store.ts";
import type { Deps } from "./deps.ts";

export async function getConversation(
  deps: Deps,
  userId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const detail = await deps.store.getConversationDetail(conversationId);
  if (!detail || detail.conversation.userId !== userId) throw notFound("대화");
  return detail;
}

export interface ConversationQuery {
  personId?: string;
  from?: Date;
  to?: Date;
  q?: string;
  page: number;
  size: number;
}

export async function listConversations(
  deps: Deps,
  userId: string,
  query: ConversationQuery,
): Promise<Paged<ConversationListItem>> {
  const queryVector = query.q ? await deps.ai.embedQuery(query.q) : undefined;
  return deps.store.listConversations({ userId, ...query, queryVector });
}

export async function listPersons(deps: Deps, userId: string, page: number, size: number) {
  return deps.store.listPersons(userId, page, size);
}

export async function updateActionItem(
  deps: Deps,
  userId: string,
  actionItemId: string,
  status: ActionItemStatus,
) {
  const item = await deps.store.findActionItem(actionItemId);
  if (!item) throw notFound("할 일");
  const conversation = await deps.store.findConversation(item.conversationId);
  if (!conversation || conversation.userId !== userId) throw notFound("할 일");

  if (!canTransitionActionItem(item.status, status)) {
    throw conflict(
      "INVALID_ACTION_ITEM_TRANSITION",
      "허용되지 않은 상태 전이입니다.",
      `${item.status} → ${status}`,
    );
  }
  if (item.status === status) return item;

  const now = deps.clock.now();
  const next = {
    ...item,
    status,
    updatedAt: now,
    completedAt: status === "done" ? now : null,
  };
  return deps.store.updateActionItem(next);
}

export function assertConversationQuery(query: ConversationQuery): void {
  if (query.q !== undefined && query.q.length > 200) {
    throw validationFailed("검색어는 200자를 넘을 수 없습니다.");
  }
  if (query.from && query.to && query.to.getTime() <= query.from.getTime()) {
    throw validationFailed("to 는 from 보다 뒤여야 합니다.");
  }
}
