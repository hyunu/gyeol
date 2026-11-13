#!/usr/bin/env node
/**
 * 계약 검증기.
 *
 * 검사 항목
 *  1. contracts/schemas/**\/*.json 이 유효한 JSON Schema(2020-12)이며 $id 가 고유한가
 *  2. 모든 스키마에 최소 1개의 valid 예제가 있는가 (계약 커버리지)
 *  3. contracts/examples/<그룹>/valid/*.json 은 스키마를 통과하는가
 *  4. contracts/examples/<그룹>/invalid/*.json 은 스키마를 통과하지 않는가
 *  5. contracts/openapi/openapi.yaml 이 OpenAPI 로 유효하고 $ref 가 모두 해석되는가
 *
 * 사용: node tools/validate-contracts.mjs [--json]
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import SwaggerParser from "@apidevtools/swagger-parser";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = path.join(ROOT, "contracts", "schemas");
const EXAMPLE_DIR = path.join(ROOT, "contracts", "examples");
const OPENAPI_FILE = path.join(ROOT, "contracts", "openapi", "openapi.yaml");

async function walk(dir, filter) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, filter)));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function loadSchemas() {
  const files = await walk(SCHEMA_DIR, (n) => n.endsWith(".json"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  const byBasename = new Map();
  const problems = [];

  for (const file of files) {
    const schema = await readJson(file);
    if (!schema.$id) {
      problems.push(`${rel(file)}: $id 가 없습니다.`);
      continue;
    }
    if (ajv.getSchema(schema.$id)) {
      problems.push(`${rel(file)}: $id 중복 — ${schema.$id}`);
      continue;
    }
    try {
      ajv.addSchema(schema, schema.$id);
      byBasename.set(path.basename(file, ".json"), schema.$id);
    } catch (err) {
      problems.push(`${rel(file)}: 스키마 컴파일 실패 — ${err.message}`);
    }
  }
  return { ajv, byBasename, problems, files };
}

async function loadExamples() {
  const files = await walk(EXAMPLE_DIR, (n) => n.endsWith(".json"));
  const result = [];
  for (const file of files) {
    const relPath = path.relative(EXAMPLE_DIR, file).split(path.sep);
    // contracts/examples/<group>/(valid|invalid)/<name>.json
    if (relPath.length < 3) continue;
    const [group, kind, filename] = relPath;
    if (kind !== "valid" && kind !== "invalid") continue;
    result.push({ file, group, kind, name: path.basename(filename, ".json") });
  }
  return result;
}

function rel(file) {
  return path.relative(ROOT, file);
}

export async function validateAll() {
  const errors = [];
  const { ajv, byBasename, problems } = await loadSchemas();
  errors.push(...problems);

  const examples = await loadExamples();
  const validByName = new Map();

  for (const ex of examples) {
    const key = ex.name;
    const id = byBasename.get(key);
    if (!id) {
      errors.push(`${rel(ex.file)}: 대응하는 스키마를 찾을 수 없습니다 (${key}.json).`);
      continue;
    }
    const validate = ajv.getSchema(id);
    let doc;
    try {
      doc = await readJson(ex.file);
    } catch (err) {
      errors.push(`${rel(ex.file)}: JSON 파싱 실패 — ${err.message}`);
      continue;
    }
    const ok = validate(doc);
    if (ex.kind === "valid") {
      validByName.set(key, (validByName.get(key) ?? 0) + 1);
      if (!ok) {
        const detail = ajv.errorsText(validate.errors, { separator: " | " });
        errors.push(`${rel(ex.file)}: valid 예제가 스키마를 통과하지 못했습니다 — ${detail}`);
      }
    } else if (ok) {
      errors.push(`${rel(ex.file)}: invalid 예제가 스키마를 통과했습니다. 예제를 고치거나 스키마를 강화하세요.`);
    }
  }

  // 계약 커버리지: 스키마마다 valid 예제 최소 1개
  for (const [basename] of byBasename) {
    if (!validByName.has(basename)) {
      errors.push(`contracts/schemas: ${basename}.json 에 대한 valid 예제가 없습니다.`);
    }
  }

  // OpenAPI
  let openapiOk = false;
  try {
    await SwaggerParser.validate(OPENAPI_FILE);
    openapiOk = true;
  } catch (err) {
    errors.push(`contracts/openapi/openapi.yaml: ${err.message}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    stats: {
      schemas: byBasename.size,
      examples: examples.length,
      valid: examples.filter((e) => e.kind === "valid").length,
      invalid: examples.filter((e) => e.kind === "invalid").length,
      openapi: openapiOk,
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const json = process.argv.includes("--json");
  const result = await validateAll();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { schemas, examples, valid, invalid, openapi } = result.stats;
    console.log(
      `스키마 ${schemas} · 예제 ${examples}(valid ${valid}/invalid ${invalid}) · OpenAPI ${openapi ? "유효" : "무효"}`,
    );
    if (result.ok) console.log("계약 검증 통과");
    else for (const e of result.errors) console.error(`  ✗ ${e}`);
  }
  process.exit(result.ok ? 0 : 1);
}
