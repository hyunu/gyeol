import { randomBytes } from "node:crypto";

/** UUIDv7 (시간순 정렬 가능). 외부 의존 없이 생성한다. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b[0] = Math.floor(now / 2 ** 40) & 0xff;
  b[1] = Math.floor(now / 2 ** 32) & 0xff;
  b[2] = Math.floor(now / 2 ** 24) & 0xff;
  b[3] = Math.floor(now / 2 ** 16) & 0xff;
  b[4] = Math.floor(now / 2 ** 8) & 0xff;
  b[5] = now & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw invalid(field, "UUID 형식이 아닙니다.");
  return value;
}

export function invalid(field: string, message: string): Error {
  const err = new Error(message) as Error & { code: string; status: number; field: string };
  err.code = "VALIDATION_FAILED";
  err.status = 422;
  err.field = field;
  return err;
}
