import test from "node:test";
import assert from "node:assert/strict";
import { validateAll } from "../validate-contracts.mjs";

test("모든 계약이 유효하다", async () => {
  const result = await validateAll();
  assert.deepEqual(result.errors, [], `계약 오류:\n${result.errors.join("\n")}`);
  assert.equal(result.ok, true);
});

test("스키마·예제 커버리지가 유지된다", async () => {
  const { stats } = await validateAll();
  assert.equal(stats.schemas, 15, "공통+도메인 스키마 수가 바뀌면 이 테스트를 갱신하세요.");
  assert.ok(stats.valid >= stats.schemas, "스키마마다 valid 예제가 1개 이상 필요합니다.");
  assert.ok(stats.invalid >= 1, "negative 테스트가 최소 1개 필요합니다.");
  assert.equal(stats.openapi, true);
});
