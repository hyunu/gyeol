import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../apps/api/server.mjs";
import { runContractTests } from "../contract-test.mjs";

async function withServer(fn) {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("실행 중인 API 가 OpenAPI 계약을 만족한다", async () => {
  const result = await withServer((baseUrl) => runContractTests(baseUrl));
  assert.deepEqual(result.failures, [], `계약 위반:\n${result.failures.join("\n")}`);
  assert.ok(result.tested.length >= 2, "최소 2개 오퍼레이션이 검증되어야 합니다.");
});

test("알 수 없는 경로는 problem+json 404 로 응답한다", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/없는경로`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/problem\+json/);
    const body = await res.json();
    assert.equal(body.code, "NOT_FOUND");
    assert.equal(body.status, 404);
    assert.ok(body.traceId, "traceId 가 있어야 합니다.");
  });
});

test("허용되지 않은 메서드는 405 와 Allow 헤더를 반환한다", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/healthz`, { method: "POST" });
    assert.equal(res.status, 405);
    assert.match(res.headers.get("allow") ?? "", /GET/);
    const body = await res.json();
    assert.equal(body.code, "METHOD_NOT_ALLOWED");
  });
});

test("상태 응답은 캐시되지 않고 하드웨어를 거짓 ok 로 보고하지 않는다", async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
    const body = await res.json();
    const device = body.checks.find((c) => c.name === "device-link");
    assert.equal(device.status, "skipped", "실물 검증 전에는 ok 가 아니라 skipped 여야 합니다.");
  });
});
