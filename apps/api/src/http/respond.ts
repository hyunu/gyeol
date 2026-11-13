import type { ServerResponse } from "node:http";
import { AppError, badRequest } from "../domain/errors.ts";

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  traceId: string,
  headers: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Trace-Id": traceId,
    ...headers,
  });
  res.end(payload);
}

export function sendEmpty(res: ServerResponse, status: number, traceId: string): void {
  res.writeHead(status, { "Cache-Control": "no-store", "X-Trace-Id": traceId });
  res.end();
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  traceId: string,
): void {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Trace-Id": traceId,
  });
  res.end(payload);
}

export function sendProblem(res: ServerResponse, err: unknown, traceId: string, instance: string): void {
  const appError =
    err instanceof AppError
      ? err
      : err instanceof Error && "status" in err && "code" in err
        ? new AppError(
            String((err as { code: unknown }).code),
            Number((err as { status: unknown }).status),
            err.message,
          )
        : new AppError("INTERNAL_ERROR", 500, "서버 내부 오류가 발생했습니다.");

  const body: Record<string, unknown> = {
    type: `/problems/${appError.code.toLowerCase().replaceAll("_", "-")}`,
    title: appError.message,
    status: appError.status,
    code: appError.code,
    instance,
    traceId,
    retryable: appError.retryable,
  };
  if (appError.detail) body.detail = appError.detail;

  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(appError.status, {
    "Content-Type": "application/problem+json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Trace-Id": traceId,
  });
  res.end(payload);
}

export async function readJsonBody(req: import("node:http").IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw badRequest(`요청 본문이 ${limit} 바이트를 초과했습니다.`);
    chunks.push(buf);
  }
  if (total === 0) throw badRequest("요청 본문이 비어 있습니다.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("JSON 본문을 해석할 수 없습니다.");
  }
}

export async function readBinaryBody(
  req: import("node:http").IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw badRequest(`청크가 ${limit} 바이트를 초과했습니다.`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
