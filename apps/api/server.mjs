#!/usr/bin/env node
/**
 * GYEOL API — 워킹 스켈레톤 (Phase 2a)
 *
 * 의도적으로 프레임워크를 쓰지 않는다. 지금 단계의 목적은 기능이 아니라
 * "계약 ↔ 구현" 왕복 검증이다. 스택이 확정되면 이 파일은 교체 가능하다.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const CONTRACT_VERSION = "0.1.0";

const PROBLEMS = {
  NOT_FOUND: { type: "/problems/not-found", title: "요청한 경로를 찾을 수 없습니다", status: 404 },
  METHOD_NOT_ALLOWED: { type: "/problems/method-not-allowed", title: "허용되지 않은 메서드입니다", status: 405 },
};

function send(res, status, body, { traceId, problem = false } = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": problem ? "application/problem+json; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...(traceId ? { "X-Trace-Id": traceId } : {}),
  });
  res.end(payload);
}

function problem(code, traceId, instance, extra = {}) {
  const p = PROBLEMS[code] ?? { type: "/problems/internal", title: "내부 오류", status: 500 };
  return {
    type: p.type,
    title: p.title,
    status: p.status,
    code,
    instance,
    traceId,
    retryable: false,
    ...extra,
  };
}

/** 상태 검사 항목. 실물 하드웨어는 연결 전까지 skipped 로만 노출한다(HW-PENDING). */
function healthChecks() {
  return [
    { name: "contracts", status: "ok", detail: CONTRACT_VERSION },
    { name: "device-link", status: "skipped", detail: "실물 하드웨어 미연결 (HW-PENDING)" },
  ];
}

export function createApp({ version = CONTRACT_VERSION, clock = () => new Date() } = {}) {
  const routes = {
    "/healthz": {
      GET: (req, res, traceId) => {
        send(res, 200, {
          status: "ok",
          version,
          time: clock().toISOString(),
          checks: healthChecks(),
        }, { traceId });
      },
    },
    "/api/v1/info": {
      GET: (req, res, traceId) => {
        send(res, 200, {
          name: "gyeol",
          apiVersion: "v1",
          contractVersion: CONTRACT_VERSION,
          provisional: true,
          capabilities: ["health", "info"],
        }, { traceId });
      },
    },
  };

  return http.createServer((req, res) => {
    const traceId = req.headers["x-request-id"] ?? randomUUID();
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes[url.pathname];

    if (!route) {
      return send(res, 404, problem("NOT_FOUND", traceId, url.pathname), { traceId, problem: true });
    }
    const handler = route[req.method ?? "GET"];
    if (!handler) {
      const body = problem("METHOD_NOT_ALLOWED", traceId, url.pathname, {
        detail: `허용 메서드: ${Object.keys(route).join(", ")}`,
      });
      res.setHeader("Allow", Object.keys(route).join(", "));
      return send(res, 405, body, { traceId, problem: true });
    }
    handler(req, res, traceId);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "127.0.0.1";
  createApp().listen(port, host, () => {
    console.log(`GYEOL API http://${host}:${port} (contract ${CONTRACT_VERSION}, provisional)`);
  });
}
