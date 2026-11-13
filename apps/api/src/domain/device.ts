import type { ActionItemStatus, Device } from "./types.ts";

/** 연결 상태는 저장하지 않고 last_seen_at + TTL 로 파생한다. */
export const DEVICE_ONLINE_TTL_MS = 2 * 60 * 1000;

export function isDeviceOnline(lastSeenAt: Date | null, now: Date = new Date(), ttlMs = DEVICE_ONLINE_TTL_MS): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - lastSeenAt.getTime() <= ttlMs;
}

export function deviceLifecycleTransitions(
  from: Device["lifecycleStatus"],
  to: Device["lifecycleStatus"],
): boolean {
  if (from === to) return true;
  if (from === "provisioned") return to === "active" || to === "retired";
  if (from === "active") return to === "retired";
  return to === "active"; // retired → active (재등록)
}

const ACTION_ITEM_TRANSITIONS: Record<ActionItemStatus, ActionItemStatus[]> = {
  open: ["done", "dismissed"],
  done: ["open"],
  dismissed: ["open"],
};

export function canTransitionActionItem(from: ActionItemStatus, to: ActionItemStatus): boolean {
  return from === to || ACTION_ITEM_TRANSITIONS[from].includes(to);
}
