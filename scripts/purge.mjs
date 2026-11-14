#!/usr/bin/env node
/**
 * 보존 정책 실행 (W-25, ADR-0011).
 *
 * 1) 분석 종료 후 30일 지난 원본 음성 purge
 * 2) 삭제 요청 후 30일 지난 계정 하드 삭제
 *
 * 사용:
 *   DATABASE_URL=... GYEOL_STORE=postgres GYEOL_STORAGE=local npm run purge
 *   GYEOL_PURGE_LIMIT=500 npm run purge
 */
import { createStorageFromEnv, createStoreFromEnv } from "../apps/api/src/http/server.ts";
import { FakeAiPipeline } from "../apps/api/src/adapters/ai/fake-pipeline.ts";
import { defaultDeps } from "../apps/api/src/usecases/deps.ts";
import {
  purgeDeletedAccounts,
  purgeExpiredRecordings,
} from "../apps/api/src/usecases/privacy.ts";

const limit = Number(process.env.GYEOL_PURGE_LIMIT ?? 200);
const storageDir = process.env.GYEOL_STORAGE_DIR ?? ".artifacts/storage";

const store = createStoreFromEnv();
if (store.kind !== "postgres") {
  console.error("✗ purge 는 GYEOL_STORE=postgres 에서만 실행합니다.");
  process.exit(1);
}

const deps = defaultDeps({
  store,
  storage: createStorageFromEnv(storageDir),
  ai: new FakeAiPipeline(),
});

try {
  const recordings = await purgeExpiredRecordings(deps, deps.clock.now(), limit);
  console.log(`원본 purge: ${recordings.purged}건 (실패 ${recordings.failed})`);

  const accounts = await purgeDeletedAccounts(deps, deps.clock.now(), 50);
  console.log(`계정 purge: ${accounts.purged}건 (실패 ${accounts.failed})`);

  if (recordings.failed > 0 || accounts.failed > 0) process.exitCode = 1;
} finally {
  await store.close?.();
}
