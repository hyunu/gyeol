import { conflict, notFound, validationFailed } from "../domain/errors.ts";
import { uuidv7 } from "../domain/ids.ts";
import { deviceLifecycleTransitions, isDeviceOnline } from "../domain/device.ts";
import type { Device } from "../domain/types.ts";
import type { Deps } from "./deps.ts";

export interface RegisterDeviceInput {
  serialNo: string;
  model: string;
  hardwareRevision?: string;
  firmwareVersion?: string;
}

export async function registerDevice(deps: Deps, userId: string, input: RegisterDeviceInput): Promise<Device> {
  if (!input.serialNo?.trim()) throw validationFailed("serialNo 는 필수입니다.");
  if (!input.model?.trim()) throw validationFailed("model 은 필수입니다.");

  const existing = await deps.store.findDeviceBySerial(input.serialNo);
  if (existing) {
    if (existing.userId && existing.userId !== userId) {
      throw conflict("DEVICE_ALREADY_CLAIMED", "다른 사용자가 등록한 기기입니다.");
    }
    const now = deps.clock.now();
    const updated: Device = {
      ...existing,
      userId: existing.userId ?? userId,
      model: input.model,
      hardwareRevision: input.hardwareRevision ?? existing.hardwareRevision,
      firmwareVersion: input.firmwareVersion ?? existing.firmwareVersion,
      lifecycleStatus: existing.lifecycleStatus === "provisioned" ? "active" : existing.lifecycleStatus,
      lastSeenAt: now,
      updatedAt: now,
    };
    return deps.store.updateDevice(updated);
  }

  const now = deps.clock.now();
  const device: Device = {
    id: uuidv7(),
    userId,
    serialNo: input.serialNo,
    model: input.model,
    hardwareRevision: input.hardwareRevision ?? null,
    firmwareVersion: input.firmwareVersion ?? null,
    lifecycleStatus: "active",
    lastSeenAt: now,
    batteryPct: null,
    storageFreeBytes: null,
    config: {},
    createdAt: now,
    updatedAt: now,
  };
  return deps.store.createDevice(device);
}

export async function getDevice(deps: Deps, userId: string, deviceId: string): Promise<Device> {
  const device = await deps.store.findDevice(deviceId);
  if (!device || device.userId !== userId) throw notFound("기기");
  return device;
}

export async function listDevices(deps: Deps, userId: string, page: number, size: number) {
  return deps.store.listDevices(userId, page, size);
}

export function deviceOnline(device: Device, now: Date): boolean {
  return isDeviceOnline(device.lastSeenAt, now);
}

export function assertLifecycleTransition(device: Device, next: Device["lifecycleStatus"]): void {
  if (!deviceLifecycleTransitions(device.lifecycleStatus, next)) {
    throw conflict(
      "INVALID_DEVICE_TRANSITION",
      "허용되지 않은 기기 상태 전이입니다.",
      `${device.lifecycleStatus} → ${next}`,
    );
  }
}
