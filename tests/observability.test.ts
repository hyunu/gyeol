import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../apps/api/src/http/server.ts";
import { MemoryStore } from "../apps/api/src/adapters/memory/store.ts";
import { LocalDiskStorage } from "../apps/api/src/adapters/storage/local-disk.ts";
import { FakeAiPipeline } from "../apps/api/src/adapters/ai/fake-pipeline.ts";
import { defaultDeps } from "../apps/api/src/usecases/deps.ts";
import type { LogEntry } from "../apps/api/src/observability.ts";

const USER = "0199aaaa-0000-7000-8000-000000000001";

test("요청 로그·traceId·Prometheus 메트릭·storage health", async () => {
  const storageDir = await mkdtemp(path.join(tmpdir(), "gyeol-obs-"));
  const logs: LogEntry[] = [];
  const deps = defaultDeps({
    store: new MemoryStore(),
    storage: new LocalDiskStorage(storageDir),
    ai: new FakeAiPipeline(),
  });
  const server = createApp({
    deps,
    storageDir,
    env: "local",
    worker: { enabled: false },
    logger: {
      info: (entry) => logs.push(entry),
      error: (entry) => logs.push(entry),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("listen 실패");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/healthz`, {
      headers: { "x-request-id": "trace-obs-1" },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-trace-id"), "trace-obs-1");

    const body: any = await health.json();
    const storage = body.checks.find((check: any) => check.name === "storage");
    assert.equal(storage.status, "ok");
    assert.equal(storage.detail, "local");
    assert.equal(typeof storage.latencyMs, "number");

    const list = await fetch(`${baseUrl}/api/v1/conversations?q=${encodeURIComponent("비밀검색어")}`, {
      headers: { "x-user-id": USER, "x-request-id": "trace-obs-2" },
    });
    assert.equal(list.status, 200);

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    assert.equal(metricsRes.status, 200);
    assert.match(metricsRes.headers.get("content-type") ?? "", /text\/plain/);
    const metrics = await metricsRes.text();
    assert.match(metrics, /gyeol_http_requests_total\{method="GET",status="200"\} \d+/);
    assert.match(metrics, /gyeol_http_request_duration_ms_count \d+/);
    assert.match(metrics, /gyeol_process_uptime_seconds \d+/);

    const requestLogs = logs.filter((entry) => entry.msg === "http_request");
    assert.ok(requestLogs.length >= 3);

    const searchLog = requestLogs.find((entry) => entry.traceId === "trace-obs-2");
    assert.ok(searchLog);
    assert.equal(searchLog.path, "/api/v1/conversations", "쿼리 문자열은 로그에 남기지 않는다");
    assert.equal(searchLog.userId, USER);
    assert.equal(searchLog.status, 200);
    assert.equal(typeof searchLog.durationMs, "number");
    assert.equal(searchLog.query, undefined);

    const healthLog = requestLogs.find((entry) => entry.traceId === "trace-obs-1");
    assert.ok(healthLog);
    assert.equal(healthLog.method, "GET");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(storageDir, { recursive: true, force: true });
  }
});
