import { badRequest, validationFailed } from "../domain/errors.ts";
import { isUuid } from "../domain/ids.ts";

export type Body = Record<string, unknown>;

export function requireObject(value: unknown): Body {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("JSON 객체 본문이 필요합니다.");
  }
  return value as Body;
}

export function assertNoUnknownKeys(body: Body, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw validationFailed(`알 수 없는 필드: ${unknown.join(", ")}`);
  }
}

export function readString(
  body: Body,
  key: string,
  options: { required?: boolean; min?: number; max?: number } = {},
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options.required) throw validationFailed(`${key} 는 필수입니다.`);
    return undefined;
  }
  if (typeof value !== "string") throw validationFailed(`${key} 는 문자열이어야 합니다.`);
  if (options.min !== undefined && value.length < options.min) {
    throw validationFailed(`${key} 는 ${options.min}자 이상이어야 합니다.`);
  }
  if (options.max !== undefined && value.length > options.max) {
    throw validationFailed(`${key} 는 ${options.max}자 이하여야 합니다.`);
  }
  return value;
}

export function readInt(
  body: Body,
  key: string,
  options: { required?: boolean; min?: number; max?: number } = {},
): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    if (options.required) throw validationFailed(`${key} 는 필수입니다.`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw validationFailed(`${key} 는 정수여야 합니다.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw validationFailed(`${key} 는 ${options.min} 이상이어야 합니다.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw validationFailed(`${key} 는 ${options.max} 이하여야 합니다.`);
  }
  return value;
}

export function readObject(body: Body, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw validationFailed(`${key} 는 객체여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

export function queryDate(url: URL, key: string): Date | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw validationFailed(`${key} 는 RFC 3339 시각이어야 합니다.`);
  return date;
}

export function queryUuid(url: URL, key: string): string | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) return undefined;
  if (!isUuid(raw)) throw validationFailed(`${key} 는 UUID 형식이어야 합니다.`);
  return raw;
}

export function queryInt(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw validationFailed(`${key} 는 정수여야 합니다.`);
  return value;
}

export function queryString(url: URL, key: string, max = 200): string | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  if (raw.length === 0) throw validationFailed(`${key} 는 비어 있을 수 없습니다.`);
  if (raw.length > max) throw validationFailed(`${key} 는 ${max}자 이하여야 합니다.`);
  return raw;
}
