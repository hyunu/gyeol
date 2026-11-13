import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../apps/api/src/http/server.ts";
import { PostgresStore } from "../../apps/api/src/adapters/postgres/store.ts";
import { LocalDiskStorage } from "../../apps/api/src/adapters/storage/local-disk.ts";
import { FakeAiPipeline } from "../../apps/api/src/adapters/ai/fake-pipeline.ts";
import { defaultDeps } from "../../apps/api/src/usecases/deps.ts";
import { runContractTests } from "../../tools/contract-test.mjs";

/** GYEOL_STORE=postgres 로 띄운 API 가 계약과 health 를 만족하는지 확인한다. */

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL 이 필요합니다.");

test("PostgreSQL 저장소로 띄운 API: health db=ok, 계약 테스트 통과", async () => {
  const store = new PostgresStore({ connectionString: url });
  const storageDir = await mkdtemp(path.join(tmpdir(), "gyeol-db-"));
  const deps = defaultDeps({
    store,
    storage: new LocalDiskStorage(storageDir),
    ai: new FakeAiPipeline(),
  });

  const server = createApp({ deps, storageDir, env: "local" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("listen 실패");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    const body: any = await health.json();
    assert.equal(body.status, "ok");
    const db = body.checks.find((check: any) => check.name === "db");
    assert.equal(db.status, "ok", "실제 SELECT 1 이 성공해야 ok");
    assert.equal(db.detail, "postgres");
    assert.equal(typeof db.latencyMs, "number");

    const contract = await runContractTests(baseUrl);
    assert.deepEqual(contract.failures, [], `계약 위반:\n${contract.failures.join("\n")}`);
    assert.ok(contract.tested.filter((t: any) => !t.skipped).length >= 5);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});
