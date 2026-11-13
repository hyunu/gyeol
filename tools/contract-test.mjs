#!/usr/bin/env node
/**
 * 블랙박스 계약 테스트 하네스.
 *
 * 특정 언어/프레임워크에 종속되지 않는다. 실행 중인 서버의 baseUrl 만 받아서
 * OpenAPI 에 정의된 GET 오퍼레이션을 호출하고 응답을 스키마로 검증한다.
 *
 * 제외하려면 오퍼레이션에 `x-gyeol-skip-contract-test: true` 를 둔다.
 * (인증/경로 파라미터가 필요한 엔드포인트는 시나리오를 별도로 작성한다.)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OPENAPI_FILE = path.join(ROOT, "contracts", "openapi", "openapi.yaml");

export async function loadContract(file = OPENAPI_FILE) {
  return SwaggerParser.dereference(file);
}

function makeValidator(schema) {
  const clone = JSON.parse(JSON.stringify(schema));
  delete clone.$id; // 동일 스키마가 여러 응답에 인라인되어도 충돌하지 않게
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(clone);
}

/** GET 오퍼레이션을 순회하며 응답을 검증한다. 실패 목록을 돌려준다. */
export async function runContractTests(baseUrl, { contract } = {}) {
  const api = contract ?? (await loadContract());
  const tested = [];
  const failures = [];

  for (const [rawPath, item] of Object.entries(api.paths ?? {})) {
    const op = item.get;
    if (!op) continue;

    const name = op.operationId ?? rawPath;
    if (op["x-gyeol-skip-contract-test"] || rawPath.includes("{")) {
      // 경로 파라미터가 필요한 오퍼레이션은 시나리오 테스트에서 검증한다.
      tested.push({ name, skipped: true });
      continue;
    }

    const url = new URL(rawPath, baseUrl).toString();
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          // 로컬 전용 임시 인증 (ADR-0003). 운영 환경에는 이 하네스를 쓰지 않는다.
          "x-user-id": process.env.GYEOL_USER_ID ?? "0199aaaa-0000-7000-8000-000000000001",
        },
      });
    } catch (err) {
      failures.push(`${name}: 요청 실패 — ${err.message}`);
      continue;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      failures.push(`${name}: content-type 이 application/json 이 아닙니다 — "${contentType}"`);
    }

    const statusKey = String(res.status);
    const responseSpec = op.responses?.[statusKey];
    if (!responseSpec) {
      failures.push(`${name}: 계약에 없는 상태 코드 ${res.status}`);
      continue;
    }
    if (res.status >= 400) {
      failures.push(`${name}: 기대하지 않은 오류 응답 ${res.status}`);
      continue;
    }

    const schema = responseSpec.content?.["application/json"]?.schema;
    if (!schema) {
      failures.push(`${name}: ${statusKey} 응답에 JSON 스키마가 없습니다`);
      continue;
    }

    let body;
    try {
      body = await res.json();
    } catch {
      failures.push(`${name}: JSON 본문 파싱 실패`);
      continue;
    }

    const validate = makeValidator(schema);
    if (!validate(body)) {
      failures.push(`${name}: 응답이 스키마를 위반했습니다 — ${JSON.stringify(validate.errors)}`);
      continue;
    }

    if (!res.headers.get("cache-control")?.includes("no-store") && rawPath === "/healthz") {
      failures.push(`${name}: 상태 응답에 Cache-Control: no-store 가 없습니다`);
    }

    tested.push({ name, status: res.status });
  }

  return { ok: failures.length === 0, tested, failures };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const baseUrl = process.argv[2] ?? process.env.BASE_URL ?? "http://127.0.0.1:8080";
  const result = await runContractTests(baseUrl);
  for (const t of result.tested) console.log(`  ${t.skipped ? "–" : "✔"} ${t.name}${t.status ? ` (${t.status})` : ""}`);
  if (!result.ok) {
    console.error(`계약 테스트 실패 ${result.failures.length}건`);
    for (const f of result.failures) console.error(`  ✗ ${f}`);
  } else {
    console.log(`계약 테스트 통과 (${result.tested.length}개 오퍼레이션)`);
  }
  process.exit(result.ok ? 0 : 1);
}
