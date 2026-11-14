import { unauthorized } from "../domain/errors.ts";
import { uuidv7 } from "../domain/ids.ts";
import type {
  AuditAction,
  ConversationDetail,
  Person,
  Recording,
  UserAccount,
} from "../domain/types.ts";
import type { Paged } from "../ports/store.ts";
import type { Deps } from "./deps.ts";

/**
 * 삭제·내보내기·감사 (W-25, ADR-0011).
 *
 * - 내보내기: 사용자 소유 데이터를 JSON 번들로 만든다(오디오 바이너리 제외).
 * - 계정 삭제 요청: 즉시 세션 폐기 + 30일 유예 후 하드 삭제.
 * - purge: 30일 지난 원본과 삭제된 계정을 정리한다.
 */

export const ACCOUNT_PURGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const RECORDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ExportBundle {
  exportedAt: Date;
  user: { id: string; displayName: string };
  persons: Person[];
  recordings: Recording[];
  conversations: ConversationDetail[];
}

export interface AccountDeletion {
  status: "pending_purge";
  requestedAt: Date;
  purgeAfter: Date;
}

export async function exportUserData(
  deps: Deps,
  userId: string,
  traceId: string | null,
): Promise<ExportBundle> {
  const account = await deps.store.findUserAccount(userId);
  if (!account || account.status !== "active") throw unauthorized("사용할 수 없는 계정입니다.");

  const persons = await collectAll((page, size) => deps.store.listPersons(userId, page, size));
  const recordings = await collectAll((page, size) =>
    deps.store.listRecordings({ userId, page, size }),
  );
  const conversations = await collectAll((page, size) =>
    deps.store.listConversations({ userId, page, size }),
  );

  const details: ConversationDetail[] = [];
  for (const item of conversations) {
    const detail = await deps.store.getConversationDetail(item.conversation.id);
    if (detail) details.push(detail);
  }

  const now = deps.clock.now();
  await audit(deps, {
    userId,
    action: "export",
    resourceType: "user",
    resourceId: userId,
    traceId,
    metadata: {
      persons: persons.length,
      recordings: recordings.length,
      conversations: details.length,
      includesAudio: false,
    },
    at: now,
  });

  return {
    exportedAt: now,
    user: { id: account.id, displayName: account.displayName },
    persons,
    recordings,
    conversations: details,
  };
}

export async function requestAccountDeletion(
  deps: Deps,
  userId: string,
  traceId: string | null,
): Promise<AccountDeletion> {
  const account = await deps.store.findUserAccount(userId);
  if (!account) throw unauthorized("사용할 수 없는 계정입니다.");

  const now = deps.clock.now();
  const purgeAfter = new Date(now.getTime() + ACCOUNT_PURGE_GRACE_MS);
  const alreadyRequested = account.status === "deleted" && account.deletedAt !== null;

  if (!alreadyRequested) {
    await deps.store.markUserDeleted(userId, now);
    await deps.store.revokeUserSessions(userId, now);
    await audit(deps, {
      userId,
      action: "account_delete_requested",
      resourceType: "user",
      resourceId: userId,
      traceId,
      metadata: { graceDays: 30, purgeAfter: purgeAfter.toISOString() },
      at: now,
    });
  }

  return {
    status: "pending_purge",
    requestedAt: account.deletedAt ?? now,
    purgeAfter: new Date((account.deletedAt ?? now).getTime() + ACCOUNT_PURGE_GRACE_MS),
  };
}

export async function purgeExpiredRecordings(
  deps: Deps,
  now: Date = deps.clock.now(),
  limit = 100,
): Promise<{ purged: number; failed: number }> {
  const cutoff = new Date(now.getTime() - RECORDING_RETENTION_MS);
  const candidates = await deps.store.findRecordingPurgeCandidates(cutoff, limit);
  let purged = 0;
  let failed = 0;

  for (const recording of candidates) {
    try {
      if (recording.storageKey) await deps.storage.delete(recording.storageKey);
      await deps.store.updateRecording({
        ...recording,
        status: "purged",
        storageKey: null,
        purgedAt: now,
        updatedAt: now,
      });
      const anchor = recording.analyzedAt ?? recording.clientAckAt ?? recording.createdAt;
      await audit(deps, {
        userId: recording.userId,
        action: "recording_purged",
        resourceType: "recording",
        resourceId: recording.id,
        traceId: null,
        metadata: {
          reason: "retention_30d",
          ageDays: Math.floor((now.getTime() - anchor.getTime()) / 86_400_000),
          byteSize: recording.byteSize,
        },
        at: now,
      });
      purged += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[purge] recording ${recording.id} 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { purged, failed };
}

export async function purgeDeletedAccounts(
  deps: Deps,
  now: Date = deps.clock.now(),
  limit = 20,
): Promise<{ purged: number; failed: number }> {
  const cutoff = new Date(now.getTime() - ACCOUNT_PURGE_GRACE_MS);
  const accounts = await deps.store.listUsersPendingPurge(cutoff, limit);
  let purged = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      const recordings = await collectAll((page, size) =>
        deps.store.listRecordings({ userId: account.id, page, size }),
      );
      for (const recording of recordings) {
        if (recording.storageKey) await deps.storage.delete(recording.storageKey);
      }
      await deps.store.purgeUser(account.id);
      await audit(deps, {
        userId: null,
        action: "account_purged",
        resourceType: "user",
        resourceId: account.id,
        traceId: null,
        metadata: {
          deletedUserId: account.id,
          recordings: recordings.length,
          requestedAt: account.deletedAt?.toISOString() ?? null,
        },
        at: now,
      });
      purged += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[purge] account ${account.id} 실패: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { purged, failed };
}

async function collectAll<T>(
  fetch: (page: number, size: number) => Promise<Paged<T>>,
  size = 200,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  while (true) {
    const result = await fetch(page, size);
    items.push(...result.items);
    if (items.length >= result.total || result.items.length === 0) break;
    page += 1;
    if (page > 100) break; // 안전 장치
  }
  return items;
}

async function audit(
  deps: Deps,
  input: {
    userId: string | null;
    action: AuditAction;
    resourceType: string;
    resourceId: string | null;
    traceId: string | null;
    metadata: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  await deps.store.createAuditEvent({
    id: uuidv7(input.at.getTime()),
    userId: input.userId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    traceId: input.traceId,
    metadata: input.metadata,
    createdAt: input.at,
  });
}

export async function recordRecordingPurge(
  deps: Deps,
  recording: Recording,
  traceId: string | null,
): Promise<void> {
  await audit(deps, {
    userId: recording.userId,
    action: "recording_purged",
    resourceType: "recording",
    resourceId: recording.id,
    traceId,
    metadata: { reason: "user_request", byteSize: recording.byteSize },
    at: deps.clock.now(),
  });
}

export function accountPurgeAfter(account: UserAccount): Date | null {
  return account.deletedAt
    ? new Date(account.deletedAt.getTime() + ACCOUNT_PURGE_GRACE_MS)
    : null;
}
